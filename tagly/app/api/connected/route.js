import { NextResponse } from 'next/server';
import { query } from '../../../lib/db';

export const dynamic = 'force-dynamic';

// Given a Pollar wallet address (+ email), find the Telegram/Discord/X accounts
// linked to it (via the bots' /linkpollar, /linkemail, /verify).
export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const addr = searchParams.get('address') || '';
    const email = (searchParams.get('email') || '').toLowerCase();
    const out = { ok: true, email: null, telegram: [], discord: [], x: [] };

    if (/^G[A-Z2-7]{55}$/.test(addr)) {
      const linked = await query('SELECT platform, handle, tg_id FROM tagly_wallets WHERE linked_pollar=?', [addr]);
      for (const l of linked) {
        if (l.platform === 'telegram') out.telegram.push(l.handle);
        else if (l.platform === 'discord') out.discord.push(l.handle);
      }
      const el = await query('SELECT email FROM tagly_pollar_links WHERE address=? LIMIT 1', [addr]);
      if (el.length) out.email = el[0].email;
      // X handles verified directly from the web (linked by Pollar address)…
      const xdirect = await query("SELECT handle FROM tagly_identities WHERE platform='x' AND pollar_address=? AND verified=1", [addr]);
      const xset = new Set(xdirect.map(r => r.handle));
      // …plus any verified in the bots under a linked Telegram/Discord account.
      const tgids = linked.map(l => l.tg_id).filter(Boolean);
      if (tgids.length) {
        const rows = await query(
          `SELECT handle FROM tagly_identities WHERE platform='x' AND tg_id IN (${tgids.map(() => '?').join(',')})`,
          tgids
        );
        rows.forEach(r => xset.add(r.handle));
      }
      out.x = [...xset];
    }
    if (!out.email && email) out.email = email;
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message, telegram: [], discord: [], x: [] }, { status: 500 });
  }
}
