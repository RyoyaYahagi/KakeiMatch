import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const allSuites = JSON.parse(readFileSync(new URL('./ci-e2e-suites.json', import.meta.url), 'utf8'));
const suites = (...names) => names.map(name => `test:${name}-e2e`);
const statements = suites('smbc-statements', 'rakuten-statements', 'reconciliation',
  'provider-only-reconciliation', 'reconciliation-review', 'statement-options', 'backup');

// Exact module names only: a new/shared module must default to the full suite.
const groups = [
  { files: ['src/lib/statement-parser-core.ts', 'src/lib/statement-parser.ts',
    'apps/pwa/src/local-statements.ts', 'apps/pwa/src/statement-download-help.ts'], tests: statements },
  { files: ['apps/pwa/src/statement-parser.ts'], tests: [...statements, ...suites('moneyforward')] },
  { files: ['apps/pwa/src/payroll-ui.ts', 'apps/pwa/src/local-payroll.ts'],
    tests: suites('payroll', 'account-balances', 'monthly-dashboard', 'backup') },
  { files: ['apps/pwa/src/local-transaction-search.ts', 'apps/pwa/src/local-transaction-search-ui.ts'],
    tests: suites('transaction-search', 'record-navigation') },
  { files: ['apps/pwa/src/local-monthly-budgets.ts', 'apps/pwa/src/local-monthly-budget-service.ts'],
    tests: suites('monthly-budgets', 'monthly-dashboard') },
  { files: ['apps/pwa/src/moneyforward-parser.ts', 'apps/pwa/src/moneyforward-import.ts', 'apps/pwa/src/moneyforward-ui.ts'],
    tests: suites('moneyforward', 'account-balances', 'monthly-dashboard', 'backup') },
  { files: ['apps/pwa/src/contact-ui.ts', 'apps/pwa/src/contact-diagnostics.ts'],
    tests: suites('contact', 'diagnostics') },
];

function isPwaIndependent(file) {
  return file.startsWith('apps/ios/') || file === '.github/workflows/ios.yml' ||
    file === '.github/workflows/ci.yml' || file === 'scripts/testflight.test.mjs';
}

function hasNoBrowserImpact(file) {
  return isPwaIndependent(file) || file.endsWith('.md') || file.startsWith('docs/') ||
    file.startsWith('tools/kakeimatch-read/') || file.startsWith('test/fixtures/muse-snapshot/') ||
    /^src\/.*\.test\.ts$/.test(file);
}

export function selectChecks(files, { full = false } = {}) {
  const all = reason => ({ skipPwa: false, e2e: [...allSuites], reason });
  if (full || files.length === 0) return all('手動実行・差分取得失敗・空の差分は全件');
  if (files.every(isPwaIndependent)) return { skipPwa: true, e2e: [], reason: 'iOS・対象CIファイルのみ' };
  const selected = new Set();
  const pwaPackage = JSON.parse(readFileSync(new URL('../apps/pwa/package.json', import.meta.url), 'utf8'));
  for (const file of files) {
    if (hasNoBrowserImpact(file)) continue;
    const group = groups.find(group => group.files.includes(file));
    if (group) {
      group.tests.forEach(test => selected.add(test));
      continue;
    }
    // A change to a standalone browser test runs that test; shared helpers fall back to all.
    const matchingTests = Object.entries(pwaPackage.scripts).filter(([name, command]) =>
      allSuites.includes(name) && command === `node ${file.replace(/^apps\/pwa\//, '')}`);
    if (file.startsWith('apps/pwa/test/') && matchingTests.length > 0) {
      matchingTests.forEach(([name]) => selected.add(name));
      continue;
    }
    return all(`共通基盤または未分類: ${file}`);
  }
  return { skipPwa: false, e2e: allSuites.filter(test => selected.has(test)), reason: '変更モジュールに関連する操作テスト' };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let files = [];
  if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
    try {
      // Triple-dot compares the PR to its merge base, excluding unrelated base-branch updates.
      // Disable rename detection so both old and new paths contribute to selection.
      files = execFileSync('git', ['diff', '--no-renames', '--name-only', '-z',
        `${process.env.BASE_SHA}...${process.env.HEAD_SHA}`], { encoding: 'utf8' }).split('\0').filter(Boolean);
    } catch {
      console.warn('Could not compare PR commits; running all checks.');
    }
  }
  const result = selectChecks(files, { full: process.env.GITHUB_EVENT_NAME !== 'pull_request' });
  console.log(`${result.reason}: ${result.e2e.length}/${allSuites.length} E2E suites`);
  console.log(result.e2e.join('\n'));
  appendFileSync(process.env.GITHUB_OUTPUT,
    `skip_pwa=${result.skipPwa}\ne2e=${result.e2e.join(' ')}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `### CI対象\n${result.reason}\n\nE2E: ${result.e2e.length}/${allSuites.length}本\n\n${result.e2e.map(test => `- ${test}`).join('\n')}\n`);
}
