'use client';
import { useState, useEffect } from 'react';
import { usePollar } from '@pollar/react';
import { useRouter } from 'next/navigation';

// Only rendered when POLLAR_ENABLED (so usePollar is always inside PollarProvider).
export default function PollarWallet() {
  const { isAuthenticated, wallet, openLoginModal, logout, getClient } = usePollar();
  const router = useRouter();
  const [copied, setCopied] = useState(false);

  // On login, record email → Pollar wallet so the bots can resolve it from email.
  useEffect(() => {
    if (!isAuthenticated || !wallet?.address) return;
    try {
      const prof = getClient?.().getUserProfile?.();
      const email = prof?.mail;
      if (!email) return;
      const name = [prof.first_name, prof.last_name].filter(Boolean).join(' ');
      fetch('/pub/tagly/tagly/api/pollar-link', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, address: wallet.address, name }),
      }).catch(() => {});
    } catch (e) {}
  }, [isAuthenticated, wallet?.address, getClient]);

  if (!isAuthenticated) {
    return (
      <button className="btn ghost" style={{ padding: '8px 13px', fontSize: 13 }} onClick={() => router.push('/welcome')}>
        Connect Pollar
      </button>
    );
  }
  const addr = wallet?.address || '';
  const copy = async () => {
    try { await navigator.clipboard.writeText(addr); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch (e) {}
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <button className="btn ghost" style={{ padding: '8px 12px', fontSize: 12.5 }} onClick={copy} title={addr}>
        <span className="mono">{addr.slice(0, 5)}…{addr.slice(-4)}</span> {copied ? '✓ copied' : '⧉'}
      </button>
      {logout && <button className="btn ghost" style={{ padding: '8px 10px', fontSize: 12.5 }} onClick={() => logout()}>⎋</button>}
    </div>
  );
}
