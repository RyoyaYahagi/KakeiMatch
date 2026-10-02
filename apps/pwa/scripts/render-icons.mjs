// Renders the home screen icons (docs/DESIGN.md ホーム画面のアイコン, design B: card and receipt).
// Usage: corepack pnpm --dir apps/pwa icons
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const publicDir = new URL('../public/', import.meta.url);
const BACKGROUND = '#FFF3DD';

// Drawn on a 180px grid. The receipt sits slightly right of center, so the art is nudged left by 5px.
const ART = `
  <g transform="translate(5 0)">
    <g transform="rotate(-10 72 98)">
      <rect x="26" y="66" width="96" height="64" rx="10" fill="#0B7A68"/>
      <rect x="26" y="80" width="96" height="12" fill="#06584A"/>
      <rect x="38" y="106" width="28" height="8" rx="4" fill="#BFE3D9"/>
    </g>
    <path d="M82 36h66v104l-11-7.5-11 7.5-11-7.5-11 7.5-11-7.5-11 7.5z" fill="#FFFFFF" stroke="#D9661F" stroke-width="5" stroke-linejoin="round"/>
    <path d="M100 92l11 11 22-24" fill="none" stroke="#0B7A68" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>
  </g>`;

/** rounded: transparent corners for "any" icons. scale: shrinks the art for the maskable safe zone (inner 80% circle). */
function iconSvg({ rounded, scale = 1 }) {
  const background = rounded ? `<rect width="180" height="180" rx="40" fill="${BACKGROUND}"/>` : `<rect width="180" height="180" fill="${BACKGROUND}"/>`;
  const art = scale === 1 ? ART : `<g transform="translate(90 90) scale(${scale}) translate(-90 -90)">${ART}</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180">${background}${art}</svg>`;
}

const outputs = [
  { file: 'apple-touch-icon.png', size: 180, svg: iconSvg({ rounded: false }) },
  { file: 'icon-192.png', size: 192, svg: iconSvg({ rounded: true }) },
  { file: 'icon-512.png', size: 512, svg: iconSvg({ rounded: true }) },
  { file: 'icon-maskable-512.png', size: 512, svg: iconSvg({ rounded: false, scale: 0.84 }) },
];

await writeFile(new URL('icon.svg', publicDir), `${iconSvg({ rounded: true })}\n`);
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}) });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const { file, size, svg } of outputs) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
    await writeFile(new URL(file, publicDir), await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } }));
    console.log(`wrote public/${file} (${size}x${size})`);
  }
} finally {
  await browser.close();
}
