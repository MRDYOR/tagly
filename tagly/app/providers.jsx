'use client';
import { PollarProvider } from '@pollar/react';

const KEY = process.env.NEXT_PUBLIC_POLLAR_PUBLISHABLE_KEY;
export const POLLAR_ENABLED = !!KEY;

// When a Pollar publishable key is present we mount the real provider (live
// Stellar USDC payments). Otherwise the app runs in simulated testnet mode so
// the full flow is always demoable. Flip modes by setting the env var + rebuild.
// OAuth returns to window.location.origin by default — but our app lives under a
// basePath, so the popup would land on the bare domain root (no SDK) and hang on a
// blank page. Pin the redirect back to THIS app so the SDK catches the callback.
const APP_URL = 'https://build-09bde00a7f107c4fb75cfe3c.emblem.build/pub/tagly/tagly/';

export default function Providers({ children }) {
  if (!KEY) return children;
  return (
    <PollarProvider client={{ apiKey: KEY, stellarNetwork: 'testnet', oauthRedirectUri: APP_URL }}>
      {children}
    </PollarProvider>
  );
}
