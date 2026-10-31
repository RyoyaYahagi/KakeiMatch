import { readdir, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Method totals in seconds from run 40702769985. These are hints, not a test list:
// deleted methods disappear; new methods receive the default estimate.
const durations = {
  'AppShellSettingsTests/testEnabledScreenLockHidesAppAndLocksOnLaunch': 21,
  'AppShellSettingsTests/testThemeSelectionChangesTheWholeApplicationImmediately': 16,
  'BudgetFlowTests/testBudgetInitialDarkScreenshot': 9,
  'BudgetFlowTests/testBudgetInitialLightScreenshot': 9,
  'BudgetFlowTests/testHomeOpensBudgetSavesAndReflectsUpdatedTotal': 19,
  'BackupFlowTests/testBackupInitialScreenshotsInLightAndDark': 18,
  'BackupFlowTests/testBackupPageShowsPWACopyDisclosureAndActionStatus': 20,
  'ContactFlowTests/testContactInitialScreenshotsInLightAndDark': 43,
  'ContactFlowTests/testSettingsContactSubmitShowsFailureAndKeepsDraft': 27,
  'EntryFlowTests/testManualExpenseScreensAndSaveInLightAndDark': 101,
  'FixtureLaunchTests/testInvalidFixtureShowsErrorInsteadOfEmptyHousehold': 18,
  'FixtureLaunchTests/testNamedFixturesBootWithoutChangingPlaceholderScreens': 20,
  'HomeBottomInsetTests/testHomeLastRecordClearsBottomNavigationInBothAppearances': 21,
  'HomeFlowTests/testAttentionOpensReconciliation': 8,
  'HomeFlowTests/testHomeReferenceStatesInLightAndDark': 65,
  'HomeFlowTests/testMonthSwitchAndCategoryDisclosureStayReachableAboveNavigation': 12,
  'NavigationSmokeTests/testBottomNavigationAndReferenceScreenshots': 64,
  'ReceiptFlowTests/testPendingReceiptUsesEditorAndReturnsToRecords': 13,
  'ReceiptFlowTests/testScreensDark': 92,
  'ReceiptFlowTests/testScreensLight': 67,
  'ReceiptFlowTests/testWarningCorrectionSaveAndRecords': 29,
  'ReconciliationBadgeTests/testReconciliationBadgeCountAccessibilityAndEmptyState': 21,
  'ReconciliationFlowTests/testCountsNavigateToHistoryAndPending': 13,
  'ReconciliationFlowTests/testManualMatchHistoryAndConfirmedUndo': 32,
  'ReconciliationFlowTests/testReferenceStatesLightDarkAndEmptyImporter': 59,
  'ReconciliationFlowTests/testSuspectedRequiresConfirmationAndCanBeCleared': 24,
  'RecordsFlowTests/testDarkReferenceStatesAndEmptyHousehold': 29,
  'RecordsFlowTests/testRecordsSearchDetailEditDeleteUndoAndReturn': 41,
  'SettingsFlowTests/testDarkSettingsRootScreenshot': 11,
  'SettingsFlowTests/testThemeSelectionAndScreenLockSettingsNavigation': 20,
  'RecurringFlowTests/testRecurringInitialDarkScreenshot': 10,
  'RecurringFlowTests/testRecurringInitialLightScreenshot': 10,
  'RecurringFlowTests/testCreateRecurringScheduleFromSettings': 35,
  'PayrollFlowTests/testPayrollIncomeFlowAndConfirmedBreakdown': 16,
  'PayrollFlowTests/testPayrollConfirmedFieldsRequireReviewCheckbox': 18,
  'PayrollFlowTests/testPayrollInitialDarkScreenshot': 10,
  'PayrollFlowTests/testPayrollInitialLightScreenshot': 10,
  'PayrollFlowTests/testPayrollConfirmDarkScreenshot': 10,
  'PayrollFlowTests/testPayrollConfirmLightScreenshot': 10,
};

// Methods that only open a screen and attach reference screenshots. Pull requests
// skip them; pushes to main and manual runs keep them. Methods that also check
// behaviour (navigation, empty states, saving) stay out of this list.
export const screenshotOnly = [
  'BackupFlowTests/testBackupInitialScreenshotsInLightAndDark',
  'BudgetFlowTests/testBudgetInitialDarkScreenshot',
  'BudgetFlowTests/testBudgetInitialLightScreenshot',
  'ContactFlowTests/testContactInitialScreenshotsInLightAndDark',
  'MasterManagementFlowTests/testMasterCategoriesInitialScreenshots',
  'MoneyForwardFlowTests/testMoneyForwardImportScreenshotsLightAndDark',
  'HomeFlowTests/testHomeReferenceStatesInLightAndDark',
  'ReceiptFlowTests/testScreensDark',
  'ReceiptFlowTests/testScreensLight',
  'SettingsFlowTests/testDarkSettingsRootScreenshot',
  'RecurringFlowTests/testRecurringInitialDarkScreenshot',
  'RecurringFlowTests/testRecurringInitialLightScreenshot',
  'RecurringFlowTests/testCatchUpDialogLightScreenshot',
  'RecurringFlowTests/testCatchUpDialogDarkScreenshot',
  'RecurringFlowTests/testCatchUpHistoryLightScreenshot',
  'RecurringFlowTests/testCatchUpHistoryDarkScreenshot',
  'PayrollFlowTests/testPayrollInitialLightScreenshot',
  'PayrollFlowTests/testPayrollInitialDarkScreenshot',
  'PayrollFlowTests/testPayrollConfirmLightScreenshot',
  'PayrollFlowTests/testPayrollConfirmDarkScreenshot',
];

export async function discoverTests(directory) {
  const tests = [];
  for (const file of (await readdir(directory)).filter(name => name.endsWith('.swift')).sort()) {
    const source = await readFile(new URL(file, directory), 'utf8');
    // Ignore commented declarations and quoted text, preserving line boundaries.
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"/g, '');
    const classes = [...code.matchAll(/\bclass\s+(\w+)\s*:\s*XCTestCase\b/g)];
    for (const [index, match] of classes.entries()) {
      const body = code.slice(match.index, classes[index + 1]?.index ?? code.length);
      tests.push(...[...body.matchAll(/\bfunc\s+(test\w*)\s*\(\s*\)/g)].map(method => `${match[1]}/${method[1]}`));
    }
  }
  if (tests.length === 0 || new Set(tests).size !== tests.length) {
    throw new Error('Expected non-empty, uniquely named XCTestCase test methods');
  }
  return tests.sort();
}

export function selectTests(tests, { skipScreenshots = false, skipped = screenshotOnly } = {}) {
  const missing = skipped.filter(name => !tests.includes(name));
  if (missing.length > 0) throw new Error(`Unknown screenshot-only test: ${missing.join(', ')}`);
  return skipScreenshots ? tests.filter(name => !skipped.includes(name)) : tests;
}

export function validateCoverage(tests, shards) {
  const assigned = shards.flatMap(shard => shard.tests);
  if (shards.some(shard => shard.tests.length === 0)
      || assigned.length !== tests.length
      || new Set(assigned).size !== assigned.length
      || tests.some(name => !assigned.includes(name))) {
    throw new Error('Every selected test must appear in exactly one non-empty shard');
  }
}

export function assignShards(tests, count, weights = durations) {
  if (!Number.isInteger(count) || count < 1 || count > tests.length) {
    throw new Error('Shard count must be an integer between 1 and the test count');
  }
  const weight = name => weights[name] ?? 30;
  const ordered = [...tests].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b, 'en'));
  const shards = Array.from({ length: count }, () => ({ tests: [], estimatedSeconds: 0 }));
  for (const name of ordered) {
    const shard = shards.reduce((best, candidate) => candidate.estimatedSeconds < best.estimatedSeconds ? candidate : best);
    shard.tests.push(name);
    shard.estimatedSeconds += weight(name);
  }
  validateCoverage(tests, shards);
  return shards;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const skipScreenshots = args.includes('--skip-screenshots');
  const [count, index] = args.filter(arg => arg !== '--skip-screenshots');
  const tests = selectTests(await discoverTests(new URL('../KakeiMatchUITests/', import.meta.url)), { skipScreenshots });
  const shards = assignShards(tests, Number(count));
  if (index === undefined) {
    console.log(JSON.stringify(shards, null, 2));
  } else {
    if (!/^\d+$/.test(index) || !shards[Number(index)]) throw new Error('Invalid shard index');
    console.log(shards[Number(index)].tests.join('\n'));
  }
}
