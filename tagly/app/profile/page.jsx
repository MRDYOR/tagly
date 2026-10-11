'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePollar } from '@pollar/react';
import Logo from '../Logo';
import { POLLAR_ENABLED } from '../providers';

const Ico = ({ d }) => <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>;
const Chev = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>;

function usePollarSafe() {
  try { return usePollar(); } catch (e) { return {}; }
}

export default function Profile() {
  const router = useRouter();
  const pollar = POLLAR_ENABLED ? usePollarSafe() : {};
  const { isAuthenticated, wallet, logout, getClient } = pollar;
  const [author, setAuthor] = useState('you');
  const [named, setNamed] = useState(false);
  const [avatar, setAvatar] = useState('');
  const [editing, setEditing] = useState(false);
  const fileRef = useRef(null);
  const email = (() => { try { return getClient?.().getUserProfile?.()?.mail; } catch (e) { return null; } })();

  useEffect(() => {
    const a = localStorage.getItem('tagly_author');
    if (a && a !== 'you') { setAuthor(a); setNamed(true); }
    setAvatar(localStorage.getItem('tagly_avatar') || '');
  }, []);
  const saveHandle = (v) => { const h = v.replace(/^@/, '').toLowerCase(); if (!h) return; setAuthor(h); setNamed(true); localStorage.setItem('tagly_author', h); };

  async function pickImage(e) {
    const file = e.target.files?.[0]; if (!file) return;
    const dataUrl = await new Promise((res) => {
      const rd = new FileReader();
      rd.onload = () => { const img = new Image(); img.onload = () => { const max = 240, s = Math.min(1, max / Math.max(img.width, img.height)); const c = document.createElement('canvas'); c.width = img.width * s; c.height = img.height * s; c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); res(c.toDataURL('image/jpeg', 0.85)); }; img.src = rd.result; };
      rd.readAsDataURL(file);
    });
    setAvatar(dataUrl);
    try { localStorage.setItem('tagly_avatar', dataUrl); } catch (er) {}
  }
  const authed = POLLAR_ENABLED ? !!isAuthenticated : true;
  const name = (named && authed) ? `@${author}` : 'Guest';

  return (
    <div className="wrap">
      <header className="top">
        <div className="brand">
          <Logo size={30} />
          <div><h1>Tagly</h1></div>
        </div>
      </header>

      <div className="profile-top">
        <input ref={fileRef} type="file" accept="image/*" onChange={pickImage} style={{ display: 'none' }} />
        <div className="av" onClick={() => fileRef.current?.click()} style={avatar ? { padding: 0, overflow: 'hidden', cursor: 'pointer' } : { cursor: 'pointer' }}>
          {(authed && avatar) ? <img src={avatar} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} /> : ((authed && named) ? author[0].toUpperCase() : '👤')}
          <span className="edit"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg></span>
        </div>
        <div className="h">{name}</div>
        <div className="n">{email || 'Tap the photo to upload · Personal Information to set your handle'}</div>
      </div>

      <div className="menu">
        <div className="item" onClick={() => setEditing(!editing)}>
          <div className="ico"><Ico d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM5 20a7 7 0 0 1 14 0" /></div>
          <div className="mid"><div className="t">Personal Information</div><div className="d">Your @handle & details</div></div>
          <div className="chev"><Chev /></div>
        </div>
        {editing && (
          <div style={{ padding: '4px 2px 14px' }}>
            <input className="input" defaultValue={author} placeholder="yourhandle" onBlur={e => { saveHandle(e.target.value); setEditing(false); }} onKeyDown={e => { if (e.key === 'Enter') { saveHandle(e.target.value); setEditing(false); } }} autoFocus />
          </div>
        )}

        <div className="item" onClick={() => router.push('/wallet')}>
          <div className="ico"><Ico d="M3 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v1h1a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8Z" /></div>
          <div className="mid"><div className="t">Wallet</div><div className="d">{wallet?.address ? `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}` : 'Manage your wallet & assets'}</div></div>
          <div className="chev"><Chev /></div>
        </div>

        <div className="item" onClick={() => router.push('/connected')}>
          <div className="ico"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 17H7A5 5 0 0 1 7 7h2M15 7h2a5 5 0 0 1 0 10h-2M8 12h8" /></svg></div>
          <div className="mid"><div className="t">Connected accounts</div><div className="d">Pollar · email · Telegram · Discord · X</div></div>
          <div className="chev"><Chev /></div>
        </div>

        <div className="item" style={{ opacity: .55 }}>
          <div className="ico"><Ico d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3Z" /></div>
          <div className="mid"><div className="t">Security</div><div className="d">Biometrics & 2FA — coming soon</div></div>
          <span className="soon">Soon</span>
        </div>

        <div className="item" style={{ opacity: .55 }}>
          <div className="ico"><Ico d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" /></div>
          <div className="mid"><div className="t">Notifications</div><div className="d">Delivered in the Telegram/Discord bots</div></div>
          <span className="soon">Bots</span>
        </div>

        <div className="item" onClick={() => router.push('/help')}>
          <div className="ico"><Ico d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM9.5 9a2.5 2.5 0 0 1 4.5 1.5c0 1.5-2 2-2 3M12 17h.01" /></div>
          <div className="mid"><div className="t">Help & About</div><div className="d">How Tagly works</div></div>
          <div className="chev"><Chev /></div>
        </div>

        {POLLAR_ENABLED && isAuthenticated && logout && (
          <div className="item danger" onClick={() => { try { logout(); } catch (e) {} router.push('/'); }}>
            <div className="ico" style={{ color: 'var(--red)' }}><Ico d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></div>
            <div className="mid"><div className="t">Logout</div><div className="d">Sign out of Pollar</div></div>
            <div className="chev"><Chev /></div>
          </div>
        )}
      </div>
    </div>
  );
}
