'use client';
import { usePathname, useRouter } from 'next/navigation';

const TABS = [
  { href: '/', label: 'Home', icon: 'M3 11.5 12 4l9 7.5M5 10v9h5v-6h4v6h5v-9' },
  { href: '/history', label: 'Activity', icon: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z' },
  { href: '/wallet', label: 'Wallet', icon: 'M3 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v1h1a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8Zm14 4h.01' },
  { href: '/profile', label: 'Profile', icon: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM5 20a7 7 0 0 1 14 0' },
];

export default function TabBar() {
  const path = usePathname() || '/';
  const router = useRouter();
  const active = (href) => (href === '/' ? path === '/' : path.startsWith(href));
  // hide the tab bar on the full-screen confirm + welcome flows
  if (path.startsWith('/confirm') || path.startsWith('/welcome')) return null;
  return (
    <nav className="tabbar">
      {TABS.map(t => (
        <button key={t.href} className={`tab ${active(t.href) ? 'active' : ''}`} onClick={() => router.push(t.href)}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d={t.icon} /></svg>
          {t.label}
        </button>
      ))}
    </nav>
  );
}
