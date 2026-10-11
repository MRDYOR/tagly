'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePollar } from '@pollar/react';
import Logo from '../Logo';
import { POLLAR_ENABLED } from '../providers';

const BOT = 'Taglypay_bot';

function usePollarSafe() { try { return POLLAR_ENABLED ? usePollar() : {}; } catch (e) { return {}; } }

function Header() {
  const router = useRouter();
  return (
    <header className="top">
      <button className="backbtn" onClick={() => router.push('/profile')} aria-label="Back">‹</button>
      <div className="brand" style={{ margin: '0 auto' }}><Logo size={26} /><div><h1 style={{ fontSize: 20 }}>Tagly</h1></div></div>
      <div style={{ width: 26 }} />
    </header>
  );
}

const I = {
  pollar: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="6" width="18" height="13" rx="2" /><path d="M16 12h.01" /></svg>,
  mail: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></svg>,
  tg: <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M18.9 3 1.6 9.6c-1 .4-1 1.9.1 2.2l4.4 1.4 1.7 5.3c.3.9 1.4 1 2 .3l2.4-2.6 4.6 3.4c.7.5 1.7.1 1.9-.8L21.9 4.2c.2-1-.8-1.7-1.7-1.3Z" /></svg>,
  dc: <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M20 5a19 19 0 0 0-4.7-1.4l-.2.5A17 17 0 0 1 12 4c-1 0-2 .1-3 .4l-.2-.5A19 19 0 0 0 4 5C1.6 8.5 1 12 1.2 15.4A19 19 0 0 0 7 18l.5-.8-.9-.5.2-.2c3.5 1.6 7 1.6 10.4 0l.2.2-.9.5.5.8a19 19 0 0 0 5.8-2.6C23 11.5 22.4 8 20 5ZM8.5 14c-.8 0-1.5-.8-1.5-1.7S7.7 10.6 8.5 10.6s1.5.8 1.5 1.7S9.3 14 8.5 14Zm7 0c-.8 0-1.5-.8-1.5-1.7s.7-1.7 1.5-1.7 1.5.8 1.5 1.7S16.3 14 15.5 14Z" /></svg>,
  x: <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M18 2h3l-7.5 8.6L22 22h-6.8l-4.8-6.3L4.8 22H1.7l8.1-9.2L2 2h6.9l4.3 5.8L18 2Zm-2.4 18h1.9L8.4 4H6.4l9.2 16Z" /></svg>,
};

function Copyable({ text, label }) {
  const [c, setC] = useState(false);
  return (
    <button className="copyline" onClick={async () => { try { await navigator.clipboard.writeText(text); setC(true); setTimeout(() => setC(false), 1400); } catch (e) {} }}>
      <span className="mono">{label || text}</span>
      <span className="cp">{c ? 'Copied ✓' : 'Copy'}</span>
    </button>
  );
}

// Chips of linked handles, each with an ✕ to unlink it.
function LinkedChips({ handles, onUnlink, busy }) {
  return (
    <div className="chipset">
      {handles.map(h => (
        <span className="lchip" key={h}>
          @{h}
          <button className="x" onClick={() => onUnlink(h)} disabled={busy === h} aria-label={`Unlink @${h}`}>
            {busy === h ? <span className="spin sm" /> : '✕'}
          </button>
        </span>
      ))}
    </div>
  );
}

function Row({ icon, name, status, linked, action, onAction, open, children }) {
  return (
    <div className="menu" style={{ marginBottom: 10 }}>
      <div className="item" style={{ cursor: 'default' }}>
        <div className="ico">{icon}</div>
        <div className="mid">
          <div className="t">{name}</div>
          <div className="d">{status}</div>
        </div>
        {linked
          ? <span className="status executed" style={{ fontSize: 10 }}>Linked</span>
          : action
            ? <button className="linkbtn" onClick={onAction}>{open ? 'Close' : action}</button>
            : <span className="soon">—</span>}
      </div>
      {children}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="menu" style={{ marginBottom: 10 }}>
      <div className="item" style={{ cursor: 'default' }}>
        <div className="ico sk" />
        <div className="mid"><div className="sk-line w40" /><div className="sk-line w70" style={{ marginTop: 8 }} /></div>
        <div className="sk-pill" />
      </div>
    </div>
  );
}

