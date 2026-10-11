import { NextResponse } from 'next/server';
import { execute } from '../../../lib/db';

export const dynamic = 'force-dynamic';

// The web app records the Pollar email → wallet address on login, so the
// Telegram/Discord bots can resolve a wallet from just the email (no address paste).
export async function POST(req) {
  try {
    const { email, address, name } = await req.json();
    const e = String(email || '').toLowerCase().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return NextResponse.json({ ok: false, error: 'invalid email' }, { status: 400 });
    if (!/^G[A-Z2-7]{55}$/.test(address || '')) return NextResponse.json({ ok: false, error: 'invalid address' }, { status: 400 });
    await execute(
      `INSERT INTO tagly_pollar_links (email, address, name) VALUES (?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET address=excluded.address, name=excluded.name, updated_at=datetime('now')`,
      [e, address, name || null]
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
