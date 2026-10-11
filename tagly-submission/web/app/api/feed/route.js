import { NextResponse } from 'next/server';
import { query } from '../../../lib/db';

export const dynamic = 'force-dynamic';

// Web feed is scoped to the current author AND to web ('sim') activity only —
// so you see only your own posts, never other users or the Telegram/Discord bots.
export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const author = (searchParams.get('author') || '').toLowerCase();
    if (!author) return NextResponse.json({ ok: true, feed: [] });
    const posts = await query(
      "SELECT * FROM tagly_feed WHERE platform='sim' AND author_handle=? ORDER BY rowid DESC LIMIT 50",
      [author]
    );
    const intents = await query(
      "SELECT * FROM tagly_intents WHERE platform='sim' AND source_handle=? ORDER BY rowid DESC LIMIT 200",
      [author]
    );
    const feed = posts.map(p => ({
      ...p,
      intents: intents.filter(i => i.raw_command === p.text && i.source_handle === p.author_handle),
    }));
    return NextResponse.json({ ok: true, feed });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
