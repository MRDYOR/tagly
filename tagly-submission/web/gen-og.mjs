import fs from 'fs';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';

const reg = fs.readFileSync('/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf');
const bold = fs.readFileSync('/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf');

const node = {
  type: 'div',
  props: {
    style: {
      width: '1200px', height: '630px', display: 'flex', flexDirection: 'column',
      justifyContent: 'space-between', padding: '70px',
      background: 'linear-gradient(135deg, #0a0910 0%, #1a1030 55%, #0a2018 100%)',
      color: '#ece9f5', fontFamily: 'Liberation',
    },
    children: [
      { type: 'div', props: { style: { display: 'flex', alignItems: 'center', gap: '22px' },
        children: [
          { type: 'div', props: { style: { width: '86px', height: '86px', borderRadius: '24px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '52px', fontWeight: 700, color: '#0a0910', background: 'linear-gradient(135deg,#a855f7,#34e5b6)' }, children: '◎' } },
          { type: 'div', props: { style: { fontSize: '46px', fontWeight: 700 }, children: 'Tagly' } },
        ] } },
      { type: 'div', props: { style: { display: 'flex', flexDirection: 'column', gap: '18px' },
        children: [
          { type: 'div', props: { style: { fontSize: '82px', fontWeight: 700, lineHeight: 1.05, letterSpacing: '-2px' }, children: 'Tag someone.' } },
          { type: 'div', props: { style: { fontSize: '82px', fontWeight: 700, lineHeight: 1.05, letterSpacing: '-2px', color: '#34e5b6' }, children: 'Pay them.' } },
          { type: 'div', props: { style: { fontSize: '30px', color: '#b3aecb', marginTop: '8px' }, children: 'Agentic social payments · Pollar · Stellar USDC' } },
        ] } },
      { type: 'div', props: { style: { display: 'flex', alignItems: 'center', gap: '14px', fontSize: '26px', color: '#c084fc' },
        children: [
          { type: 'div', props: { style: { background: 'rgba(168,85,247,0.18)', border: '1px solid rgba(168,85,247,0.4)', borderRadius: '999px', padding: '10px 22px', color: '#c084fc' }, children: '@tagly send 5 USDC to @alice' } },
        ] } },
    ],
  },
};

const svg = await satori(node, {
  width: 1200, height: 630,
  fonts: [
    { name: 'Liberation', data: reg, weight: 400, style: 'normal' },
    { name: 'Liberation', data: bold, weight: 700, style: 'normal' },
  ],
});
const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } }).render().asPng();
fs.mkdirSync('public', { recursive: true });
fs.writeFileSync('public/og.png', png);
console.log('og.png written:', png.length, 'bytes');
