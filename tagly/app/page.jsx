'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Logo from './Logo';
import { POLLAR_ENABLED } from './providers';
import PollarWallet from './PollarWallet';
import { usePollar } from '@pollar/react';

function usePollarSafe() { try { return usePollar(); } catch (e) { return {}; } }

const EXAMPLES = [
  '@tagly send 5 XLM to @alice',
  '@tagly tip @bob 2 XLM',
  '@tagly split 30 XLM with @carol @dave @erin',
];

// Time-appropriate greetings across English + Igbo + Yoruba + Hausa.
const GREET = {
  morning: ['Good morning', 'Ụtụtụ ọma', 'Ẹ káàárọ̀', 'Barka da safiya'],
  afternoon: ['Good afternoon', 'Ehihie ọma', 'Ẹ káàsán', 'Barka da rana'],
  evening: ['Good evening', 'Mgbede ọma', 'Ẹ kúùrọ̀lẹ́', 'Barka da yamma'],
};
function period() { const h = new Date().getHours(); return h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening'; }

export default function Home() {
  const router = useRouter();
  const [author, setAuthor] = useState('you');
  const [named, setNamed] = useState(false);
  const [avatar, setAvatar] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [gi, setGi] = useState(0);
  const greetings = GREET[period()];
  const pollar = POLLAR_ENABLED ? usePollarSafe() : {};
  // When Pollar is on, your identity follows your session: log out → Guest.
  const authed = POLLAR_ENABLED ? !!pollar.isAuthenticated : true;

  useEffect(() => {
    const a = localStorage.getItem('tagly_author');
    if (a && a !== 'you') { setAuthor(a); setNamed(true); }
    setAvatar(localStorage.getItem('tagly_avatar') || '');
    const t = setInterval(() => setGi(i => (i + 1) % greetings.length), 2800);
    return () => clearInterval(t);
  }, []);

  const name = (named && authed) ? `@${author}` : 'Guest';

  async function send() {
    if (!text.trim()) return;
    setBusy(true); setErr('');
    try {
      const r = await fetch('/pub/tagly/tagly/api/parse', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, author, platform: 'sim' }),
      }).then(r => r.json());
      if (!r.ok || !r.intents?.length) { setErr(r.error || 'Try "@tagly send 5 XLM to @alice"'); setBusy(false); return; }
      router.push(`/confirm/${r.intents[0].id}`);
    } catch (e) { setErr(e.message); setBusy(false); }
  }

  return (
    <div className="wrap">
      <header className="top">
        <div className="brand">
          <Logo size={30} />
          <div>
            <h1>Tagly</h1>
            
          </div>
        </div>
        {POLLAR_ENABLED ? <PollarWallet /> : (
          <button className="iconbtn" onClick={() => router.push('/profile')} aria-label="Profile" style={avatar ? { padding: 0, overflow: 'hidden' } : {}}>
            {avatar ? <img src={avatar} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              : <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="8" r="4" /><path d="M5 20a7 7 0 0 1 14 0" strokeLinecap="round" /></svg>}
          </button>
        )}
      </header>

      <h2 className="greet">
        <span key={gi} className="greet-word">{greetings[gi]},</span><br /><span className="at">{name}</span>
      </h2>

      <div className="cmdbox">
        <span className="spark">✦</span>
        <input
          placeholder="@tagly send 10 XLM to @alice"
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') send(); }}
        />
        <button className={`go ${text.trim() ? 'ready' : ''}`} onClick={send} disabled={busy || !text.trim()} aria-label="Send">
          {busy ? <span className="spin" /> : <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 2 11 13M22 2 15 22l-4-9-9-4 20-7Z" /></svg>}
        </button>
      </div>
      {err && <div className="banner warn" style={{ marginTop: 12 }}>{err}</div>}
      <div className="chips">
        {EXAMPLES.map(ex => <span key={ex} className="chip" onClick={() => setText(ex)}>{ex}</span>)}
      </div>

      <div className="label">Quick actions</div>
      <div className="quick">
        <div className="qa" onClick={() => setText('@tagly send  to @')}>
          <div className="ico"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M22 2 11 13M22 2 15 22l-4-9-9-4 20-7Z" /></svg></div>
          <div className="t">Send</div>
        </div>
        <div className="qa" onClick={() => setText('@tagly request  from @')}>
          <div className="ico"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M6 13l6 6 6-6" /></svg></div>
          <div className="t">Request</div>
        </div>
        <div className="qa" onClick={() => setText('@tagly split  with @ @')}>
          <div className="ico"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="8" r="3.2" /><path d="M3.5 20a5.5 5.5 0 0 1 11 0" /><path d="M16 6.2a3 3 0 0 1 0 5.6M18 20a5.5 5.5 0 0 0-3-4.9" /></svg></div>
          <div className="t">Split Bill</div>
        </div>
      </div>
    </div>
  );
}
