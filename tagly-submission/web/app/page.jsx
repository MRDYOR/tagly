'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { POLLAR_ENABLED } from './providers';
import PollarWallet from './PollarWallet';

const EXAMPLES = [
  '@tagly send 5 XLM to @alice',
  '@tagly tip @bob 2 XLM for the alpha 🙏',
  '@tagly split 30 XLM with @carol @dave @erin',
  '@tagly pay @frank 10 XLM',
];

function highlight(text) {
  return text.split(/(@[a-zA-Z0-9_]+)/g).map((part, i) => {
    if (/^@/.test(part)) {
      const isBot = /^@tagly/i.test(part);
      return <span key={i} className={isBot ? 'botmention' : 'mention'}>{part}</span>;
    }
    return <span key={i}>{part}</span>;
  });
}

// ── Per-intent verification flow: ✅ → one-time code → authorize → settle ──
function VerifyFlow({ intent, onDone }) {
  const [stage, setStage] = useState('idle'); // idle | coding | done
  const [code, setCode] = useState(null);      // the issued code (sim only)
  const [entry, setEntry] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState(null);

  async function react() {
    setBusy(true); setErr('');
    const r = await fetch('api/verify/request', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intentId: intent.id }),
    }).then(r => r.json());
    setBusy(false);
    if (!r.ok) { setErr(r.error); return; }
    setCode(r.code); setStage('coding');
  }

  async function authorize() {
    setBusy(true); setErr('');
    const v = await fetch('api/verify/confirm', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intentId: intent.id, code: entry }),
    }).then(r => r.json());
    if (!v.ok) { setErr(v.error); setBusy(false); return; }
    // authorized → settle (sim mints tx; real would sign via Pollar mini-app)
    const s = await fetch('api/execute', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: intent.id }),
    }).then(r => r.json());
    setBusy(false);
    if (!s.ok) { setErr(s.error); return; }
    setResult(s.intent); setStage('done');
    onDone && onDone();
  }

  if (stage === 'done' && result) {
    if (result.status === 'claimable') {
      return (
        <div className="banner warn" style={{ marginTop: 10, marginBottom: 0 }}>
          ⏳ Authorized & held for <b>@{intent.dest_handle}</b> — they have no wallet yet.
          It auto-lands when they log in. <Link href={`/claim?handle=${intent.dest_handle}`}>Simulate their login →</Link>
        </div>
      );
    }
    return (
      <div className="banner ok" style={{ marginTop: 10, marginBottom: 0 }}>
        ✅ Sent {result.amount} {result.asset_code} to @{intent.dest_handle}
        <div className="tiny mono" style={{ marginTop: 4, wordBreak: 'break-all', opacity: .8 }}>{result.tx_hash}</div>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 10 }}>
      {stage === 'idle' && (
        <button className="btn mint block" onClick={react} disabled={busy}>
          {busy ? <><span className="spin" /> Requesting…</> : '✅  React to authorize'}
        </button>
      )}

      {stage === 'coding' && (
        <div>
          {/* simulated Telegram bot DM */}
          <div className="botdm">
            <div className="botdm-head"><span className="botdm-ava">◎</span> Tagly Bot <span className="tiny muted">· private DM</span></div>
            <div className="botdm-body">
              🔐 One-time code to authorize<br />
              <b>{intent.amount} {intent.asset_code}</b> → @{intent.dest_handle}
              <div className="otp">{code}</div>
              <div className="tiny muted">single use · expires in 3 min · never share</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <input className="input" style={{ margin: 0, letterSpacing: 4, fontWeight: 700 }} placeholder="Enter code"
              value={entry} onChange={e => setEntry(e.target.value.replace(/\D/g, '').slice(0, 6))} />
            <button className="btn" onClick={authorize} disabled={busy || entry.length < 6}>
              {busy ? <span className="spin" /> : 'Authorize'}
            </button>
          </div>
        </div>
      )}
      {err && <div className="banner warn" style={{ marginTop: 10, marginBottom: 0 }}>⚠️ {err}</div>}
    </div>
  );
}

