import { NextResponse } from 'next/server';
import { query } from '../../../lib/db';

export const dynamic = 'force-dynamic';

// History scoped to the current author (payments they sent or received), web-only.
export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const author = (searchParams.get('author') || '').toLowerCase();
    if (!author) return NextResponse.json({ ok: true, intents: [] });
    const rows = await query(
      "SELECT * FROM tagly_intents WHERE platform='sim' AND (source_handle=? OR dest_handle=?) ORDER BY created_at DESC, rowid DESC LIMIT 100",
      [author, author]
    );
    return NextResponse.json({ ok: true, intents: rows });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
