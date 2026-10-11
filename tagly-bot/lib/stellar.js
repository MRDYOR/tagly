// Real Stellar testnet layer for custodial Tagly wallets.
// USDC = the canonical Circle testnet issuer (the SAME asset Pollar uses), so bot
// USDC is fully interoperable with Pollar wallets, exchanges, and external addresses.
// We can't mint Circle USDC, so new wallets self-swap a slice of their friendbot XLM
// for USDC on the testnet DEX (path payment). No treasury / manual faucet needed.
const { Keypair, Horizon, TransactionBuilder, Operation, Asset, Networks, BASE_FEE } = require('@stellar/stellar-sdk');

const HORIZON = 'https://horizon-testnet.stellar.org';
const FRIENDBOT = 'https://friendbot.stellar.org';
const server = new Horizon.Server(HORIZON);
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'; // Circle testnet USDC
const USDC = new Asset('USDC', USDC_ISSUER);
const FAUCET_USDC = '100'; // real USDC granted per wallet (via DEX swap; keep modest for liquidity)

async function friendbotFund(pub) {
  const r = await fetch(`${FRIENDBOT}?addr=${encodeURIComponent(pub)}`);
  if (!r.ok && r.status !== 400) throw new Error(`friendbot ${r.status}`);
  return true;
}

async function submit(sourceSecret, buildOps) {
  const kp = Keypair.fromSecret(sourceSecret);
  const acct = await server.loadAccount(kp.publicKey());
  const b = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET });
  buildOps(b);
  const tx = b.setTimeout(90).build();
  tx.sign(kp);
  const res = await server.submitTransaction(tx);
  return res.hash;
}

function asset(code) { return code === 'XLM' ? Asset.native() : USDC; }

// Swap a wallet's own XLM for USDC on the DEX (real, interoperable USDC).
async function swapXlmForUsdc(secret, usdcAmount) {
  const sendMax = (Number(usdcAmount) * 2.5).toFixed(7); // generous slippage buffer
  const kp = Keypair.fromSecret(secret);
  return submit(secret, b => b.addOperation(Operation.pathPaymentStrictReceive({
    sendAsset: Asset.native(), sendMax, destination: kp.publicKey(),
    destAsset: USDC, destAmount: String(usdcAmount), path: [],
  })));
}

async function ensureTrustline(secret) {
  try { await submit(secret, b => b.addOperation(Operation.changeTrust({ asset: USDC }))); } catch (e) { /* already trusts */ }
}

// No own issuer to init anymore — USDC is Circle's. Kept for call-site compatibility.
async function initIssuer() { return { public: USDC_ISSUER }; }

// Instant: just a keypair (no network). The user "has" a wallet immediately.
function newWallet() {
  const kp = Keypair.random();
  return { public: kp.publicKey(), secret: kp.secret() };
}
// Slow (~14s): friendbot XLM -> USDC trustline -> DEX swap for real USDC. Run in the background.
async function fundWallet(secret) {
  const kp = Keypair.fromSecret(secret);
  await friendbotFund(kp.publicKey());
  await submit(secret, b => b.addOperation(Operation.changeTrust({ asset: USDC })));
  try { await swapXlmForUsdc(secret, FAUCET_USDC); } catch (e) { console.log('initial USDC swap failed:', e.message); }
  return true;
}
// Sync convenience (keypair + fund) — used by tests/tools, not the hot path.
async function createWallet() {
  const w = newWallet();
  await fundWallet(w.secret);
  return { ...w, funded: true, trustline: true };
}

// Faucet = swap the wallet's XLM for more real USDC (ensures trustline first, for old wallets).
async function faucet(secret, amount) {
  await ensureTrustline(secret);
  return swapXlmForUsdc(secret, amount);
}

async function sendPayment(fromSecret, toPublic, amount, code) {
  const hash = await submit(fromSecret, b =>
    b.addOperation(Operation.payment({ destination: toPublic, asset: asset(code), amount: String(amount) })));
  return hash;
}

async function balances(pub) {
  try {
    const acct = await server.loadAccount(pub);
    const out = { XLM: '0', USDC: '0' };
    for (const bal of acct.balances) {
      if (bal.asset_type === 'native') out.XLM = bal.balance;
      else if (bal.asset_code === 'USDC' && bal.asset_issuer === USDC_ISSUER) out.USDC = bal.balance;
    }
    return out;
  } catch (e) { return { XLM: '0', USDC: '0' }; }
}

function explorerTx(hash) { return `https://stellar.expert/explorer/testnet/tx/${hash}`; }
function explorerAcct(pub) { return `https://stellar.expert/explorer/testnet/account/${pub}`; }
function issuerPublic() { return USDC_ISSUER; }

module.exports = { initIssuer, newWallet, fundWallet, createWallet, ensureTrustline, sendPayment, faucet, swapXlmForUsdc, balances, explorerTx, explorerAcct, issuerPublic, USDC_ISSUER, FAUCET_USDC };
