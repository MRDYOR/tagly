import { NextResponse } from 'next/server';
import { query, execute } from '../../../lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const rows = await query('SELECT * FROM tagly_identities ORDER BY rowid DESC LIMIT 100');
    return NextResponse.json({ ok: true, identities: rows });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}

// Link a social handle to a real Pollar/Stellar wallet address.
export async function POST(req) {
  try {
    const { platform = 'sim', handle, address, displayName } = await req.json();
    const h = String(handle || '').replace(/^@/, '').toLowerCase();
    if (!h) return NextResponse.json({ ok: false, error: 'handle required' }, { status: 400 });
    if (!address || !/^G[A-Z0-9]{55}$/.test(address)) {
      return NextResponse.json({ ok: false, error: 'valid Stellar G-address required' }, { status: 400 });
    }
    await execute(
      `INSERT INTO tagly_identities (platform, handle, pollar_address, display_name, verified)
       VALUES (?, ?, ?, ?, 1)
       ON CONFLICT(platform, handle) DO UPDATE SET
         pollar_address = excluded.pollar_address,
         display_name = excluded.display_name,
         verified = 1`,
      [platform.toLowerCase(), h, address, displayName || h]
    );
    const row = (await query('SELECT * FROM tagly_identities WHERE platform = ? AND handle = ?', [platform.toLowerCase(), h]))[0];
    return NextResponse.json({ ok: true, identity: row });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
