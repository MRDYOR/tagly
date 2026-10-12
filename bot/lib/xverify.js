// X (Twitter) ownership verification — free & unauthenticated.
// The user posts a tweet containing a one-time code from the handle they claim.
// We read that specific tweet via the public syndication endpoint and confirm
// (a) it came from that @handle and (b) it contains the code. Posting from the
// account proves control — stronger than a bio and doesn't need the paid API.

function parseTweetId(input) {
  const s = String(input || '').trim();
  // tweet IDs are long (~19 digits); require a status URL or a 15+ digit id so a
  // 6-digit OTP is never mistaken for a tweet id.
  const m = s.match(/status(?:es)?\/(\d{2,25})/) || s.match(/^(\d{15,25})$/);
  return m ? m[1] : null;
}

async function fetchTweet(id) {
  const token = (Number(id) % 1e6).toString(36); // any token works; derive one
  const url = `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${token}&lang=en`;
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' },
  });
  if (!r.ok) throw new Error(`tweet fetch ${r.status}`);
  return r.json();
}

// Returns { ok, reason?, screenName? }
async function verifyTweet(handle, tweetInput, code) {
  const id = parseTweetId(tweetInput);
  if (!id) return { ok: false, reason: 'That doesn\'t look like a tweet link. Paste the full URL of your tweet.' };
  let t;
  try { t = await fetchTweet(id); } catch (e) { return { ok: false, reason: 'Could not read that tweet — is it public and not deleted?' }; }
  if (!t || t.__typename !== 'Tweet' || !t.user) return { ok: false, reason: 'That tweet is unavailable (deleted, private, or wrong link).' };
  const screen = String(t.user.screen_name || '').toLowerCase();
  const want = String(handle || '').replace(/^@/, '').toLowerCase();
  const text = String(t.text || '');
  if (screen !== want) return { ok: false, reason: `That tweet is from @${screen}, not @${want}. Post it from the @${want} account.` };
  if (!text.includes(code)) return { ok: false, reason: 'The tweet doesn\'t contain your verification code. Make sure it\'s exactly as given.' };
  return { ok: true, screenName: screen };
}

module.exports = { verifyTweet, parseTweetId };
