import { NextResponse } from 'next/server';
import { query, execute } from '../../../../lib/db';

export const dynamic = 'force-dynamic';

// Sender enters the one-time code. We validate (exists, unused, unexpired,
// matches), then mark the intent AUTHORIZED. The code is immediately consumed
// and deleted (auto-delete after verification). Settlement happens in /api/execute
// (sim: server mints tx; live: Pollar signs client-side).
export async function POST(req) {
  try {
    const { intentId, code } = await req.json();
    const rows = await query(
      `SELECT * FROM tagly_codes WHERE intent_id = ? AND code = ? AND used = 0
         AND expires_at >= datetime('now') LIMIT 1`,
      [intentId, String(code || '').trim()]
    );
    if (!rows.length) {
      // check whether a code exists but is wrong/expired for a better message
      const any = await query('SELECT * FROM tagly_codes WHERE intent_id = ? LIMIT 1', [intentId]);
      const msg = any.length ? 'Invalid or expired code.' : 'No code requested. React ✅ first.';
      return NextResponse.json({ ok: false, error: msg }, { status: 401 });
    }
    // consume + delete the code (single use, auto-delete)
    await execute('DELETE FROM tagly_codes WHERE intent_id = ?', [intentId]);
    await execute("UPDATE tagly_intents SET status = 'authorized' WHERE id = ? AND status = 'pending'", [intentId]);
    const intent = (await query('SELECT * FROM tagly_intents WHERE id = ? LIMIT 1', [intentId]))[0];
    return NextResponse.json({ ok: true, intent });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
