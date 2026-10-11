import { NextResponse } from 'next/server';
import { query, execute, genCode } from '../../../../lib/db';

export const dynamic = 'force-dynamic';

// Sender reacts with the green check ✅ → Tagly issues a single-use code and
// (in production) DMs it via the Telegram bot. Here we also return it so the
// simulated "bot DM" panel can display it. Codes expire in ~3 min, single use.
export async function POST(req) {
  try {
    const { intentId } = await req.json();
    const rows = await query('SELECT * FROM tagly_intents WHERE id = ? LIMIT 1', [intentId]);
    if (!rows.length) return NextResponse.json({ ok: false, error: 'Intent not found' }, { status: 404 });
    const intent = rows[0];
    if (intent.status === 'executed' || intent.status === 'claimable') {
      return NextResponse.json({ ok: false, error: 'Already settled' }, { status: 409 });
    }

    // invalidate any prior unused codes for this intent (one live code at a time)
    await execute('DELETE FROM tagly_codes WHERE intent_id = ?', [intentId]);
    // purge globally-expired codes (auto-cleanup)
    await execute("DELETE FROM tagly_codes WHERE expires_at < datetime('now')", []);

    const code = genCode();
    await execute(
      `INSERT INTO tagly_codes (code, intent_id, channel, target_handle, expires_at)
       VALUES (?, ?, 'telegram', ?, datetime('now', '+3 minutes'))`,
      [code, intentId, intent.source_handle]
    );

    return NextResponse.json({
      ok: true,
      code,                       // in production this is delivered only via the TG bot DM
      channel: 'telegram',
      handle: intent.source_handle,
      expiresInSec: 180,
      botMessage: `🔐 Tagly verification\nAuthorize: send ${intent.amount} ${intent.asset_code} to @${intent.dest_handle}\nYour one-time code: ${code}\n(single use · expires in 3 min · do not share)`,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
