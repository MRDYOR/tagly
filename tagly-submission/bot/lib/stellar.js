// Real Stellar testnet layer for custodial Tagly wallets.
// Tagly runs its own testnet USDC issuer so USDC payments are genuinely on-chain
// and verifiable on stellar.expert. All ops are best-effort with clear errors.
const fs = require('fs');
const path = require('path');
const { Keypair, Horizon, TransactionBuilder, Operation, Asset, Networks, BASE_FEE } = require('@stellar/stellar-sdk');

const HORIZON = 'https://horizon-testnet.stellar.org';
const FRIENDBOT = 'https://friendbot.stellar.org';
const server = new Horizon.Server(HORIZON);
const ISSUER_FILE = path.join(__dirname, '..', '.tagly-issuer.json');
const FAUCET_USDC = '250'; // test USDC granted to each new wallet

let ISSUER = null; // { public, secret }
let USDC = null;

async function friendbotFund(pub) {
  const r = await fetch(`${FRIENDBOT}?addr=${encodeURIComponent(pub)}`);
  if (!r.ok && r.status !== 400) throw new Error(`friendbot ${r.status}`);
  return true;
}

// Serialize issuer-signed submissions to avoid tx_bad_seq under concurrent onboarding.
let issuerQueue = Promise.resolve();
function queueIssuer(fn) {
  const run = issuerQueue.then(fn, fn);
  issuerQueue = run.catch(() => {});
  return run;
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

// Create / load the Tagly USDC issuer (once).
async function initIssuer() {
  if (ISSUER) return ISSUER;
  if (fs.existsSync(ISSUER_FILE)) {
    ISSUER = JSON.parse(fs.readFileSync(ISSUER_FILE, 'utf8'));
  } else {
    const kp = Keypair.random();
    await friendbotFund(kp.publicKey());
    ISSUER = { public: kp.publicKey(), secret: kp.secret() };
    fs.writeFileSync(ISSUER_FILE, JSON.stringify(ISSUER, null, 2));
  }
  USDC = new Asset('USDC', ISSUER.public);
  return ISSUER;
}

function asset(code) {
  return code === 'XLM' ? Asset.native() : USDC;
}

// Provision a fresh custodial wallet: keypair -> friendbot XLM -> USDC trustline -> faucet mint.
async function createWallet() {
  await initIssuer();
  const kp = Keypair.random();
  const pub = kp.publicKey(), sec = kp.secret();
  await friendbotFund(pub);                        // XLM to exist + pay fees
  await submit(sec, b => b.addOperation(Operation.changeTrust({ asset: USDC })));  // trust USDC
  await queueIssuer(() => submit(ISSUER.secret, b => b.addOperation(Operation.payment({ destination: pub, asset: USDC, amount: FAUCET_USDC }))));  // faucet
  return { public: pub, secret: sec, funded: true, trustline: true };
}

// Ensure a wallet can receive USDC (trustline). XLM needs nothing.
async function ensureTrustline(secret) {
  await initIssuer();
  try {
    await submit(secret, b => b.addOperation(Operation.changeTrust({ asset: USDC })));
  } catch (e) { /* already trusts or benign */ }
}

// Testnet faucet — issuer mints test USDC into a wallet (serialized to avoid seq clashes).
async function faucet(toPublic, amount) {
  await initIssuer();
  return queueIssuer(() => submit(ISSUER.secret, b => b.addOperation(Operation.payment({ destination: toPublic, asset: USDC, amount: String(amount) }))));
}

async function sendPayment(fromSecret, toPublic, amount, code) {
  await initIssuer();
  const hash = await submit(fromSecret, b =>
    b.addOperation(Operation.payment({ destination: toPublic, asset: asset(code), amount: String(amount) })));
  return hash;
}

async function balances(pub) {
  await initIssuer();
  try {
    const acct = await server.loadAccount(pub);
    const out = { XLM: '0', USDC: '0' };
    for (const bal of acct.balances) {
      if (bal.asset_type === 'native') out.XLM = bal.balance;
      else if (bal.asset_code === 'USDC' && bal.asset_issuer === ISSUER.public) out.USDC = bal.balance;
    }
    return out;
  } catch (e) { return { XLM: '0', USDC: '0' }; }
}

function explorerTx(hash) { return `https://stellar.expert/explorer/testnet/tx/${hash}`; }
function explorerAcct(pub) { return `https://stellar.expert/explorer/testnet/account/${pub}`; }
function issuerPublic() { return ISSUER ? ISSUER.public : null; }

module.exports = { initIssuer, createWallet, ensureTrustline, sendPayment, faucet, balances, explorerTx, explorerAcct, issuerPublic, FAUCET_USDC };
