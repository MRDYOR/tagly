import { NextResponse } from 'next/server';
import { query, execute, fakeStellarAddress } from '../../../lib/db';

export const dynamic = 'force-dynamic';

// Account abstraction: a recipient logs in for the first time. Pollar generates
// a wallet for their handle; every payment that was `claimable` (held because
// they had no wallet) now settles automatically. Real address supersedes the
// deferred demo address if provided.
export async function POST(req) {
  try {
    const { platform = 'sim', handle, address } = await req.json();
    const h = String(handle || '').replace(/^@/, '').toLowerCase();
    if (!h) return NextResponse.json({ ok: false, error: 'handle required' }, { status: 400 });

    const wallet = address && /^G[A-Z0-9]{55}$/.test(address)
      ? address
      : fakeStellarAddress('onboard:' + platform + ':' + h);

    await execute(
      `INSERT INTO tagly_identities (platform, handle, pollar_address, display_name, verified, onboarded)
       VALUES (?, ?, ?, ?, ?, 1)
       ON CONFLICT(platform, handle) DO UPDATE SET
         pollar_address = excluded.pollar_address, onboarded = 1,
         verified = MAX(tagly_identities.verified, excluded.verified)`,
      [platform.toLowerCase(), h, wallet, h, address ? 1 : 0]
    );

    // settle everything that was waiting on this handle
    const held = await query(
      "SELECT * FROM tagly_intents WHERE platform = ? AND dest_handle = ? AND status = 'claimable'",
      [platform.toLowerCase(), h]
    );
    const claimed = [];
    for (const it of held) {
      const hash = 'SIMTX' + Math.random().toString(36).slice(2, 12).toUpperCase() + Math.random().toString(36).slice(2, 12).toUpperCase();
      await execute(
        `UPDATE tagly_intents SET status = 'executed', tx_hash = ?, dest_address = ?, executed_at = datetime('now') WHERE id = ?`,
        [hash, wallet, it.id]
      );
      claimed.push({ id: it.id, amount: it.amount, asset: it.asset_code, from: it.source_handle });
    }
    const total = claimed.reduce((s, c) => s + (c.asset === 'USDC' ? parseFloat(c.amount) : 0), 0);
    return NextResponse.json({ ok: true, handle: h, wallet, claimed, totalUsdc: total });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
