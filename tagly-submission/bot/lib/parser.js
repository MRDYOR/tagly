// Tagly command parser (CommonJS, for the Telegram bot).
const ACTIONS = { send: 'send', pay: 'send', transfer: 'send', tip: 'tip', gift: 'tip', split: 'split', settle: 'split' };
const ASSET_ALIASES = { usd: 'USDC', dollar: 'USDC', dollars: 'USDC', usdc: 'USDC', xlm: 'XLM', lumen: 'XLM', lumens: 'XLM' };

function normalizeHandle(h) { return h.replace(/^@/, '').trim().toLowerCase(); }

function findAmount(text) {
  const m = text.match(/\$?\s*(\d+(?:\.\d+)?)/);
  return m ? m[1] : null;
}
function findAsset(text) {
  if (text.includes('$')) return 'USDC';
  const lower = text.toLowerCase();
  for (const [alias, code] of Object.entries(ASSET_ALIASES)) {
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
function findRecipients(text, botAliases) {
  const bots = (botAliases || []).map(b => b.replace(/^@/, '').toLowerCase());
  const handles = (text.match(/@[a-zA-Z0-9_]+/g) || [])
    .map(normalizeHandle)
    .filter(h => !bots.includes(h) && h !== 'tagly');
  return [...new Set(handles)];
}

// botAliases: array of names that mean "the bot" (e.g. ['tagly','TaglyPayBot'])
function parseCommand(rawText, sourceHandle, botAliases) {
  const text = (rawText || '').trim();
  const action = findAction(text);
  const asset = findAsset(text);
  const amount = findAmount(text);
  const recipients = findRecipients(text, botAliases).filter(h => h !== normalizeHandle(sourceHandle || ''));
  const meta = { action, asset, amount, recipients, rawText: text };

  if (!amount) return { ok: false, error: 'No amount found. Try: "@tagly send 5 USDC to @alice"', meta };
  if (recipients.length === 0) return { ok: false, error: 'Tag a recipient, e.g. @alice.', meta };
  const amt = parseFloat(amount);
  if (isNaN(amt) || amt <= 0) return { ok: false, error: 'Amount must be positive.', meta };

  let intents;
  if (action === 'split') {
    const perStr = (amt / recipients.length).toFixed(4).replace(/\.?0+$/, '');
    intents = recipients.map(dest => ({ action: 'split', amount: perStr, asset, dest }));
  } else {
    intents = recipients.map(dest => ({ action, amount: String(amt), asset, dest }));
  }
  return { ok: true, intents, meta };
}

// Does this message address the bot at all?
function addressesBot(text, botAliases) {
  const lower = (text || '').toLowerCase();
  return (botAliases || []).some(b => lower.includes('@' + b.replace(/^@/, '').toLowerCase()))
    || /\btagly\b/i.test(lower);
}

module.exports = { parseCommand, addressesBot, normalizeHandle };
