import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

// Server-side read of a Stellar testnet account's balances (proxies Horizon).
export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const addr = searchParams.get('address') || '';
  if (!/^G[A-Z2-7]{55}$/.test(addr)) return NextResponse.json({ ok: false, XLM: '0', USDC: '0' });
  try {
    const r = await fetch(`https://horizon-testnet.stellar.org/accounts/${addr}`, { cache: 'no-store' });
    if (!r.ok) return NextResponse.json({ ok: r.status === 404 ? false : true, exists: r.status !== 404, XLM: '0', USDC: '0' });
    const d = await r.json();
    let XLM = '0', USDC = '0';
    for (const b of d.balances || []) {
      if (b.asset_type === 'native') XLM = b.balance;
      else if (b.asset_code === 'USDC' && b.asset_issuer === USDC_ISSUER) USDC = b.balance;
    }
    return NextResponse.json({ ok: true, exists: true, XLM, USDC });
  } catch (e) {
    return NextResponse.json({ ok: false, XLM: '0', USDC: '0' });
  }
}
