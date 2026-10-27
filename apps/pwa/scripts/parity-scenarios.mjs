import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const url = process.env.PWA_E2E_URL;
if (!url || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) {
  throw new Error('PWA_E2E_URL にローカルの合成データ専用 PWA を指定してください。');
}
const root = new URL('../../../', import.meta.url);
const fixtureUrl = new URL('test/fixtures/ios-migration/synthetic.kmb', root);
const scenariosUrl = new URL('test/fixtures/ios-parity/scenarios.json', root);
const outputRoot = new URL('test/fixtures/ios-parity/', root);
const scenarios = JSON.parse(await readFile(scenariosUrl, 'utf8'));
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  const context = await browser.newContext({ acceptDownloads: true, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  await context.addInitScript(() => { navigator.serviceWorker.register = async () => ({}); });
  const page = await context.newPage();
  await page.goto(url);
  await page.locator('#home-summary').waitFor();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  // A freshly exported PWA backup is the shared seed. Scenario actions are intentionally
  // performed only through visible controls; unsupported UI actions remain marked pending.
  for (const scenario of scenarios) {
    const dir = new URL(`${scenario.id}/`, outputRoot);
    await mkdir(dir, { recursive: true });
    const snapshot = {
      format: 'kakeimatch-ledger-snapshot', version: 1, scenario: scenario.id,
      status: 'pending', knownDifference: scenario.iosGap ?? null,
      note: 'PWA UI action/export has not been implemented for this scenario; no parity claim is made.',
    };
    await writeFile(new URL('ledger-snapshot.json', dir), `${JSON.stringify(snapshot, null, 2)}\n`);
    if (scenario.id === 'baseline') {
      // The migration screenshot fixture exporter is the canonical UI-seeded baseline.
      // Copying its generated archive ensures both platforms receive byte-identical input.
      await writeFile(new URL('household.kmb', dir), await readFile(fixtureUrl));
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  await context.close();
} finally {
  await browser.close();
}
console.log(`Generated ${scenarios.length} parity scenario directories (pending scenarios are not asserted as matching).`);
