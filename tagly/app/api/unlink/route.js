import { NextResponse } from 'next/server';
import { execute } from '../../../lib/db';

export const dynamic = 'force-dynamic';

const ADDR = /^G[A-Z2-7]{55}$/;

// POST { platform:'telegram'|'discord'|'x', address, handle? }
// Detaches the account(s) from this Pollar wallet. Telegram/Discord: clears
// linked_pollar on the wallet row(s). X: clears the pollar_address on the
// verified identity. The account itself (and its Tagly wallet) is untouched.
export async function POST(req) {
  try {
    const { platform, address, handle } = await req.json();
    const addr = String(address || '').trim().toUpperCase();
    if (!ADDR.test(addr)) return NextResponse.json({ ok: false, error: 'Connect your Pollar wallet first.' });

    if (platform === 'telegram' || platform === 'discord') {
      if (handle) {
        await execute('UPDATE tagly_wallets SET linked_pollar=NULL WHERE platform=? AND handle=? AND linked_pollar=?', [platform, String(handle).toLowerCase(), addr]);
      } else {
        await execute('UPDATE tagly_wallets SET linked_pollar=NULL WHERE platform=? AND linked_pollar=?', [platform, addr]);
      }
      return NextResponse.json({ ok: true });
    }

    if (platform === 'x') {
      if (handle) {
        await execute("UPDATE tagly_identities SET pollar_address=NULL, verified=0 WHERE platform='x' AND handle=? AND pollar_address=?", [String(handle).toLowerCase(), addr]);
      } else {
        await execute("UPDATE tagly_identities SET pollar_address=NULL, verified=0 WHERE platform='x' AND pollar_address=?", [addr]);
      }
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ ok: false, error: 'Unknown platform.' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
