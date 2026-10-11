import { NextResponse } from 'next/server';
import { query, execute } from '../../../lib/db';

export const dynamic = 'force-dynamic';

const ADDR = /^G[A-Z2-7]{55}$/;

function parseTweetId(input) {
  const s = String(input || '').trim();
  const m = s.match(/status(?:es)?\/(\d{2,25})/) || s.match(/^(\d{15,25})$/);
  return m ? m[1] : null;
}

async function fetchTweet(id) {
  const token = (Number(id) % 1e6).toString(36);
  const url = `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${token}&lang=en`;
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' },
    cache: 'no-store',
  });
  if (!r.ok) throw new Error(`tweet fetch ${r.status}`);
  return r.json();
}

// POST { action:'code' } -> returns a one-time code + suggested tweet text.
// POST { action:'verify', handle, code, address, tweetUrl } -> checks the tweet
// came from @handle and contains the code, then links X -> Pollar wallet.
export async function POST(req) {
  try {
    const body = await req.json();
    const action = body.action;

    if (action === 'code') {
      const code = 'TG-' + String(Math.floor(100000 + Math.random() * 900000));
      const text = `Verifying my @X handle on Tagly 🟢 — tag anyone, pay them instantly in USDC.\n\nCode: ${code}\n\nvia @Taglypay_bot`;
      return NextResponse.json({ ok: true, code, text });
    }

    if (action === 'verify') {
      const handle = String(body.handle || '').replace(/^@/, '').toLowerCase().trim();
      const code = String(body.code || '').trim();
      const address = String(body.address || '').trim().toUpperCase();
      if (!handle) return NextResponse.json({ ok: false, error: 'Enter your X handle.' });
      if (!code) return NextResponse.json({ ok: false, error: 'Missing verification code — start over.' });
      if (!ADDR.test(address)) return NextResponse.json({ ok: false, error: 'Connect your Pollar wallet first.' });

      const id = parseTweetId(body.tweetUrl);
      if (!id) return NextResponse.json({ ok: false, error: "That doesn't look like a tweet link. Paste the full URL of your tweet." });

      let t;
      try { t = await fetchTweet(id); } catch (e) { return NextResponse.json({ ok: false, error: 'Could not read that tweet — is it public and not deleted?' }); }
      if (!t || t.__typename !== 'Tweet' || !t.user) return NextResponse.json({ ok: false, error: 'That tweet is unavailable (deleted, private, or wrong link).' });

      const screen = String(t.user.screen_name || '').toLowerCase();
      const text = String(t.text || '');
      if (screen !== handle) return NextResponse.json({ ok: false, error: `That tweet is from @${screen}, not @${handle}. Post it from @${handle}.` });
      if (!text.includes(code)) return NextResponse.json({ ok: false, error: "The tweet doesn't contain your code. Post it exactly as shown." });

      await execute(
        `INSERT INTO tagly_identities (platform, handle, pollar_address, display_name, verified, onboarded)
         VALUES ('x', ?, ?, ?, 1, 1)
         ON CONFLICT(platform, handle) DO UPDATE SET pollar_address = excluded.pollar_address, verified = 1`,
        [handle, address, t.user.name || handle]
      );
      return NextResponse.json({ ok: true, handle });
    }

    return NextResponse.json({ ok: false, error: 'Unknown action.' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
