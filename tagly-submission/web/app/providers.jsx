'use client';
import { PollarProvider } from '@pollar/react';

const KEY = process.env.NEXT_PUBLIC_POLLAR_PUBLISHABLE_KEY;
export const POLLAR_ENABLED = !!KEY;

// When a Pollar publishable key is present we mount the real provider (live
// Stellar USDC payments). Otherwise the app runs in simulated testnet mode so
// the full flow is always demoable. Flip modes by setting the env var + rebuild.
export default function Providers({ children }) {
  if (!KEY) return children;
  return (
    <PollarProvider client={{ apiKey: KEY, stellarNetwork: 'testnet' }}>
      {children}
    </PollarProvider>
  );
}
