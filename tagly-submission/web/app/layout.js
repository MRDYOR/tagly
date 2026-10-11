import './globals.css';
import Providers from './providers';

const SITE = 'https://build-09bde00a7f107c4fb75cfe3c.emblem.build';
const OG = `${SITE}/pub/tagly/tagly/og.png`;

export const metadata = {
  metadataBase: new URL(SITE),
  title: 'Tagly — Tag someone. Pay them.',
  description: 'Tag a friend on social media, Tagly reads the command and settles the payment on Pollar (Stellar USDC). Agentic payments with one-tap human confirmation.',
  openGraph: {
    title: 'Tagly — Tag someone. Pay them.',
    description: 'Tag a friend on social media, Tagly reads the command and settles the payment on Pollar (Stellar USDC).',
    url: `${SITE}/pub/tagly/tagly/`,
    type: 'website',
    images: [{ url: OG, width: 1200, height: 630, alt: 'Tagly' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Tagly — Tag someone. Pay them.',
    description: 'Agentic social payments on Pollar (Stellar USDC).',
    images: [OG],
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head />
      <body>
        <Providers>{children}</Providers>
        <script src="/__nanoclaw/toolbar.js" />
      </body>
    </html>
  );
}
