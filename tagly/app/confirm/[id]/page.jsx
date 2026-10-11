'use client';
import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { usePollar } from '@pollar/react';
import Logo from '../../Logo';
import { POLLAR_ENABLED } from '../../providers';

const API = '/pub/tagly/tagly/api';

function Header({ back }) {
  const router = useRouter();
  return (
    <header className="top">
      {back && <button className="backbtn" onClick={() => router.push('/')} aria-label="Back">‹</button>}
      <div className="brand" style={{ margin: back ? '0 auto' : 0 }}>
        <Logo size={28} />
        <div><h1 style={{ fontSize: 22 }}>Tagly</h1></div>
      </div>
      <div style={{ width: back ? 28 : 0 }} />
    </header>
  );
}

function SlideToSend({ label, onComplete }) {
  const trackRef = useRef(null);
  const drag = useRef(false);
  const [x, setX] = useState(0);
  const [locked, setLocked] = useState(false);
  const KNOB = 58, PAD = 4;
  const down = (e) => { if (locked) return; drag.current = true; try { e.currentTarget.setPointerCapture(e.pointerId); } catch (er) {} };
  const move = (e) => {
    if (!drag.current || locked) return;
    const t = trackRef.current.getBoundingClientRect();
    const max = t.width - KNOB - PAD;
    const nx = Math.max(0, Math.min(e.clientX - t.left - KNOB / 2, max));
    setX(nx);
    if (nx >= max - 3) { setLocked(true); drag.current = false; onComplete(); }
  };
  const up = () => { if (!locked) { drag.current = false; setX(0); } };
  return (
    <div className={`slider ${locked ? 'done' : ''}`} ref={trackRef}>
      <span className="track-txt">{locked ? 'Sending…' : label}</span>
      <div className="knob" style={{ transform: `translateX(${x}px)`, transition: drag.current ? 'none' : 'transform .2s ease' }}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        {locked ? <span className="spin" /> : '→'}
      </div>
    </div>
  );
}

function Success({ intent }) {
  const router = useRouter();
  const hash = intent.tx_hash || '';
  const simulated = /^SIMTX/.test(hash) || !POLLAR_ENABLED;
  const claimable = intent.status === 'claimable';
  const [copied, setCopied] = useState(false);
  const short = hash ? `${hash.slice(0, 10)}…${hash.slice(-4)}` : '';
  const copy = async () => { try { await navigator.clipboard.writeText(hash); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch (e) {} };
  return (
    <div className="wrap">
      <Header />
      <div className="center">
        <div className="check">✓</div>
        <div style={{ fontSize: 34, fontWeight: 800, letterSpacing: '-0.03em' }}>{claimable ? 'Held for claim' : 'Payment Sent'}</div>
        <div className="big-amount" style={{ fontSize: 44 }}>{intent.amount} {intent.asset_code}</div>
        <div className="confirm-to" style={{ marginTop: 12 }}>
          <div className="av" style={{ width: 60, height: 60, fontSize: 22 }}>{(intent.dest_handle || '?')[0].toUpperCase()}</div>
          <div className="hn" style={{ fontSize: 18 }}>@{intent.dest_handle}</div>
        </div>
      </div>

      {claimable ? (
        <div className="banner warn" style={{ marginTop: 24 }}>@{intent.dest_handle} has no wallet yet — this lands automatically when they onboard.</div>
      ) : (
        <div className="wcard" style={{ marginTop: 26 }}>
          <div className="kv"><span className="k">Transaction ID</span><span className="v" onClick={copy} style={{ cursor: 'pointer' }}>{copied ? 'Copied ✓' : short} ⧉</span></div>
          <div className="kv"><span className="k">Network Fee</span><span className="v">0.00001 XLM</span></div>
          <div className="kv"><span className="k">Status</span><span className="v green">● Completed</span></div>
        </div>
      )}

      {!claimable && !simulated && hash && (
        <a href={`https://stellar.expert/explorer/testnet/tx/${hash}`} target="_blank" rel="noreferrer" style={{ display: 'block', textAlign: 'center', margin: '18px 0', fontWeight: 600 }}>View on Stellar ↗</a>
      )}
      {simulated && !claimable && <div className="center small muted" style={{ margin: '16px 0' }}>Simulated transaction (demo mode)</div>}

      <button className="btn block lg" style={{ marginTop: 8 }} onClick={() => router.push('/history')}>Done</button>
    </div>
  );
}

function useIntent(id) {
  const [intent, setIntent] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!id) return;
    fetch(`${API}/intents/${id}`).then(r => r.json()).then(r => { setIntent(r.intent || null); setLoading(false); }).catch(() => setLoading(false));
  }, [id]);
  return { intent, setIntent, loading };
}

export default function ConfirmPage() {
  const { id } = useParams();
  const { intent, setIntent, loading } = useIntent(id);
  const pollar = (() => { try { return POLLAR_ENABLED ? usePollar() : {}; } catch (e) { return {}; } })();
  const { isAuthenticated, openLoginModal, runTx } = pollar;
  const [err, setErr] = useState('');
  const ISSUER = process.env.NEXT_PUBLIC_POLLAR_USDC_ISSUER;

  if (loading) return <div className="wrap"><Header back /><div className="empty" style={{ paddingTop: 60 }}>Loading…</div></div>;
  if (!intent) return <div className="wrap"><Header back /><div className="empty" style={{ paddingTop: 60 }}>Payment not found.</div></div>;
  if (intent.status === 'executed' || intent.status === 'claimable') return <Success intent={intent} />;

  async function pay() {
    setErr('');
    try {
      let txHash, mode;
      if (POLLAR_ENABLED) {
        const asset = intent.asset_code === 'XLM' ? { type: 'native' } : { type: 'credit_alphanum4', code: 'USDC', issuer: ISSUER };
        const res = await runTx('payment', { destination: intent.dest_address, amount: String(intent.amount), asset });
        txHash = res?.hash || res?.id || res?.txHash || res?.transactionHash; mode = 'pollar';
      }
      const done = await fetch(`${API}/execute`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: intent.id, txHash, mode }),
      }).then(r => r.json());
      if (!done.ok) { setErr(done.error || 'Payment failed'); return; }
      setIntent(done.intent);
    } catch (e) { setErr(e?.message || 'Payment failed'); }
  }

  const needsLogin = POLLAR_ENABLED && !isAuthenticated;

  return (
    <div className="wrap">
      <Header back />
      <div className="confirm-center">
        <div className="lead">You're about to send</div>
        <div className="big-amount">{intent.amount} {intent.asset_code}</div>
      </div>
      <div className="confirm-to center">
        <div className="av">{(intent.dest_handle || '?')[0].toUpperCase()}</div>
        <div className="hn">@{intent.dest_handle}</div>
      </div>
      <div className="feeline"><span>Network fee</span><span className="v">{POLLAR_ENABLED ? '0.00001 XLM · sponsored' : '0.00001 XLM'}</span></div>

      {err && <div className="banner warn" style={{ marginBottom: 14 }}>{err}</div>}

      {needsLogin
        ? <button className="btn block lg" onClick={() => openLoginModal()}>Connect Pollar to sign</button>
        : <SlideToSend label="Slide to Send" onComplete={pay} />}

      <div className="center tiny muted" style={{ marginTop: 16 }}>
        {POLLAR_ENABLED ? 'Signed by your Pollar wallet on Stellar' : 'Demo mode'}
      </div>
    </div>
  );
}
