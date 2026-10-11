'use client';
import { useState } from 'react';
import { usePollar } from '@pollar/react';

// Only rendered when POLLAR_ENABLED (so usePollar is always inside PollarProvider).
export default function PollarWallet() {
  const { isAuthenticated, wallet, login, logout } = usePollar();
  const [copied, setCopied] = useState(false);

  if (!isAuthenticated) {
    return (
      <button className="btn ghost" style={{ padding: '8px 13px', fontSize: 13 }} onClick={() => login({ provider: 'google' })}>
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
