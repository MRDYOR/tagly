// Server-side DB access via the Emblem Dashboard API (CommonJS).
const API = process.env.DASHBOARD_BASE || `http://localhost:${process.env.DASHBOARD_PORT || 4000}`;
const TOKEN = process.env.DASHBOARD_TOKEN;
const GROUP = process.env.ARTIFACT_GROUP || 'tagly';

// fetch with a hard timeout so a stalled Dashboard API can never hang a handler.
async function fetchT(url, opts = {}, timeoutMs = 12000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(t); }
}

async function query(sql, params = []) {
  const url = `${API}/api/db/${GROUP}/database/query?sql=${encodeURIComponent(sql)}&params=${encodeURIComponent(JSON.stringify(params))}`;
  const r = await fetchT(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!r.ok) throw new Error(`DB query ${r.status}: ${await r.text()}`);
  return (await r.json()).rows || [];
}
async function execute(sql, params = []) {
  const r = await fetchT(`${API}/api/db/${GROUP}/database/execute`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  });
  if (!r.ok) throw new Error(`DB exec ${r.status}: ${await r.text()}`);
  return r.json();
}
function genId() { return 'itn_' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6); }
function genCode() { return String(Math.floor(100000 + Math.random() * 900000)); }

module.exports = { query, execute, genId, genCode, GROUP };
