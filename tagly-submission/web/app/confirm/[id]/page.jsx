'use client';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { usePollar } from '@pollar/react';
import { POLLAR_ENABLED } from '../../providers';

function useIntent(id) {
  const [intent, setIntent] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!id) return;
    fetch(`api/intents/${id}`).then(r => r.json()).then(r => {
      setIntent(r.intent || null); setLoading(false);
    }).catch(() => setLoading(false));
  }, [id]);
  return { intent, setIntent, loading };
}

function Shell({ children }) {
  return (
    <div className="wrap">
      <header className="top">
        <Link href="/" className="brand" style={{ textDecoration: 'none' }}>
          <div className="logo">◎</div>
          <div><h1>Tagly</h1><div className="tag">confirm payment</div></div>
        </Link>
        <span className={`mode-pill ${POLLAR_ENABLED ? 'mode-live' : 'mode-sim'}`}>
          <span className="dot" />{POLLAR_ENABLED ? 'Pollar · live' : 'Simulated'}
        </span>
      </header>
      {children}
    </div>
  );
}

function Details({ intent }) {
  return (
    <>
      <div className="center" style={{ padding: '10px 0 18px' }}>
        <div className="muted small">You are sending</div>
        <div className="big-amount">{intent.amount} <span className="asset">{intent.asset_code}</span></div>
        <div className="muted">to <b style={{ color: 'var(--accent2)' }}>@{intent.dest_handle}</b></div>
      </div>
      <div className="card">
        <div className="kv"><span className="k">Action</span><span className="v" style={{ textTransform: 'capitalize' }}>{intent.action}</span></div>
        <div className="kv"><span className="k">Recipient</span><span className="v mono tiny">{intent.dest_address}</span></div>
        <div className="kv"><span className="k">From</span><span className="v mono tiny">@{intent.source_handle}</span></div>
        <div className="kv"><span className="k">Network fee</span><span className="v" style={{ color: 'var(--mint)' }}>Sponsored · $0</span></div>
      </div>
    </>
  );
}

