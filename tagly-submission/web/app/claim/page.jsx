'use client';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';

function ClaimInner() {
  const params = useSearchParams();
  const [handle, setHandle] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    const h = params.get('handle');
    if (h) setHandle(h.replace(/^@/, ''));
  }, [params]);

  async function login() {
    if (!handle.trim()) return;
    setBusy(true); setErr(''); setRes(null);
    const r = await fetch('api/claim', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'sim', handle }),
    }).then(r => r.json());
    setBusy(false);
    if (!r.ok) { setErr(r.error); return; }
    setRes(r);
  }

  return (
    <div className="wrap">
      <header className="top">
        <Link href="/" className="brand" style={{ textDecoration: 'none' }}>
          <div className="logo">◎</div>
          <div><h1>Tagly</h1><div className="tag">claim your payments</div></div>
        </Link>
        <nav className="nav"><Link href="/">Feed</Link><Link href="/history">History</Link></nav>
      </header>

      <div className="banner ok">
        <b>Account abstraction:</b> you don't need a wallet to get paid. Log in with your handle and Pollar generates a Stellar wallet for you — any payments waiting on you land instantly.
      </div>

      {!res && (
        <div className="card pad">
          <label className="fld">Your handle</label>
          <input className="input" placeholder="alice" value={handle} onChange={e => setHandle(e.target.value.replace(/^@/, ''))} />
          {err && <div className="banner warn" style={{ marginTop: 12, marginBottom: 0 }}>⚠️ {err}</div>}
          <button className="btn block lg" style={{ marginTop: 16 }} onClick={login} disabled={busy}>
            {busy ? <><span className="spin" /> Generating wallet…</> : 'Log in & generate my wallet'}
          </button>
          <div className="tiny muted center" style={{ marginTop: 10 }}>In live mode this is a real Pollar login (Google / email) — no seed phrase.</div>
        </div>
      )}

      {res && (
        <div className="card pad center">
          <div style={{ fontSize: 48 }}>🎉</div>
          <h2 style={{ margin: '10px 0 2px', fontSize: 20 }}>Wallet ready for @{res.handle}</h2>
          <div className="tiny mono muted" style={{ wordBreak: 'break-all', margin: '4px 0 14px' }}>{res.wallet}</div>
          {res.claimed.length === 0
            ? <div className="muted">No payments were waiting for you.</div>
            : <>
                <div className="big-amount" style={{ fontSize: 36 }}>+{res.totalUsdc.toFixed(2)} <span className="asset">USDC</span></div>
                <div className="muted small" style={{ marginBottom: 12 }}>claimed from {res.claimed.length} payment{res.claimed.length > 1 ? 's' : ''}</div>
                {res.claimed.map(c => (
                  <div className="kv" key={c.id}><span className="k">from @{c.from}</span><span className="v">{c.amount} {c.asset}</span></div>
                ))}
              </>}
          <Link href="/"><button className="btn block" style={{ marginTop: 16 }}>Back to feed</button></Link>
        </div>
      )}
    </div>
  );
}

export default function ClaimPage() {
  return <Suspense fallback={<div className="wrap"><div className="empty">Loading…</div></div>}><ClaimInner /></Suspense>;
}
