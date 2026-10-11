// Tagly command parser — turns a free-text social post into structured payment intent(s).
// Pure JS so it runs in Next.js route handlers (server-side).

const BOT_TAGS = ['@tagly', '@tagly_bot', '@taglypay'];
const ACTIONS = {
  send: 'send', pay: 'send', transfer: 'send',
  tip: 'tip', gift: 'tip',
  split: 'split', settle: 'split',
};
// Assets we recognize. Default USDC.
const ASSETS = ['USDC', 'XLM'];
const ASSET_ALIASES = { usd: 'USDC', dollar: 'USDC', dollars: 'USDC', '$': 'USDC', usdc: 'USDC', xlm: 'XLM', lumen: 'XLM', lumens: 'XLM' };

function normalizeHandle(h) {
  return h.replace(/^@/, '').trim().toLowerCase();
}

function findAmount(text) {
  // matches $5, 5, 5.25, 10USDC etc. Returns first standalone number.
  const m = text.match(/\$?\s*(\d+(?:\.\d+)?)/);
  return m ? m[1] : null;
}

function findAsset(text) {
  const lower = text.toLowerCase();
  if (text.includes('$')) return 'USDC';
  for (const [alias, code] of Object.entries(ASSET_ALIASES)) {
    if (alias === '$') continue;
    if (new RegExp(`\\b${alias}\\b`, 'i').test(lower)) return code;
  }
  return 'USDC';
}

function findAction(text) {
  const lower = text.toLowerCase();
  for (const [word, action] of Object.entries(ACTIONS)) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(lower)) return action;
  }
  return 'send';
}

function findRecipients(text) {
  // all @handles except the bot tags
  const handles = (text.match(/@[a-zA-Z0-9_]+/g) || [])
    .map(normalizeHandle)
    .filter(h => !BOT_TAGS.map(b => b.replace('@', '')).includes(h));
  // dedupe preserve order
  return [...new Set(handles)];
}

// Returns { ok, error?, intents: [{action, amount, asset, dest}], meta }
function parseCommand(rawText, sourceHandle) {
  const text = (rawText || '').trim();
  const mentionsBot = BOT_TAGS.some(b => text.toLowerCase().includes(b));

  const action = findAction(text);
  const asset = findAsset(text);
  const amount = findAmount(text);
  const recipients = findRecipients(text).filter(h => h !== normalizeHandle(sourceHandle || ''));

  const meta = { mentionsBot, action, asset, amount, recipients, rawText: text };

  if (!amount) return { ok: false, error: 'No amount found. Try: "@tagly send 5 USDC to @alice"', meta };
  if (recipients.length === 0) return { ok: false, error: 'No recipient found. Tag someone like @alice.', meta };

  const amt = parseFloat(amount);
  if (isNaN(amt) || amt <= 0) return { ok: false, error: 'Amount must be a positive number.', meta };

  let intents = [];
  if (action === 'split') {
    const per = (amt / recipients.length);
    // round to 4 decimals (Stellar assets support 7; keep it clean)
    const perStr = per.toFixed(4).replace(/\.?0+$/, '');
    intents = recipients.map(dest => ({ action: 'split', amount: perStr, asset, dest }));
  } else {
    intents = recipients.map(dest => ({ action, amount: String(amt), asset, dest }));
  }

  return { ok: true, intents, meta };
}

module.exports = { parseCommand, normalizeHandle, findRecipients };