// Shared one-time-code gate. Calls onAuthorized() once the intent is authorized.
function OtpGate({ intent, onAuthorized }) {
  const [code, setCode] = useState(null);
  const [entry, setEntry] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [stage, setStage] = useState('idle');

  async function req() {
    setBusy(true); setErr('');
    const r = await fetch('api/verify/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ intentId: intent.id }) }).then(r => r.json());
    setBusy(false);
    if (!r.ok) return setErr(r.error);
    setCode(r.code); setStage('coding');
  }
  async function confirm() {
    setBusy(true); setErr('');
    const v = await fetch('api/verify/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ intentId: intent.id, code: entry }) }).then(r => r.json());
    setBusy(false);
    if (!v.ok) return setErr(v.error);
    onAuthorized();
  }
  return (
    <div className="card">
      <div className="small muted" style={{ marginBottom: 10 }}>Authorize this payment with a one-time code from the Tagly bot.</div>
      {stage === 'idle'
        ? <button className="btn mint block" onClick={req} disabled={busy}>{busy ? <span className="spin" /> : '✅  React to authorize'}</button>
        : <>
            <div className="botdm">
              <div className="botdm-head"><span className="botdm-ava">◎</span> Tagly Bot <span className="tiny muted">· private DM</span></div>
              <div className="botdm-body">🔐 One-time code<div className="otp">{code}</div><div className="tiny muted">single use · expires 3 min</div></div>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <input className="input" style={{ margin: 0, letterSpacing: 4, fontWeight: 700 }} placeholder="Enter code" value={entry} onChange={e => setEntry(e.target.value.replace(/\D/g, '').slice(0, 6))} />
              <button className="btn" onClick={confirm} disabled={busy || entry.length < 6}>{busy ? <span className="spin" /> : 'Authorize'}</button>
            </div>
          </>}
      {err && <div className="banner warn" style={{ marginTop: 10, marginBottom: 0 }}>⚠️ {err}</div>}
    </div>
  );
}

function Success({ intent }) {
  const hash = intent.tx_hash || '';
  const simulated = /^SIMTX/.test(hash) || !POLLAR_ENABLED;
  const explorer = `https://stellar.expert/explorer/testnet/tx/${hash}`;
  const claimable = intent.status === 'claimable';
  return (
    <Shell>
      <div className="card pad center">
        <div style={{ fontSize: 52, lineHeight: 1 }}>{claimable ? '⏳' : '✅'}</div>
        <h2 style={{ margin: '12px 0 4px', fontSize: 22 }}>{claimable ? 'Authorized & held' : 'Payment sent'}</h2>
        <div className="big-amount" style={{ fontSize: 34, margin: '10px 0' }}>{intent.amount} <span className="asset">{intent.asset_code}</span></div>
        <div className="muted">to @{intent.dest_handle}</div>
        <hr className="hr" />
        {claimable
          ? <div className="banner warn" style={{ textAlign: 'left' }}>@{intent.dest_handle} has no wallet yet. This lands automatically when they log in. <Link href={`/claim?handle=${intent.dest_handle}`}>Simulate their login →</Link></div>
          : <>
              <div className="tiny muted">Transaction</div>
              <div className="mono tiny" style={{ wordBreak: 'break-all', margin: '4px 0 12px' }}>{hash}</div>
              {simulated
                ? <div className="banner warn" style={{ textAlign: 'left' }}>Simulated transaction (demo mode).</div>
                : <a href={explorer} target="_blank" rel="noreferrer"><button className="btn ghost block">View on Stellar Explorer ↗</button></a>}
            </>}
        <Link href="/"><button className="btn block" style={{ marginTop: 10 }}>Back to feed</button></Link>
      </div>
    </Shell>
  );
}

function SimConfirm({ intent, setIntent }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const authorized = intent.status === 'authorized';
  async function settle() {
    setBusy(true); setErr('');
    const r = await fetch('api/execute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: intent.id }) }).then(r => r.json());
    setBusy(false);
    if (!r.ok) return setErr(r.error);
    setIntent(r.intent);
  }
  return (
    <Shell>
      <Details intent={intent} />
      {!authorized
        ? <OtpGate intent={intent} onAuthorized={() => setIntent({ ...intent, status: 'authorized' })} />
        : <>
            {err && <div className="banner warn">⚠️ {err}</div>}
            <button className="btn mint block lg" onClick={settle} disabled={busy}>{busy ? <><span className="spin" /> Settling…</> : `Send ${intent.amount} ${intent.asset_code}`}</button>
          </>}
      <Link href="/"><button className="btn ghost block" style={{ marginTop: 10 }}>Cancel</button></Link>
    </Shell>
  );
}

function PollarConfirm({ intent, setIntent }) {
  const { isAuthenticated, wallet, login, runTx } = usePollar();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const ISSUER = process.env.NEXT_PUBLIC_POLLAR_USDC_ISSUER;
  const authorized = intent.status === 'authorized';

  async function pay() {
    setBusy(true); setErr('');
    try {
      const asset = intent.asset_code === 'XLM' ? { type: 'native' } : { type: 'credit_alphanum4', code: 'USDC', issuer: ISSUER };
      const res = await runTx('payment', { destination: intent.dest_address, amount: String(intent.amount), asset });
      const hash = res?.hash || res?.id || res?.txHash || res?.transactionHash;
      const done = await fetch('api/execute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: intent.id, txHash: hash, mode: 'pollar' }) }).then(r => r.json());
      if (!done.ok) { setErr(done.error); setBusy(false); return; }
      setIntent(done.intent);
    } catch (e) { setErr(e?.message || 'Payment failed'); setBusy(false); }
  }

  return (
    <Shell>
      <Details intent={intent} />
      {!authorized
        ? <OtpGate intent={intent} onAuthorized={() => setIntent({ ...intent, status: 'authorized' })} />
        : <>
            {!ISSUER && intent.asset_code === 'USDC' && <div className="banner warn">Set <span className="mono">NEXT_PUBLIC_POLLAR_USDC_ISSUER</span> to send USDC.</div>}
            {err && <div className="banner warn">⚠️ {err}</div>}
            {!isAuthenticated
              ? <button className="btn block lg" onClick={() => login({ provider: 'google' })}>Continue with Google to sign</button>
              : <>
                  <div className="tiny muted center" style={{ marginBottom: 8 }}>Paying from {wallet?.address?.slice(0, 6)}…{wallet?.address?.slice(-4)}</div>
                  <button className="btn mint block lg" onClick={pay} disabled={busy}>{busy ? <><span className="spin" /> Signing…</> : `Sign & send ${intent.amount} ${intent.asset_code}`}</button>
                </>}
          </>}
      <Link href="/"><button className="btn ghost block" style={{ marginTop: 10 }}>Cancel</button></Link>
    </Shell>
  );
}

export default function ConfirmPage() {
  const { id } = useParams();
  const { intent, setIntent, loading } = useIntent(id);
  if (loading) return <Shell><div className="empty">Loading…</div></Shell>;
  if (!intent) return <Shell><div className="empty">Intent not found.</div></Shell>;
  if (intent.status === 'executed' || intent.status === 'claimable') return <Success intent={intent} />;
  return POLLAR_ENABLED ? <PollarConfirm intent={intent} setIntent={setIntent} /> : <SimConfirm intent={intent} setIntent={setIntent} />;
}
