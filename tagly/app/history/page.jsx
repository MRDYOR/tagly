'use client';
import { useEffect, useState } from 'react';
import Logo from './../Logo';
import { useRouter } from 'next/navigation';

function when(ts) {
  if (!ts) return '';
  const d = new Date(ts.replace(' ', 'T') + 'Z');
  const now = new Date();
  const day = d.toDateString() === now.toDateString() ? 'Today'
    : d.toDateString() === new Date(now - 86400000).toDateString() ? 'Yesterday'
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${day}, ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

export default function Activity() {
  const router = useRouter();
  const [author, setAuthor] = useState('you');
  const [items, setItems] = useState(null);
  useEffect(() => {
    const a = localStorage.getItem('tagly_author') || 'you';
    setAuthor(a);
    fetch(`/pub/tagly/tagly/api/intents?author=${encodeURIComponent(a)}`).then(r => r.json()).then(r => setItems(r.intents || [])).catch(() => setItems([]));
  }, []);

  return (
    <div className="wrap">
      <header className="top">
        <div className="brand">
          <Logo size={30} />
          <div><h1>Tagly</h1></div>
        </div>
        <button className="iconbtn" onClick={() => router.push('/profile')} aria-label="Profile">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="8" r="4" /><path d="M5 20a7 7 0 0 1 14 0" strokeLinecap="round" /></svg>
        </button>
      </header>

      <h1 className="h1">Activity</h1>
      <p className="sub">Your recent payments and requests.</p>

      {items === null && [0, 1, 2].map(i => (
        <div className="row" key={i} style={{ pointerEvents: 'none' }}>
          <div className="avatar sk" />
          <div className="mid"><div className="sk-line w40" /><div className="sk-line w70" style={{ marginTop: 8 }} /></div>
          <div className="sk-pill" />
        </div>
      ))}

      {items?.length === 0 && (
        <div className="empty" style={{ paddingTop: 54 }}>
          <div className="eico"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M22 2 11 13M22 2 15 22l-4-9-9-4 20-7Z" /></svg></div>
          <div className="big">No activity yet</div>
          Your sends, requests and splits will show up here.
          <div style={{ marginTop: 18 }}><button className="btn" onClick={() => router.push('/')}>Send your first payment</button></div>
        </div>
      )}

      {(items || []).map(it => {
        const received = it.dest_handle === author;
        const other = received ? it.source_handle : it.dest_handle;
        const executed = it.status === 'executed';
        return (
          <div className="row" key={it.id} onClick={() => router.push(`/confirm/${it.id}`)} style={{ cursor: 'pointer' }}>
            <div className={`avatar ${received ? 'g' : ''}`}>{(other || '?')[0].toUpperCase()}</div>
            <div className="mid">
              <div className="who">@{other}</div>
              <div className="when">{when(it.created_at)}</div>
            </div>
            <div>
              <div className={`amt ${received ? 'in' : ''}`}>{received ? '+ ' : '– '}{it.amount} {it.asset_code}</div>
              <div className={`dir ${received ? 'in' : ''}`}>
                {received
                  ? <><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg> {executed ? 'Received' : it.status}</>
                  : <><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg> {executed ? 'Sent' : it.status}</>}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
