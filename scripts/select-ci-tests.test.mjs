import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { allSuites, selectChecks } from './select-ci-tests.mjs';

test('PWA-screen suites are retired from CI, so statement and shared parser changes select no suite', () => {
  const result = selectChecks(['apps/pwa/src/local-statements.ts', 'src/lib/local-statements.test.ts',
    'src/lib/statement-parser-core.ts', 'src/lib/statement-parser.test.ts', 'apps/pwa/src/statement-parser.ts']);
  assert.deepEqual(result.e2e, []);
  assert.equal(result.skipPwa, false);
});

test('suites that failed on the retired PWA screens are not in CI', () => {
  for (const name of ['payroll', 'backup', 'contact', 'security', 'recurring']) {
    assert.ok(!allSuites.includes(`test:${name}-e2e`), name);
  }
});

test('unknown paths, shared modules, dependency and workflow changes run all suites', () => {
  for (const file of ['apps/pwa/src/main.ts', 'apps/pwa/src/local-ui.ts', 'src/lib/local-data.ts',
    'apps/pwa/src/new-feature.ts', 'apps/pwa/src/style.css', 'pnpm-lock.yaml',
    'apps/pwa/package.json', '.github/workflows/new-ci.yml', 'scripts/select-ci-tests.mjs',
    'apps/pwa/test/browser-helpers.mjs']) {
    assert.deepEqual(selectChecks([file]).e2e, allSuites, file);
  }
});

test('empty diff and manual verification run all even for known narrow files', () => {
  assert.deepEqual(selectChecks([]).e2e, allSuites);
  assert.deepEqual(selectChecks(['apps/pwa/src/payroll-ui.ts'], { full: true }).e2e, allSuites);
});

test('iOS-only skips PWA, mixed changes keep relevant PWA checks', () => {
  assert.equal(selectChecks(['apps/ios/project.yml', '.github/workflows/ios.yml']).skipPwa, true);
  const mixed = selectChecks(['apps/ios/project.yml', 'apps/pwa/src/payroll-ui.ts']);
  assert.equal(mixed.skipPwa, false);
  assert.deepEqual(mixed.e2e, []);
});

test('docs and unit-only changes retain lightweight checks but skip browser installation', () => {
  const result = selectChecks(['README.md', 'docs/UX.md', 'src/lib/local-statements.test.ts']);
  assert.equal(result.skipPwa, false);
  assert.deepEqual(result.e2e, []);
});

test('retired feature changes select nothing, while an unclassified PWA change runs every remaining suite', () => {
  assert.deepEqual(selectChecks(['apps/pwa/src/payroll-ui.ts', 'apps/pwa/src/moneyforward-parser.ts']).e2e, []);
  assert.deepEqual(selectChecks(['apps/pwa/src/admin-ui.ts']).e2e, allSuites);
});

test('standalone E2E edits select themselves; retired or renamed paths fall back to every remaining suite', () => {
  assert.deepEqual(selectChecks(['apps/pwa/test/browser-ai-costs.mjs']).e2e, ['test:ai-costs-e2e']);
  assert.deepEqual(selectChecks(['apps/pwa/test/browser-payroll.mjs']).e2e, allSuites);
  assert.deepEqual(selectChecks(['apps/pwa/src/payroll-ui.ts', 'apps/pwa/src/renamed-payroll.ts']).e2e, allSuites);
});

test('configured full suite has unique executable package scripts and contains all narrow selections', () => {
  const pkg = JSON.parse(readFileSync(new URL('../apps/pwa/package.json', import.meta.url), 'utf8'));
  assert.equal(new Set(allSuites).size, allSuites.length);
  for (const suite of allSuites) assert.match(pkg.scripts[suite], /^node test\/browser-[\w-]+\.mjs$/);
});

test('TestFlight and CI-only changes preserve main PWA skip policy', () => {
  const files = ['apps/ios/scripts/testflight.sh', 'scripts/testflight.test.mjs', '.github/workflows/ci.yml'];
  const result = selectChecks(files);
  assert.equal(result.skipPwa, true);
  assert.deepEqual(result.e2e, []);
  const mixed = selectChecks([...files, 'apps/pwa/src/payroll-ui.ts']);
  assert.equal(mixed.skipPwa, false);
  assert.deepEqual(mixed.e2e, []);
  assert.deepEqual(selectChecks(files, { full: true }).e2e, allSuites);
});

test('read-only snapshot CLI and its fixtures skip browser suites but keep PWA checks', () => {
  const result = selectChecks(['tools/kakeimatch-read/lib/validate.mjs', 'tools/kakeimatch-read/validate.test.mjs',
    'test/fixtures/muse-snapshot/snapshot-sample-normal.json']);
  assert.deepEqual(result.e2e, []);
  assert.equal(result.skipPwa, false);
});
