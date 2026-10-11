// Server-side DB access via the Emblem Dashboard API. NEVER import this in client code.
const API = `http://localhost:${process.env.DASHBOARD_PORT || 4000}`;
const TOKEN = process.env.DASHBOARD_TOKEN;
const GROUP = process.env.ARTIFACT_GROUP || 'tagly';

export async function query(sql, params = []) {
  const url = `${API}/api/db/${GROUP}/database/query?sql=${encodeURIComponent(sql)}&params=${encodeURIComponent(JSON.stringify(params))}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` }, cache: 'no-store' });
  if (!r.ok) throw new Error(`DB query failed: ${r.status} ${await r.text()}`);
  const data = await r.json();
  return data.rows || [];
}

export async function execute(sql, params = []) {
  const r = await fetch(`${API}/api/db/${GROUP}/database/execute`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  });
  if (!r.ok) throw new Error(`DB execute failed: ${r.status} ${await r.text()}`);
  return r.json();
}

// Resolve a handle -> stored pollar address. Auto-provisions a deterministic
// demo (simulated) Stellar address if the handle isn't linked yet, so the demo
// always completes end-to-end. Real linked addresses always take precedence.
export async function resolveIdentity(platform, handle) {
  const rows = await query(
    'SELECT * FROM tagly_identities WHERE platform = ? AND handle = ? LIMIT 1',
    [platform, handle]
  );
  if (rows.length && rows[0].pollar_address) return rows[0];
  // Account abstraction: a handle that has never onboarded still gets a
  // deferred wallet (onboarded=0) so it can RECEIVE. A real Pollar wallet is
  // generated when they first log in; pending payments then auto-claim.
  const demoAddr = fakeStellarAddress(platform + ':' + handle);
  await execute(
    `INSERT INTO tagly_identities (platform, handle, pollar_address, display_name, verified, onboarded)
     VALUES (?, ?, ?, ?, 0, 0)
     ON CONFLICT(platform, handle) DO UPDATE SET pollar_address = COALESCE(tagly_identities.pollar_address, excluded.pollar_address)`,
    [platform, handle, demoAddr, handle]
  );
  const again = await query(
    'SELECT * FROM tagly_identities WHERE platform = ? AND handle = ? LIMIT 1',
    [platform, handle]
  );
  return again[0];
}

// Deterministic pseudo Stellar address for simulated recipients (xorshift for
// good character distribution — looks like a real G-address in the demo UI).
export function fakeStellarAddress(seed) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  let out = 'G';
  for (let i = 0; i < 55; i++) {
    h ^= h << 13; h >>>= 0; h ^= h >> 17; h ^= h << 5; h >>>= 0;
    out += alphabet[h % 32];
  }
  return out;
}

// 6-digit one-time code (single use, short-lived).
export function genCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export function genId() {
  // time-free unique-ish id (Date.now not always allowed in some sandboxes, but fine here)
  return 'itn_' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
}
