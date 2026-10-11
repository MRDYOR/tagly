'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePollar } from '@pollar/react';
import Logo from '../Logo';
import { POLLAR_ENABLED } from '../providers';

const XLM_USD = 0.12;

function Header() {
  return (
    <header className="top">
      <div className="brand">
        <Logo size={30} />
        <div><h1>Tagly</h1></div>
      </div>
    </header>
  );
}

function CoinIcon({ code }) {
  if (code === 'XLM') return <div className="coin" style={{ background: '#111', border: '1px solid #2a2a2a', color: '#fff' }}>✦</div>;
  if (code === 'USDC') return <div className="coin" style={{ background: '#2775CA', color: '#fff' }}>$</div>;
  if (code === 'BTC') return <div className="coin" style={{ background: '#F7931A', color: '#fff' }}>₿</div>;
  return <div className="coin" style={{ background: '#232323', color: '#fff' }}>◆</div>;
}

function WalletInner() {
  const router = useRouter();
  const { isAuthenticated, wallet, openLoginModal } = usePollar();
  const [bal, setBal] = useState({ XLM: '0', USDC: '0' });
  const [copied, setCopied] = useState(false);
  const addr = wallet?.address || '';

  useEffect(() => {
    if (!addr) return;
    fetch(`/pub/tagly/tagly/api/wallet-balance?address=${addr}`).then(r => r.json()).then(d => setBal({ XLM: d.XLM || '0', USDC: d.USDC || '0' }));
  }, [addr]);

  if (!isAuthenticated) {
    return (
      <div className="wrap">
        <Header />
        <div className="empty" style={{ paddingTop: 64 }}>
          <div className="eico"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v1h1a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8Z" /><path d="M17 13h.01" /></svg></div>
          <div className="big">Your Tagly wallet</div>
          Connect Pollar to see your balance, assets, and address — self-custody, always yours.
          <div style={{ marginTop: 20 }}><button className="btn" onClick={() => router.push('/welcome')}>Connect Pollar</button></div>
        </div>
      </div>
    );
  }

  const xlm = parseFloat(bal.XLM) || 0, usdc = parseFloat(bal.USDC) || 0;
  const usd = (xlm * XLM_USD + usdc).toFixed(2);
  const copy = async () => { try { await navigator.clipboard.writeText(addr); setCopied(true); setTimeout(() => setCopied(false), 1400); } catch (e) {} };

  return (
    <div className="wrap">
      <Header />
      <div className="balance-label">Total balance</div>
      <div className="balance">{xlm.toLocaleString(undefined, { maximumFractionDigits: 2 })} <span className="u">XLM</span></div>
      <div className="balance-usd">≈ ${usd}</div>

      <div className="wallet-actions">
        <button className="btn ghost" onClick={copy}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12M7 10l5 5 5-5M5 21h14" /></svg>
          {copied ? 'Copied' : 'Receive'}
        </button>
        <button className="btn" onClick={() => router.push('/')}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M7 17 17 7M8 7h9v9" /></svg>
          Send
        </button>
      </div>

      <div className="addr-card" onClick={copy} style={{ cursor: 'pointer' }}>
        <div>
          <div className="k">Wallet address</div>
          <div className="v">{addr.slice(0, 7)}…{addr.slice(-4)}</div>
        </div>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" strokeWidth="1.7"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>
      </div>

      <div className="assets-head">
        <h2>Assets</h2>
      </div>
      <div className="asset">
        <CoinIcon code="XLM" />
        <div className="nm"><div className="n">Stellar</div><div className="s">XLM</div></div>
        <div className="bal"><div className="b">{xlm.toLocaleString(undefined, { maximumFractionDigits: 2 })} XLM</div><div className="u">≈ ${(xlm * XLM_USD).toFixed(2)}</div></div>
      </div>
      <div className="asset">
        <CoinIcon code="USDC" />
        <div className="nm"><div className="n">USD Coin</div><div className="s">USDC</div></div>
        <div className="bal"><div className="b">{usdc.toFixed(2)} USDC</div><div className="u">≈ ${usdc.toFixed(2)}</div></div>
      </div>
      {['BTC', 'ETH'].map(c => (
        <div className="asset" key={c} style={{ opacity: .55 }}>
          <CoinIcon code={c} />
          <div className="nm"><div className="n">{c === 'BTC' ? 'Bitcoin' : 'Ethereum'}</div><div className="s">{c}</div></div>
          <div className="bal"><span className="soon">Soon</span></div>
        </div>
      ))}
    </div>
  );
}

function SimWallet() {
  return (
    <div className="wrap">
      <Header />
      <div className="empty" style={{ paddingTop: 80 }}><div className="big">Wallet</div>Live wallet appears once Pollar is enabled.</div>
    </div>
  );
}

export default function WalletPage() {
  return POLLAR_ENABLED ? <WalletInner /> : <SimWallet />;
}
