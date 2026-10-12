// Tagly agent brain — natural-language → constrained payment plan via Groq (OpenAI-compatible).
// The LLM ONLY plans; it can never move money directly. Output is strictly validated
// server-side (handles must be from the provided list, amounts must be positive numbers).

// Resolve the Groq key from env OR the bot's .secrets.json (so it works as a
// published artifact without group-env injection — just add GROQ_API_KEY to secrets).
function readSecret(k) {
  try { return JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', '.secrets.json'), 'utf8'))[k]; }
  catch (e) { return null; }
}
const KEY = process.env['GROQ Key'] || process.env.GROQ_API_KEY || process.env.GROQ_KEY || readSecret('GROQ_API_KEY');
const MODEL = process.env.GROQ_MODEL || readSecret('GROQ_MODEL') || 'openai/gpt-oss-120b';
const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

function available() { return !!KEY; }

const SYSTEM = `You are Tagly's payment planner. Convert a user's message into a STRICT JSON payment plan.
Tagly moves USDC or SOL on Solana between social handles. It is NOT gambling — "pools", "tag of war",
"gifts", "splits" all just mean: distribute money among the given recipients by the amounts/ratios the user stated.

Recipients may be on DIFFERENT platforms. Supported: telegram (default), x (aka twitter), instagram, tiktok, discord, github, farcaster, threads.
- If the user says "on X", "x:", "twitter", "@handle on instagram", etc., set that recipient's "platform" accordingly and take the handle as written.
- Otherwise platform is "telegram" and the handle MUST be one of the provided Telegram handles.

Compute a concrete amount per recipient.

Rules:
- Equal split: divide the total equally.
- Ratio/percent (e.g. "70/30", "70% to A"): split the total by those shares.
- Simple send/tip: the stated amount goes to the (single) recipient.
- Round amounts to at most 4 decimals. Amounts are positive numbers as strings.
- asset is "USDC" (default) or "SOL".
- If the user sets a claim-link expiry ("expires in 24h", "valid for 3 days", "expire in 1 week"), include "expiresHours" as a number of hours. Otherwise omit it.
- If you cannot form a valid money plan, return {"ok": false, "reason": "..."}.

Return ONLY JSON of this exact shape:
{"ok": true, "asset": "USDC", "action": "send|tip|split|pool", "allocations": [{"handle": "alice", "platform": "telegram", "amount": "7"}], "expiresHours": 24, "summary": "short human summary"}`;

async function plan(text, recipients) {
  if (!KEY) return { ok: false, reason: 'no LLM key' };
  const handles = recipients.map(r => r.handle);
  const userMsg = `Message: """${text}"""\nProvided Telegram handles (use ONLY these for platform=telegram): ${JSON.stringify(handles)}\nFor other platforms, take the handle from the message text.`;
  const body = {
    model: MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: userMsg }],
  };
  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Groq ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  const content = data.choices?.[0]?.message?.content || '{}';
  let parsed;
  try { parsed = JSON.parse(content); } catch (e) { return { ok: false, reason: 'bad LLM json' }; }
  return validate(parsed, recipients);
}

// Strict server-side validation — never trust the LLM with money.
const PLATFORMS = new Set(['telegram', 'x', 'instagram', 'tiktok', 'discord', 'github', 'farcaster', 'threads']);
function validate(p, recipients) {
  if (!p || p.ok === false) return { ok: false, reason: (p && p.reason) || 'no plan' };
  const allowedTg = new Set(recipients.map(r => r.handle));
  const asset = p.asset === 'SOL' ? 'SOL' : 'USDC';
  const allocations = [];
  for (const a of (p.allocations || [])) {
    let platform = String(a.platform || 'telegram').toLowerCase();
    if (platform === 'twitter') platform = 'x';
    if (!PLATFORMS.has(platform)) platform = 'telegram';
    const handle = String(a.handle || '').replace(/^@/, '').toLowerCase().replace(/[^a-z0-9_.]/g, '');
    const amount = Number(a.amount);
    if (!handle) return { ok: false, reason: 'bad handle' };
    // telegram recipients must be entity-resolved (anti-spoof); other platforms taken as written
    if (platform === 'telegram' && !allowedTg.has(handle)) return { ok: false, reason: `@${handle} isn't a resolved Telegram recipient` };
    if (!(amount > 0) || !isFinite(amount)) return { ok: false, reason: 'invalid amount' };
    allocations.push({ handle, platform, amount: String(Number(amount.toFixed(4))) });
  }
  if (allocations.length === 0) return { ok: false, reason: 'no allocations' };
  const total = allocations.reduce((s, a) => s + Number(a.amount), 0);
  if (total > 100000) return { ok: false, reason: 'amount too large' };
  let expiresHours = Number(p.expiresHours);
  if (!(expiresHours > 0) || !isFinite(expiresHours)) expiresHours = null;
  else expiresHours = Math.min(expiresHours, 720); // cap 30 days
  return { ok: true, asset, action: p.action || 'send', allocations, expiresHours, summary: p.summary || '' };
}

module.exports = { plan, available, MODEL };
