// Render the iOS icon artwork at Apple's 1024px app-icon size.
// Requires the AI Gateway's Playwright dependency and Chromium.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
const { chromium } = createRequire(new URL('../../../workers/ai-gateway/package.json', import.meta.url))('playwright-core');
const source = await readFile(new URL('../artwork/app-icon.svg', import.meta.url), 'utf8');
// The OS supplies the app icon's corner mask; remove the mask from the source artwork.
const svg = source.replace('rx="40"', '');
const directory = new URL('../KakeiMatch/Assets.xcassets/AppIcon.appiconset/', import.meta.url);
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ headless: true,
  ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
  await page.setContent(`<style>html,body{margin:0}svg{display:block;width:1024px;height:1024px}</style>${svg}`);
  await writeFile(new URL('AppIcon.png', directory), await page.screenshot());
  await writeFile(new URL('Contents.json', directory), JSON.stringify({
    images: [{ filename: 'AppIcon.png', idiom: 'universal', platform: 'ios', size: '1024x1024' }],
    info: { author: 'xcode', version: 1 },
  }, null, 2) + '\n');
} finally {
  await browser.close();
}
