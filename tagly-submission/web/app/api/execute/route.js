import { NextResponse } from 'next/server';
import { query, execute } from '../../../lib/db';

export const dynamic = 'force-dynamic';

// Settlement — runs only AFTER the sender authorized via one-time code.
// Real mode: the browser runs Pollar runTx() and passes the resulting txHash.
// Simulated mode: no txHash provided -> we mint a simulated hash.
// Account abstraction: if the recipient hasn't onboarded (no real wallet yet),
// the payment is held as `claimable` and lands when they first log in.
export async function POST(req) {
  try {
    const { id, txHash, mode } = await req.json();
    const rows = await query('SELECT * FROM tagly_intents WHERE id = ? LIMIT 1', [id]);
    if (!rows.length) return NextResponse.json({ ok: false, error: 'Intent not found' }, { status: 404 });
    const intent = rows[0];

    if (intent.status === 'executed') return NextResponse.json({ ok: true, intent, already: true });
    if (intent.status === 'claimable') return NextResponse.json({ ok: true, intent, held: true });
    if (intent.status === 'pending') {
      return NextResponse.json({ ok: false, error: 'Not authorized — verify with a one-time code first.' }, { status: 403 });
    }
    if (intent.status === 'failed') return NextResponse.json({ ok: false, error: 'Intent previously failed' }, { status: 409 });

    // is the recipient onboarded (has a real, claimed wallet)?
    const destRows = await query(
      'SELECT onboarded FROM tagly_identities WHERE platform = ? AND handle = ? LIMIT 1',
      [intent.platform, intent.dest_handle]
    );
    const onboarded = destRows.length ? !!destRows[0].onboarded : false;

    const isSim = !txHash;
    const finalHash = txHash || ('SIMTX' + Math.random().toString(36).slice(2, 12).toUpperCase() + Math.random().toString(36).slice(2, 12).toUpperCase());

    if (!onboarded) {
      // hold for claim — recipient has no wallet yet (account abstraction)
      await execute(
        `UPDATE tagly_intents SET status = 'claimable', memo = COALESCE(memo, ?) WHERE id = ?`,
        [`Tagly ${intent.action} · awaiting @${intent.dest_handle}`, id]
      );
      const held = (await query('SELECT * FROM tagly_intents WHERE id = ? LIMIT 1', [id]))[0];
      return NextResponse.json({ ok: true, intent: held, claimable: true });
    }

    await execute(
      `UPDATE tagly_intents
         SET status = 'executed', tx_hash = ?, executed_at = datetime('now'), memo = COALESCE(memo, ?)
       WHERE id = ?`,
      [finalHash, `Tagly ${intent.action}`, id]
    );
    const updated = (await query('SELECT * FROM tagly_intents WHERE id = ? LIMIT 1', [id]))[0];
    return NextResponse.json({ ok: true, intent: updated, simulated: isSim, mode: mode || (isSim ? 'sim' : 'pollar') });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