function Inner() {
  const router = useRouter();
  const { isAuthenticated, wallet, openLoginModal, getClient } = usePollarSafe();
  const [data, setData] = useState(null);
  const [openPanel, setOpenPanel] = useState('');
  const [unbusy, setUnbusy] = useState('');
  const addr = wallet?.address;
  const profileEmail = (() => { try { return getClient?.().getUserProfile?.()?.mail; } catch (e) { return null; } })();

  const refresh = () => {
    if (!addr) return;
    fetch(`/pub/tagly/tagly/api/connected?address=${addr}&email=${encodeURIComponent(profileEmail || '')}`)
      .then(r => r.json()).then(d => setData(d)).catch(() => setData({ telegram: [], discord: [], x: [], email: null }));
  };
  useEffect(() => { refresh(); }, [addr]);

  async function unlink(platform, handle) {
    setUnbusy(handle);
    try {
      await fetch('/pub/tagly/tagly/api/unlink', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platform, address: addr, handle }) });
      // optimistic prune, then reconcile
      setData(d => ({ ...d, [platform]: (d[platform] || []).filter(h => h !== handle) }));
      refresh();
    } catch (e) {} finally { setUnbusy(''); }
  }

  if (!isAuthenticated) {
    return (
      <div className="wrap"><Header />
        <div className="empty" style={{ paddingTop: 64 }}>
          <div className="eico"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 17H7A5 5 0 0 1 7 7h2M15 7h2a5 5 0 0 1 0 10h-2M8 12h8" /></svg></div>
          <div className="big">Connected accounts</div>
          Sign in with Pollar, then link your Telegram, Discord and X — all from here.
          <div style={{ marginTop: 18 }}><button className="btn" onClick={() => router.push('/welcome')}>Connect Pollar</button></div>
        </div>
      </div>
    );
  }

  const loading = !data;
  const email = data?.email || profileEmail;
  const toggle = (k) => setOpenPanel(p => (p === k ? '' : k));

  return (
    <div className="wrap"><Header />
      <h1 className="h1" style={{ fontSize: 28 }}>Connected accounts</h1>
      <p className="sub">Link Telegram, Discord and X to your Pollar wallet — right here, no bot required.</p>

      {loading ? (
        <>{[0, 1, 2, 3, 4].map(i => <Skeleton key={i} />)}</>
      ) : (
        <>
          <Row icon={I.pollar} name="Pollar wallet" status={`${addr.slice(0, 8)}…${addr.slice(-4)}`} linked />

          <Row icon={I.mail} name="Email" status={email || 'Sign in with Pollar to connect'} linked={!!email} />

          <Row
            icon={I.tg} name="Telegram"
            status={data.telegram?.length ? 'Linked to your wallet' : 'Connect in one tap'}
            linked={!!data.telegram?.length} action="Connect" open={openPanel === 'tg'} onAction={() => toggle('tg')}
          >
            {data.telegram?.length ? <LinkedChips handles={data.telegram} busy={unbusy} onUnlink={h => unlink('telegram', h)} /> : openPanel === 'tg' && (
              <div className="panel">
                <p>Opens Telegram and links <b>@{BOT}</b> to this Pollar wallet the moment you tap <b>Start</b>.</p>
                <a className="btn" href={`https://t.me/${BOT}?start=link_${addr}`} target="_blank" rel="noreferrer" onClick={() => setTimeout(refresh, 6000)}>Open Telegram & connect</a>
                <button className="btn ghost" style={{ marginTop: 8 }} onClick={refresh}>I've connected — refresh</button>
              </div>
            )}
          </Row>

          <Row
            icon={I.dc} name="Discord"
            status={data.discord?.length ? 'Linked to your wallet' : 'Link with one command'}
            linked={!!data.discord?.length} action="Connect" open={openPanel === 'dc'} onAction={() => toggle('dc')}
          >
            {data.discord?.length ? <LinkedChips handles={data.discord} busy={unbusy} onUnlink={h => unlink('discord', h)} /> : openPanel === 'dc' && (
              <div className="panel">
                <p>In any server with the Tagly bot (or its DMs), send this — it links your Discord to this wallet:</p>
                <Copyable text={`tagly linkpollar ${addr}`} label={`tagly linkpollar ${addr.slice(0, 10)}…${addr.slice(-4)}`} />
                <button className="btn ghost" style={{ marginTop: 10 }} onClick={refresh}>I've connected — refresh</button>
              </div>
            )}
          </Row>

          <XRow linked={data.x} addr={addr} open={openPanel === 'x'} onToggle={() => toggle('x')} onDone={refresh} onUnlink={h => unlink('x', h)} unbusy={unbusy} />

          <div className="banner" style={{ marginTop: 18 }}>
            Everything ties back to one Pollar wallet — link an account here or in the bots and your balance, sends and cash-outs stay unified.
          </div>
        </>
      )}
    </div>
  );
}