export default function Home() {
  const [author, setAuthor] = useState('you');
  const [text, setText] = useState('');
  const [feed, setFeed] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function load(who) {
    const a = (who ?? author) || 'you';
    const r = await fetch(`api/feed?author=${encodeURIComponent(a)}`).then(r => r.json()).catch(() => ({ feed: [] }));
    setFeed(r.feed || []);
  }
  // restore this device's handle
  useEffect(() => { const a = localStorage.getItem('tagly_author'); if (a) setAuthor(a); }, []);
  // persist + reload when the handle changes
  useEffect(() => { localStorage.setItem('tagly_author', author); load(author); }, [author]);

  async function post() {
    if (!text.trim()) return;
    setBusy(true); setErr('');
    try {
      const r = await fetch('api/parse', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, author, platform: 'sim' }),
      }).then(r => r.json());
      if (!r.ok) setErr(r.error || 'Could not parse that command.');
      setText('');
      await load();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  }

  return (
    <div className="wrap">
      <header className="top">
        <div className="brand">
          <div className="logo">◎</div>
          <div><h1>Tagly</h1><div className="tag">tag someone → pay them</div></div>
        </div>
        <nav className="nav" style={{ alignItems: 'center' }}>
          <Link href="/history">History</Link>
          <Link href="/claim">Claim</Link>
          {POLLAR_ENABLED && <PollarWallet />}
        </nav>
      </header>

      <div style={{ marginBottom: 6 }}>
        <span className={`mode-pill ${POLLAR_ENABLED ? 'mode-live' : 'mode-sim'}`}>
          <span className="dot" />
          {POLLAR_ENABLED ? 'Pollar testnet · live' : 'Simulated testnet · demo mode'}
        </span>
      </div>
      <div className="tiny muted" style={{ marginBottom: 14 }}>
        Showing only <b>your</b> activity as <b style={{ color: 'var(--accent2)' }}>@{author || 'you'}</b> — set your handle below.
      </div>

      <div className="card composer">
        <div className="small muted" style={{ marginBottom: 8 }}>
          Post like on X / a Telegram group. Tag <b className="mono" style={{ color: 'var(--mint)' }}>@tagly</b>, then authorize with the green ✅ + one-time code from the bot.
        </div>
        <textarea
          placeholder="@tagly send 5 XLM to @alice"
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) post(); }}
        />
        <div className="chips">
          {EXAMPLES.map(ex => <span key={ex} className="chip" onClick={() => setText(ex)}>{ex}</span>)}
        </div>
        <div className="row">
          <input className="who" value={author} onChange={e => setAuthor(e.target.value.replace(/^@/, ''))} title="who is posting" />
          <button className="btn" onClick={post} disabled={busy}>
            {busy ? <><span className="spin" /> Reading…</> : 'Post'}
          </button>
          <span className="tiny muted">⌘/Ctrl + Enter</span>
        </div>
        {err && <div className="banner warn" style={{ marginTop: 12, marginBottom: 0 }}>⚠️ {err}</div>}
      </div>

      {feed.length === 0 && <div className="empty">No posts yet — try an example above ☝️</div>}

      {feed.map(post => (
        <div className="card post" key={post.id}>
          <div className="head">
            <div className="avatar">{(post.author_handle || '?')[0].toUpperCase()}</div>
            <div>
              <div className="name">{post.author_handle}</div>
              <div className="hnd">@{post.author_handle} · {post.platform}</div>
            </div>
          </div>
          <div className="body">{highlight(post.text)}</div>

          {post.intents && post.intents.map(it => (
            <div className="intent" key={it.id}>
              <div className="line">
                <div>
                  <div className="amt">{it.amount} <span className="asset">{it.asset_code}</span></div>
                  <div className="to">{it.action} → @{it.dest_handle}</div>
                </div>
                <span className={`status ${it.status}`}>{it.status}</span>
              </div>

              {(it.status === 'pending' || it.status === 'authorized') && <VerifyFlow intent={it} onDone={load} />}

              {it.status === 'claimable' && (
                <div className="banner warn" style={{ marginTop: 10, marginBottom: 0 }}>
                  ⏳ Held for @{it.dest_handle} (no wallet yet). <Link href={`/claim?handle=${it.dest_handle}`}>Simulate login →</Link>
                </div>
              )}
              {it.status === 'executed' && it.tx_hash && (
                <div className="tiny muted mono" style={{ marginTop: 8, wordBreak: 'break-all' }}>✓ {it.tx_hash}</div>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
