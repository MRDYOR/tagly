// Real Solana devnet layer for custodial Tagly wallets.
// Drop-in replacement for the old Stellar layer — SAME exported interface, so
// server.js is unchanged in logic (only user-facing copy differs).
//
// "USDC" = a Tagly-controlled SPL token (6 decimals, like real USDC). Tagly is the
// mint authority, so funding a wallet = minting real on-chain tokens to it. "SOL" is
// the native asset (fills the old "XLM" slot). Everything is on Solana devnet and
// fully verifiable on solscan.
//
// IMPORTANT: confirmations are done by HTTP polling (getSignatureStatuses), NOT the
// WebSocket subscription that sendAndConfirmTransaction uses — some devnet RPCs have
// flaky WS that makes confirms hang forever. Every op is also bounded by a timeout.
const fs = require('fs');
const path = require('path');
const {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  LAMPORTS_PER_SOL, clusterApiUrl,
} = require('@solana/web3.js');
const {
  createMint, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction,
  createMintToInstruction, createTransferInstruction,
} = require('@solana/spl-token');

// RPC resolution order: env var → persisted state file → public devnet.
function readStateRaw() { try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.tagly-solana.json'), 'utf8')); } catch (e) { return {}; } }
const RPC = process.env.SOLANA_RPC || readStateRaw().rpc || clusterApiUrl('devnet');
const CLUSTER = process.env.SOLANA_CLUSTER || 'devnet';
const connection = new Connection(RPC, { commitment: 'confirmed', confirmTransactionInitialTimeout: 45000 });

const DECIMALS = 6;
const FAUCET_USDC = '500';            // USDC minted per wallet
const FUND_SOL = 0.03;                // SOL seeded per wallet (fees + ATA rent)
const CONFIRM_MS = 40000;             // hard cap on how long we wait for a tx
const STATE_FILE = path.join(__dirname, '..', '.tagly-solana.json');

// ── persistent treasury (fee source + mint authority) + mint address ──
let state = null;
let treasury = null, mint = null;

function loadState() {
  if (state) return state;
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { state = {}; }
  if (state.treasurySecret) treasury = Keypair.fromSecretKey(Buffer.from(state.treasurySecret, 'base64'));
  if (state.mint) mint = new PublicKey(state.mint);
  return state;
}
function saveState() { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (kp) => Buffer.from(kp.secretKey).toString('base64');
const kpFromSecret = (s) => Keypair.fromSecretKey(Buffer.from(s, 'base64'));
const toBase = (amt) => BigInt(Math.round(Number(amt) * 10 ** DECIMALS));

// Confirm a signature by polling HTTP status (no WebSocket). Throws on tx error or timeout.
async function confirmSig(sig, timeoutMs = CONFIRM_MS) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await connection.getSignatureStatuses([sig]).catch(() => null);
    const st = r && r.value && r.value[0];
    if (st) {
      if (st.err) throw new Error('tx failed: ' + JSON.stringify(st.err));
      if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return sig;
    }
    await sleep(1200);
  }
  throw new Error('confirm timeout after ' + Math.round(timeoutMs / 1000) + 's');
}

// Build, sign, send, and poll-confirm a transaction. signers[0] is the fee payer.
async function sendIxs(instructions, signers, timeoutMs = CONFIRM_MS) {
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction();
  tx.recentBlockhash = blockhash;
  tx.feePayer = signers[0].publicKey;
  for (const ix of instructions) tx.add(ix);
  tx.sign(...signers);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 });
  await confirmSig(sig, timeoutMs);
  return sig;
}

async function ataExists(ata) {
  try { return !!(await connection.getAccountInfo(ata)); } catch (e) { return false; }
}

async function airdrop(pub, sol) {
  for (let i = 0; i < 4; i++) {
    try {
      const sig = await connection.requestAirdrop(pub, Math.round(sol * LAMPORTS_PER_SOL));
      await confirmSig(sig, 30000);
      return true;
    } catch (e) { await sleep(1500); }
  }
  return false;
}

// Ensure the treasury wallet + USDC mint exist. Idempotent & persisted.
async function initIssuer() {
  loadState();
  if (!treasury) { treasury = Keypair.generate(); state.treasurySecret = b64(treasury); saveState(); }
  const bal = await connection.getBalance(treasury.publicKey).catch(() => 0);
  if (bal < 0.3 * LAMPORTS_PER_SOL) await airdrop(treasury.publicKey, 2);
  if (!mint) {
    mint = await createMint(connection, treasury, treasury.publicKey, null, DECIMALS);
    state.mint = mint.toBase58(); saveState();
  }
  return { public: mint.toBase58() };
}

async function ensureReady() { if (!treasury || !mint) await initIssuer(); }

// Instant: just a keypair (no network). The user "has" a wallet immediately.
function newWallet() {
  const kp = Keypair.generate();
  return { public: kp.publicKey.toBase58(), secret: b64(kp) };
}

