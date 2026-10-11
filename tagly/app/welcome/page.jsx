'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePollar } from '@pollar/react';
import Logo from '../Logo';
import { POLLAR_ENABLED } from '../providers';

function usePollarSafe() { try { return POLLAR_ENABLED ? usePollar() : {}; } catch (e) { return {}; } }

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const TAGS = ['tag.', 'kpọọ.', 'fi ọwọ́ kàn.', 'yiwa alama.'];

function Brand() {
  return (
    <div className="auth-brand">
      <div className="row"><Logo size={34} /><span className="wm">Tagly</span></div>
      <p className="tag">Payments, wherever and whenever you <b>tag.</b></p>
    </div>
  );
}

export default function Welcome() {
  const router = useRouter();
  const pollar = usePollarSafe();
  const { isAuthenticated, openLoginModal, getClient, login, configStatus } = pollar;

  const [step, setStep] = useState('splash'); // splash → email → otp
  const [email, setEmail] = useState('');
  const [digits, setDigits] = useState(['', '', '', '', '', '']);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [left, setLeft] = useState(0);
  const [ti, setTi] = useState(0);
  const boxes = useRef([]);
  const verifyTimer = useRef(null);

  // Splash auto-advances; language tagline rotates on the splash.
  useEffect(() => {
    const g = setInterval(() => setTi(i => (i + 1) % TAGS.length), 900);
    const t = setTimeout(() => setStep(s => (s === 'splash' ? 'email' : s)), 1700);
    return () => { clearInterval(g); clearTimeout(t); };
  }, []);

  // Signed in → into the app.
  useEffect(() => {
    if (!isAuthenticated) return;
    if (verifyTimer.current) clearTimeout(verifyTimer.current);
    router.replace('/');
  }, [isAuthenticated]);

  // Resend countdown.
  useEffect(() => {
    if (left <= 0) return;
    const t = setInterval(() => setLeft(l => Math.max(0, l - 1)), 1000);
    return () => clearInterval(t);
  }, [left]);

  const client = () => { try { return getClient?.(); } catch (e) { return null; } };

  async function sendCode(toStep) {
    setErr('');
    const c = client();
    try {
      c?.beginEmailLogin?.();
      c?.sendEmailCode?.(email.trim());
    } catch (e) { /* fall through — resend available */ }
    setLeft(28);
    if (toStep) { setStep('otp'); setTimeout(() => boxes.current[0]?.focus(), 60); }
  }

  // Hand the actual send + OTP to Pollar's real login (their pipeline delivers
  // the code; headless sendEmailCode did not). Branded welcome stays the front.
  function startLogin() {
    setErr('');
    try { openLoginModal?.(); }
    catch (e) { try { login?.({ provider: 'email', email: email.trim() }); } catch (er) {} }
  }
  function submitEmail() {
    const e = email.trim().toLowerCase();
    if (e && !EMAIL_RE.test(e)) { setErr('Enter a valid email address.'); return; }
    startLogin();
  }

  function setDigit(i, v) {
    const only = v.replace(/\D/g, '');
    if (!only && v) return;
    setErr('');
    setDigits(d => { const n = [...d]; n[i] = only.slice(-1); return n; });
    if (only && i < 5) boxes.current[i + 1]?.focus();
  }
  function onPaste(e) {
    const t = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6);
    if (!t) return;
    e.preventDefault();
    const n = ['', '', '', '', '', ''];
    for (let i = 0; i < t.length; i++) n[i] = t[i];
    setDigits(n);
    boxes.current[Math.min(t.length, 5)]?.focus();
  }
  function onKey(i, e) {
    if (e.key === 'Backspace' && !digits[i] && i > 0) boxes.current[i - 1]?.focus();
  }

  async function verify() {
    const code = digits.join('');
    if (code.length < 6) { setErr('Enter the 6-digit code.'); return; }
    setErr(''); setBusy(true);
    const c = client();
    try { c?.verifyEmailCode?.(code); } catch (e) { setErr('That code didn\'t work. Try again.'); setBusy(false); return; }
    // Success flips isAuthenticated (handled above). If it doesn't within a few
    // seconds, the code was wrong/expired.
    if (verifyTimer.current) clearTimeout(verifyTimer.current);
    verifyTimer.current = setTimeout(() => {
      setBusy(false);
      setErr('That code didn\'t work or expired. Check it and try again.');
      setDigits(['', '', '', '', '', '']);
      boxes.current[0]?.focus();
    }, 7000);
  }

  async function google() {
    setErr('');
    try { openLoginModal?.(); } catch (e) { try { login?.({ provider: 'google' }); } catch (er) {} }
  }

  // ---- SPLASH ----
  if (step === 'splash') {
    return (
      <div className="auth splash" onClick={() => setStep('email')}>
        <div className="sp-mid">
          <div className="row big"><Logo size={54} /><span className="wm xl">Tagly</span></div>
          <p className="tag lg">Payments, wherever and whenever you <b key={ti}>{TAGS[ti]}</b></p>
        </div>
        <div className="sp-foot">Social payments powered by <b>Stellar</b>.</div>
      </div>
    );
  }

  const mmss = `00:${String(left).padStart(2, '0')}`;

  // ---- OTP ----
  if (step === 'otp') {
    return (
      <div className="auth">
        <button className="auth-back" onClick={() => { setStep('email'); setErr(''); }} aria-label="Back">‹</button>
        <Brand />
        <div className="auth-body">
          <h1 className="auth-title">Verify your email</h1>
          <p className="auth-sub">We sent a 6-digit code to<br /><b>{email}</b></p>
          <div className="otp" onPaste={onPaste}>
            {digits.map((d, i) => (
              <input key={i} ref={el => boxes.current[i] = el} value={d} inputMode="numeric" maxLength={1}
                onChange={e => setDigit(i, e.target.value)} onKeyDown={e => onKey(i, e)}
                className={err ? 'bad' : ''} />
            ))}
          </div>
          {err && <div className="auth-err">{err}</div>}
          <button className="btn auth-cta" onClick={verify} disabled={busy || digits.join('').length < 6}>
            {busy ? <span className="spin" /> : 'Continue'}
          </button>
          <div className="auth-resend">
            {left > 0 ? <>Resend code in <b>{mmss}</b></> : <button className="linktext" onClick={() => sendCode(false)}>Resend code</button>}
          </div>
        </div>
      </div>
    );
  }

  // ---- EMAIL (Welcome) ----
  return (
    <div className="auth">
      <Brand />
      <div className="auth-body">
        <h1 className="auth-title">Welcome to Tagly</h1>
        <p className="auth-sub">Pay anyone with <b>a simple tag.</b></p>

        <div className="auth-input">
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></svg>
          <input type="email" value={email} placeholder="Email address" autoCapitalize="none" autoComplete="email"
            onChange={e => { setEmail(e.target.value); setErr(''); }} onKeyDown={e => { if (e.key === 'Enter') submitEmail(); }} />
        </div>
        {err && <div className="auth-err">{err}</div>}
        <button className="btn auth-cta" onClick={submitEmail} disabled={busy}>
          {busy ? <span className="spin" /> : 'Continue'}
        </button>

        <div className="auth-or"><span>or</span></div>
        <button className="btn ghost auth-alt" onClick={google}>
          <svg width="17" height="17" viewBox="0 0 24 24"><path fill="#EA4335" d="M12 10.2v3.9h5.5c-.24 1.4-1 2.6-2.1 3.4v2.8h3.4c2-1.85 3.15-4.57 3.15-7.8 0-.72-.06-1.42-.18-2.1H12Z"/><path fill="#34A853" d="M12 22c2.85 0 5.24-.94 6.99-2.55l-3.4-2.8c-.94.63-2.15 1-3.59 1-2.76 0-5.1-1.86-5.94-4.37H2.5v2.9C4.25 19.98 7.86 22 12 22Z"/><path fill="#FBBC05" d="M6.06 13.28c-.21-.63-.34-1.3-.34-2s.12-1.37.34-2V6.38H2.5A9.98 9.98 0 0 0 1.5 11.3c0 1.6.38 3.12 1 4.47l3.56-2.5Z"/><path fill="#4285F4" d="M12 5.5c1.55 0 2.95.53 4.05 1.58l3.02-3.02C17.24 2.3 14.85 1.3 12 1.3 7.86 1.3 4.25 3.32 2.5 6.38l3.56 2.9C6.9 6.76 9.24 5.5 12 5.5Z"/></svg>
          Continue with Google
        </button>
        <div className="auth-links">
          <button className="linktext" onClick={() => { try { openLoginModal?.(); } catch (e) {} }}>More options</button>
          <i>·</i>
          <button className="linktext" onClick={() => router.push('/')}>Explore as guest</button>
        </div>
      </div>

      <div className="auth-foot">By continuing, you agree to the <a href="#" onClick={e => e.preventDefault()}>Terms</a> &amp; <a href="#" onClick={e => e.preventDefault()}>Privacy</a>.</div>
    </div>
  );
}
