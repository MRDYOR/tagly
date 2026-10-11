'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';

export default function History() {
  const [intents, setIntents] = useState([]);
  const [author, setAuthor] = useState('you');
  useEffect(() => {
    const a = localStorage.getItem('tagly_author') || 'you';
    setAuthor(a);
    fetch(`api/intents?author=${encodeURIComponent(a)}`).then(r => r.json()).then(r => setIntents(r.intents || []));
  }, []);
  const executed = intents.filter(i => i.status === 'executed');
  const volume = executed.reduce((s, i) => s + (i.asset_code === 'USDC' ? parseFloat(i.amount || 0) : 0), 0);

  return (
    <div className="wrap">
      <header className="top">
        <Link href="/" className="brand" style={{ textDecoration: 'none' }}>
          <div className="logo">◎</div>
          <div><h1>Tagly</h1><div className="tag">payment history</div></div>
        </Link>
        <nav className="nav"><Link href="/">Feed</Link><Link href="/link">Link wallet</Link></nav>
      </header>

      <div className="card pad" style={{ display: 'flex', justifyContent: 'space-around', textAlign: 'center' }}>
        <div><div className="big-amount" style={{ fontSize: 30 }}>{executed.length}</div><div className="muted small">payments</div></div>
        <div><div className="big-amount" style={{ fontSize: 30 }}>{volume.toFixed(2)}<span className="asset" style={{ fontSize: 18 }}> USDC</span></div><div className="muted small">settled volume</div></div>
        <div><div className="big-amount" style={{ fontSize: 30 }}>{intents.filter(i => i.status === 'pending').length}</div><div className="muted small">pending</div></div>
      </div>

      {intents.length === 0 && <div className="empty">No payments yet.</div>}

      {intents.map(i => (
        <div className="card" key={i.id}>
          <div className="intent" style={{ margin: 0, border: 'none', padding: 0, background: 'none' }}>
            <div className="line">
              <div>
                <div className="amt">{i.amount} <span className="asset">{i.asset_code}</span></div>
                <div className="to">@{i.source_handle} → @{i.dest_handle} · {i.action}</div>
              </div>
              <span className={`status ${i.status}`}>{i.status}</span>
            </div>
            {i.tx_hash && <div className="tiny muted mono" style={{ marginTop: 8, wordBreak: 'break-all' }}>{i.tx_hash}</div>}
            {(i.status === 'pending' || i.status === 'authorized') && <Link href={`/confirm/${i.id}`} className="small">Continue →</Link>}
            {i.status === 'claimable' && <Link href={`/claim?handle=${i.dest_handle}`} className="small">Awaiting @{i.dest_handle} →</Link>}
          </div>
        </div>
      ))}
    </div>
  );
}
