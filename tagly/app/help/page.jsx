'use client';
import { useRouter } from 'next/navigation';
import Logo from '../Logo';

function Header() {
  const router = useRouter();
  return (
    <header className="top">
      <button className="backbtn" onClick={() => router.push('/profile')} aria-label="Back">‹</button>
      <div className="brand" style={{ margin: '0 auto' }}><Logo size={26} /><div><h1 style={{ fontSize: 20 }}>Tagly</h1></div></div>
      <div style={{ width: 26 }} />
    </header>
  );
}

const FAQ = [
  { q: 'How do I send money?', a: 'Tag Tagly and say what you want — e.g. “@tagly send 5 XLM to @alice”. Tagly reads it, you confirm with a slide, and it settles on Stellar.' },
  { q: 'What can I send?', a: 'XLM and USDC on Stellar. USDC is the real Circle testnet asset, so it works with Pollar wallets and exchanges.' },
  { q: 'Do recipients need a wallet?', a: 'No. Pay any handle — if they don’t have a wallet yet, it’s held and lands automatically when they onboard (account abstraction).' },
  { q: 'Web app vs the bots?', a: 'The web app signs with your self-custody Pollar wallet. The Telegram/Discord bots use a custodial wallet for instant in-chat payments. Cash out between them anytime.' },
  { q: 'Is it live money?', a: 'This is Stellar testnet — no real funds. The same flow runs on mainnet with real USDC.' },
];

export default function Help() {
  const router = useRouter();
  return (
    <div className="wrap"><Header />
      <h1 className="h1" style={{ fontSize: 28 }}>Help & About</h1>
      <p className="sub">Tag someone, pay them. Here’s how it works.</p>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}><Logo size={26} /><b style={{ fontSize: 17 }}>Tagly</b></div>
        <div className="muted small">Payments, wherever and whenever you tag — an AI agent that turns a social-media mention into a payment, settled on Stellar and powered by Pollar.</div>
      </div>

      {FAQ.map((f, i) => (
        <div key={i} style={{ padding: '15px 2px', borderBottom: '1px solid var(--line)' }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{f.q}</div>
          <div className="muted small" style={{ marginTop: 5 }}>{f.a}</div>
        </div>
      ))}

      <div className="label" style={{ marginTop: 24 }}>Get Tagly</div>
      <div className="stack">
        <a className="btn ghost block" href="https://t.me/Taglypay_bot" target="_blank" rel="noreferrer">Telegram bot ↗</a>
        <a className="btn ghost block" href="https://discord.com/oauth2/authorize?client_id=1550355068526534697&scope=bot%20applications.commands&permissions=85056" target="_blank" rel="noreferrer">Add to Discord ↗</a>
        <a className="btn ghost block" href="https://github.com/MRDYOR/tagly" target="_blank" rel="noreferrer">Source on GitHub ↗</a>
      </div>

      <div className="center muted tiny" style={{ marginTop: 26 }}>Tagly · Social payments on Stellar · testnet</div>
    </div>
  );
}
