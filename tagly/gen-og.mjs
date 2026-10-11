import fs from 'fs';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';

const reg = fs.readFileSync('/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf');
const bold = fs.readFileSync('/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf');
const logoSrc = 'data:image/png;base64,' + fs.readFileSync('public/logo.png').toString('base64');

const node = {
  type: 'div',
  props: {
    style: {
      width: '1200px', height: '630px', display: 'flex', flexDirection: 'column',
      justifyContent: 'space-between', padding: '76px',
      background: '#070707', color: '#ffffff', fontFamily: 'L',
    },
    children: [
      { type: 'div', props: { style: { display: 'flex', alignItems: 'center', gap: '20px' },
        children: [
          { type: 'img', props: { src: logoSrc, width: 94, height: 90 } },
          { type: 'div', props: { style: { fontSize: '44px', fontWeight: 700, letterSpacing: '-1px' }, children: 'Tagly' } },
        ] } },
      { type: 'div', props: { style: { display: 'flex', flexDirection: 'column', gap: '14px' },
        children: [
          { type: 'div', props: { style: { fontSize: '86px', fontWeight: 700, lineHeight: 1.02, letterSpacing: '-3px', maxWidth: '900px' }, children: 'Payments, wherever' } },
          { type: 'div', props: { style: { display: 'flex', fontSize: '86px', fontWeight: 700, lineHeight: 1.02, letterSpacing: '-3px' }, children: [
            { type: 'span', props: { children: 'and whenever you ' } },
            { type: 'span', props: { style: { color: '#22c55e' }, children: 'tag' } },
            { type: 'span', props: { children: '.' } },
          ] } },
        ] } },
      { type: 'div', props: { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
        children: [
          { type: 'div', props: { style: { fontSize: '27px', color: '#22c55e', background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.4)', borderRadius: '999px', padding: '12px 26px' }, children: '@tagly send 5 XLM to @alice' } },
          { type: 'div', props: { style: { fontSize: '23px', color: '#8b8b8f' }, children: 'Telegram · Discord · X · Stellar' } },
        ] } },
    ],
  },
};

const svg = await satori(node, {
  width: 1200, height: 630,
  fonts: [
    { name: 'L', data: reg, weight: 400, style: 'normal' },
    { name: 'L', data: bold, weight: 700, style: 'normal' },
  ],
});
const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } }).render().asPng();
fs.mkdirSync('public', { recursive: true });
fs.writeFileSync('public/og.png', png);
console.log('og.png written:', png.length, 'bytes');