// Fund in ONE transaction (treasury-signed): seed SOL for fees + create the USDC
// token account + mint starter USDC. One confirmation = fast and reliable.
async function fundWallet(secret) {
  await ensureReady();
  const kp = kpFromSecret(secret);
  const ata = await getAssociatedTokenAddress(mint, kp.publicKey);
  const ixs = [SystemProgram.transfer({
    fromPubkey: treasury.publicKey, toPubkey: kp.publicKey,
    lamports: Math.round(FUND_SOL * LAMPORTS_PER_SOL),
  })];
  if (!(await ataExists(ata))) ixs.push(createAssociatedTokenAccountInstruction(treasury.publicKey, ata, kp.publicKey, mint));
  ixs.push(createMintToInstruction(mint, ata, treasury.publicKey, toBase(FAUCET_USDC)));
  await sendIxs(ixs, [treasury]);
  return true;
}

async function createWallet() {
  const w = newWallet();
  await fundWallet(w.secret);
  return { ...w, funded: true, trustline: true };
}

// Solana has no trustlines — this just ensures the wallet's USDC token account exists.
async function ensureTrustline(secret) {
  await ensureReady();
  const kp = kpFromSecret(secret);
  const ata = await getAssociatedTokenAddress(mint, kp.publicKey);
  if (!(await ataExists(ata))) {
    try { await sendIxs([createAssociatedTokenAccountInstruction(treasury.publicKey, ata, kp.publicKey, mint)], [treasury]); } catch (e) {}
  }
}

// "Top up USDC" / faucet — mint more USDC to the wallet (we own the mint).
async function swapXlmForUsdc(secret, usdcAmount) {
  await ensureReady();
  const kp = kpFromSecret(secret);
  const ata = await getAssociatedTokenAddress(mint, kp.publicKey);
  const ixs = [];
  if (!(await ataExists(ata))) ixs.push(createAssociatedTokenAccountInstruction(treasury.publicKey, ata, kp.publicKey, mint));
  ixs.push(createMintToInstruction(mint, ata, treasury.publicKey, toBase(usdcAmount)));
  return sendIxs(ixs, [treasury]);
}

async function faucet(secret, amount) { return swapXlmForUsdc(secret, amount); }

// Move USDC (SPL) or SOL (native) from one custodial wallet to any address.
async function sendPayment(fromSecret, toPublic, amount, code) {
  await ensureReady();
  const from = kpFromSecret(fromSecret);
  const to = new PublicKey(toPublic);
  if (code === 'SOL' || code === 'XLM') {
    return sendIxs([SystemProgram.transfer({
      fromPubkey: from.publicKey, toPubkey: to,
      lamports: Math.round(Number(amount) * LAMPORTS_PER_SOL),
    })], [from]);
  }
  // USDC: ensure the sender's + recipient's token accounts, then transfer. Sender pays.
  const fromAta = await getAssociatedTokenAddress(mint, from.publicKey);
  const toAta = await getAssociatedTokenAddress(mint, to);
  const ixs = [];
  if (!(await ataExists(toAta))) ixs.push(createAssociatedTokenAccountInstruction(from.publicKey, toAta, to, mint));
  ixs.push(createTransferInstruction(fromAta, toAta, from.publicKey, toBase(amount)));
  return sendIxs(ixs, [from]);
}

async function balances(pub) {
  const out = { USDC: '0', SOL: '0', XLM: '0' };
  try {
    const owner = new PublicKey(pub);
    const lamports = await connection.getBalance(owner).catch(() => 0);
    out.SOL = (lamports / LAMPORTS_PER_SOL).toString();
    out.XLM = out.SOL;
    if (!mint) loadState();
    if (mint) {
      const accs = await connection.getParsedTokenAccountsByOwner(owner, { mint }).catch(() => ({ value: [] }));
      let usdc = 0;
      for (const a of accs.value) usdc += Number(a.account.data.parsed.info.tokenAmount.uiAmount || 0);
      out.USDC = String(usdc);
    }
  } catch (e) {}
  return out;
}

function isValidAddress(addr) { try { new PublicKey(addr); return true; } catch (e) { return false; } }
function explorerTx(sig) { return `https://solscan.io/tx/${sig}?cluster=${CLUSTER}`; }
function explorerAcct(pub) { return `https://solscan.io/account/${pub}?cluster=${CLUSTER}`; }
function issuerPublic() { return mint ? mint.toBase58() : (loadState().mint || 'uninitialized'); }

module.exports = {
  initIssuer, newWallet, fundWallet, createWallet, ensureTrustline,
  sendPayment, faucet, swapXlmForUsdc, balances, isValidAddress,
  explorerTx, explorerAcct, issuerPublic,
  get USDC_ISSUER() { return issuerPublic(); },
  FAUCET_USDC, CLUSTER,
};