// Inline X verification + unlink.
function XRow({ linked, addr, open, onToggle, onDone, onUnlink, unbusy }) {
  const [handle, setHandle] = useState('');
  const [code, setCode] = useState('');
  const [text, setText] = useState('');
  const [tweet, setTweet] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState(false);

  async function getCode() {
    const h = handle.replace(/^@/, '').trim();
    if (!h) { setErr('Enter your X handle.'); return; }
    setBusy(true); setErr('');
    try {
      const r = await fetch('/pub/tagly/tagly/api/link-x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'code' }) }).then(r => r.json());
      if (r.ok) { setCode(r.code); setText(r.text); } else setErr(r.error || 'Could not start.');
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  async function verify() {
    setBusy(true); setErr('');
    try {
      const r = await fetch('/pub/tagly/tagly/api/link-x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'verify', handle, code, address: addr, tweetUrl: tweet }) }).then(r => r.json());
      if (r.ok) { setOk(true); onDone(); } else setErr(r.error || 'Verification failed.');
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <Row
      icon={I.x} name="X (Twitter)"
      status={linked?.length ? 'Verified & linked' : 'Verify by posting a code'}
      linked={!!linked?.length} action="Connect" open={open} onAction={onToggle}
    >
      {linked?.length ? <LinkedChips handles={linked} busy={unbusy} onUnlink={onUnlink} /> : open && (
        <div className="panel">
          {ok ? <p style={{ color: 'var(--green)' }}>✓ @{handle.replace(/^@/, '')} verified and linked. Refreshing…</p> : !code ? (
            <>
              <p>Prove you own an X handle by posting a one-time code from it.</p>
              <div className="xinput">
                <span>@</span>
                <input value={handle} onChange={e => setHandle(e.target.value)} placeholder="yourhandle" autoCapitalize="none" />
              </div>
              <button className="btn" style={{ marginTop: 10 }} onClick={getCode} disabled={busy}>{busy ? '…' : 'Get my code'}</button>
            </>
          ) : (
            <>
              <p>1. Post this on X:</p>
              <Copyable text={text} label="Copy tweet text" />
              <a className="btn" style={{ marginTop: 8 }} href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`} target="_blank" rel="noreferrer">Post on X</a>
              <p style={{ marginTop: 12 }}>2. Paste the link to your tweet:</p>
              <div className="xinput"><input value={tweet} onChange={e => setTweet(e.target.value)} placeholder="https://x.com/you/status/…" autoCapitalize="none" /></div>
              <button className="btn" style={{ marginTop: 10 }} onClick={verify} disabled={busy || !tweet.trim()}>{busy ? 'Verifying…' : 'Verify & link'}</button>
            </>
          )}
          {err && <div className="banner warn" style={{ marginTop: 10 }}>{err}</div>}
        </div>
      )}
    </Row>
  );
}

export default function Connected() {
  return POLLAR_ENABLED ? <Inner /> : (
    <div className="wrap"><Header /><div className="empty" style={{ paddingTop: 70 }}>Connect accounts once Pollar is enabled.</div></div>
  );
}
