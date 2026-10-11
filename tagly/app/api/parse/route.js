import { NextResponse } from 'next/server';
import { parseCommand } from '../../../lib/parser';
import { query, execute, resolveIdentity, genId } from '../../../lib/db';

export const dynamic = 'force-dynamic';

export async function POST(req) {
  try {
    const body = await req.json();
    const platform = (body.platform || 'sim').toLowerCase();
    const author = (body.author || 'you').replace(/^@/, '').toLowerCase();
    const text = String(body.text || '').slice(0, 500);

    // record the raw social post in the feed
    const feedRes = await execute(
      'INSERT INTO tagly_feed (platform, author_handle, text) VALUES (?, ?, ?)',
      [platform, author, text]
    );

    const parsed = parseCommand(text, author);
    if (!parsed.ok) {
      return NextResponse.json({ ok: false, error: parsed.error, meta: parsed.meta });
    }

    // resolve sender wallet (source) + create an intent per recipient
    const source = await resolveIdentity(platform, author);
    const created = [];
    for (const intent of parsed.intents) {
      const dest = await resolveIdentity(platform, intent.dest);
      const id = genId();
      const idem = `${platform}:${author}:${intent.dest}:${intent.amount}:${intent.asset}:${feedRes.lastInsertRowid}`;
      // idempotency: skip duplicates from the same feed post
      const dup = await query('SELECT id FROM tagly_intents WHERE idempotency_key = ? LIMIT 1', [idem]);
      if (dup.length) { created.push({ id: dup[0].id, duplicate: true }); continue; }
      await execute(
        `INSERT INTO tagly_intents
          (id, platform, source_handle, source_address, dest_handle, dest_address, action, amount, asset_code, raw_command, memo, status, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        [id, platform, author, source.pollar_address, intent.dest, dest.pollar_address,
         intent.action, intent.amount, intent.asset, text, `Tagly ${intent.action} to @${intent.dest}`, idem]
      );
      created.push({ id, action: intent.action, amount: intent.amount, asset: intent.asset, dest: intent.dest, dest_verified: !!dest.verified });
    }

    return NextResponse.json({ ok: true, intents: created, meta: parsed.meta });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
