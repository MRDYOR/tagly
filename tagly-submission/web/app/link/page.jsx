'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';

export default function LinkWallet() {
  const [handle, setHandle] = useState('');
  const [address, setAddress] = useState('');
  const [platform, setPlatform] = useState('sim');
  const [msg, setMsg] = useState(null);
  const [ids, setIds] = useState([]);

  async function load() {
    const r = await fetch('api/identities').then(r => r.json());
    setIds(r.identities || []);
  }
  useEffect(() => { load(); }, []);

  async function save() {
    setMsg(null);
    const r = await fetch('api/identities', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform, handle, address, displayName: handle }),
    }).then(r => r.json());
    if (!r.ok) setMsg({ warn: true, text: r.error });
    else { setMsg({ warn: false, text: `Linked @${handle} → ${address.slice(0, 8)}…` }); setHandle(''); setAddress(''); load(); }
  }

  return (
    <div className="wrap">
      <header className="top">
        <Link href="/" className="brand" style={{ textDecoration: 'none' }}>
          <div className="logo">◎</div>
          <div><h1>Tagly</h1><div className="tag">link a handle to a wallet</div></div>
        </Link>
        <nav className="nav"><Link href="/">Feed</Link><Link href="/history">History</Link></nav>
      </header>

      <div className="banner ok">
        Link a social handle to a real Stellar (Pollar) <span className="mono">G…</span> address. Verified links take priority over Tagly's simulated demo addresses.
      </div>

      <div className="card pad">
        <label className="fld">Platform</label>
        <select className="input" value={platform} onChange={e => setPlatform(e.target.value)}>
          <option value="sim">Simulated feed</option>
          <option value="telegram">Telegram</option>
          <option value="x">X (Twitter)</option>
          <option value="whatsapp">WhatsApp</option>
          <option value="instagram">Instagram</option>
        </select>
        <label className="fld">Handle</label>
        <input className="input" placeholder="alice" value={handle} onChange={e => setHandle(e.target.value.replace(/^@/, ''))} />
        <label className="fld">Stellar address</label>
        <input className="input mono" placeholder="G..." value={address} onChange={e => setAddress(e.target.value.trim())} />
        {msg && <div className={`banner ${msg.warn ? 'warn' : 'ok'}`} style={{ marginTop: 14, marginBottom: 0 }}>{msg.warn ? '⚠️ ' : '✓ '}{msg.text}</div>}
        <button className="btn block" style={{ marginTop: 16 }} onClick={save}>Link wallet</button>
      </div>

      <h3 style={{ margin: '18px 0 10px', fontSize: 15, color: 'var(--muted2)' }}>Linked identities</h3>
      {ids.length === 0 && <div className="empty">Nothing linked yet.</div>}
      {ids.map(i => (
        <div className="card" key={i.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontWeight: 700 }}>@{i.handle} <span className="tiny muted">· {i.platform}</span></div>
            <div className="tiny mono muted" style={{ wordBreak: 'break-all' }}>{i.pollar_address}</div>
          </div>
          <span className={`status ${i.verified ? 'executed' : 'pending'}`}>{i.verified ? 'linked' : 'demo'}</span>
        </div>
      ))}
    </div>
  );
}
