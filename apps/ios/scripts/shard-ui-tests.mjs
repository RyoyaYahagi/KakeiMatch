import { readdir, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Method totals in seconds from run 40702769985, updated with a 2026-11-01 pull request run. These are hints, not a test list:
// deleted methods disappear; new methods receive the default estimate.
const durations = {
  'AppShellSettingsTests/testEnabledScreenLockHidesAppAndLocksOnLaunch': 19,
  'AppShellSettingsTests/testThemeSelectionChangesTheWholeApplicationImmediately': 23,
  'BackupFlowTests/testBackupInitialScreenshotsInLightAndDark': 18,
  'BackupFlowTests/testBackupPageShowsPWACopyDisclosureAndActionStatus': 16,
  'BudgetFlowTests/testBudgetInitialDarkScreenshot': 9,
  'BudgetFlowTests/testBudgetInitialLightScreenshot': 9,
  'BudgetFlowTests/testHomeOpensBudgetSavesAndReflectsUpdatedTotal': 94,
  'ContactFlowTests/testContactInitialScreenshotsInLightAndDark': 43,
  'ContactFlowTests/testSettingsContactSubmitShowsFailureAndKeepsDraft': 21,
  'DynamicTypeLayoutTests/testAccessibilityXLHomeRecordsEntryAndSettingsStayInsideScreen': 36,
  'DynamicTypeLayoutTests/testAccessibilityXLReceiptAndReconciliationStayInsideScreen': 64,
  'EntryFlowTests/testManualExpenseScreensAndSaveInLightAndDark': 173,
  'FixtureLaunchTests/testInvalidFixtureShowsErrorInsteadOfEmptyHousehold': 6,
  'FixtureLaunchTests/testNamedFixturesBootWithoutChangingPlaceholderScreens': 20,
  'HomeBottomInsetTests/testHomeLastRecordClearsBottomNavigationInBothAppearances': 33,
  'HomeFlowTests/testAttentionOpensReconciliation': 9,
  'HomeFlowTests/testHomeReferenceStatesInLightAndDark': 65,
  'HomeFlowTests/testMonthSwitchAndCategoryDisclosureStayReachableAboveNavigation': 11,
  'MasterManagementFlowTests/testCreateCategoryFromSettings': 20,
  'NativeAuthFlowTests/testGuestUsagePasskeyLoginAndLogout': 26,
  'NativeAuthFlowTests/testGuestUsageScreenshotInDark': 12,
  'NativeAuthFlowTests/testUnsupportedDeviceExplainsCloudStopAndKeepsLocalUse': 18,
  'NavigationSmokeTests/testBottomNavigationAndReferenceScreenshots': 50,
  'PayrollFlowTests/testPayrollConfirmDarkScreenshot': 10,
  'PayrollFlowTests/testPayrollConfirmLightScreenshot': 10,
  'PayrollFlowTests/testPayrollConfirmedFieldsRequireReviewCheckbox': 16,
  'PayrollFlowTests/testPayrollIncomeFlowAndConfirmedBreakdown': 15,
  'PayrollFlowTests/testPayrollInitialDarkScreenshot': 10,
  'PayrollFlowTests/testPayrollInitialLightScreenshot': 10,
  'ReceiptFlowTests/testAppliedReceiptDetailZoomsImageAndEditsItemCategory': 61,
  'ReceiptFlowTests/testPendingReceiptCanCorrectItemCategoryRegisterAndReturnToRecords': 29,
  'ReceiptFlowTests/testPendingReceiptUsesEditorAndReturnsToRecords': 13,
  'ReceiptFlowTests/testScreensDark': 92,
  'ReceiptFlowTests/testScreensLight': 67,
  'ReceiptFlowTests/testUnfinishedPendingInputIsRestoredAfterLeavingTheEditor': 15,
  'ReceiptFlowTests/testWarningCorrectionSaveAndRecords': 38,
  'ReconciliationBadgeTests/testReconciliationBadgeCountAccessibilityAndEmptyState': 15,
  'ReconciliationFlowTests/testCountsNavigateToHistoryAndPending': 14,
  'ReconciliationFlowTests/testManualMatchHistoryAndConfirmedUndo': 35,
  'ReconciliationFlowTests/testReferenceStatesLightDarkAndEmptyImporter': 59,
  'ReconciliationFlowTests/testSuspectedRequiresConfirmationAndCanBeCleared': 24,
  'RecordsFlowTests/testDarkReferenceStatesAndEmptyHousehold': 22,
  'RecordsFlowTests/testDeletionUndoSurvivesTabSwitchAndAccountLinkOpensAccounts': 22,
  'RecordsFlowTests/testPayrollBreakdownDarkScreenshot': 12,
  'RecordsFlowTests/testPayrollBreakdownInIncomeRecordDetail': 17,
  'RecordsFlowTests/testPayrollBreakdownLightScreenshot': 12,
  'RecordsFlowTests/testRecordsSearchDetailEditDeleteUndoAndReturn': 31,
  'RecurringFlowTests/testCatchUpCurrentMonthAppearsInRecordsAndCanBeUndoneFromHistory': 57,
  'RecurringFlowTests/testCreateRecurringScheduleFromSettings': 33,
  'RecurringFlowTests/testRecurringInitialDarkScreenshot': 10,
  'RecurringFlowTests/testRecurringInitialLightScreenshot': 10,
  'SettingsFlowTests/testDarkSettingsRootScreenshot': 11,
  'SettingsFlowTests/testThemeSelectionAndScreenLockSettingsNavigation': 21,
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
  'RecordsFlowTests/testPayrollBreakdownLightScreenshot',
  'RecordsFlowTests/testPayrollBreakdownDarkScreenshot',
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

// Pull requests always run these: launch with each fixture and open every bottom tab.
export const smokeClasses = ['FixtureLaunchTests', 'NavigationSmokeTests'];

// Changes that need only the unit tests (always run) and the smoke tests. Data, API and
// Core behaviour is covered by KakeiMatchTests; main pushes still run every UI test.
const smokeOnlyPaths = [
  /^apps\/ios\/KakeiMatch(Core)?Tests\//,
  /^apps\/ios\/KakeiMatch\/(Data|API|Core)\//,
  /^test\/fixtures\/ios-parity\//,
];
const ignoredPaths = [/\.md$/, /^apps\/ios\/scripts\/testflight\.sh$/];

// Accessibility identifiers each Features/<Name> folder declares.
export async function featureIdentifiers(directory) {
  const features = new Map();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const ids = new Set();
    for (const file of await readdir(new URL(`${entry.name}/`, directory), { recursive: true })) {
      if (!file.endsWith('.swift')) continue;
      const source = await readFile(new URL(`${entry.name}/${file}`, directory), 'utf8');
      for (const match of source.matchAll(/accessibilityIdentifier\("([^"\\]+)"/g)) ids.add(match[1]);
    }
    features.set(entry.name, ids);
  }
  return features;
}

// Test classes per UI test file, with every quoted string in that file.
export async function uiTestFiles(directory) {
  const files = new Map();
  for (const file of (await readdir(directory)).filter(name => name.endsWith('.swift'))) {
    const source = await readFile(new URL(file, directory), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    files.set(file.replace(/\.swift$/, ''), {
      classes: [...code.matchAll(/\bclass\s+(\w+)\s*:\s*XCTestCase\b/g)].map(match => match[1]),
      strings: new Set([...code.matchAll(/"((?:\\.|[^"\\])*)"/g)].map(match => match[1])),
    });
  }
  return files;
}

// Picks UI test classes for the changed repository paths. A feature folder runs the classes
// that use one of its identifiers; anything without a known mapping runs every test.
export function selectForChanges(tests, changedPaths, { features, testFiles }) {
  const classes = new Set(smokeClasses);
  for (const path of changedPaths) {
    if (ignoredPaths.some(pattern => pattern.test(path)) || smokeOnlyPaths.some(pattern => pattern.test(path))) continue;
    const feature = path.match(/^apps\/ios\/KakeiMatch\/Features\/([^/]+)\//)?.[1];
    if (feature !== undefined) {
      const ids = features.get(feature);
      const users = ids === undefined ? [] : [...testFiles.values()]
        .filter(file => [...ids].some(id => file.strings.has(id)))
        .flatMap(file => file.classes);
      // A deleted folder has nothing left to test; an untested one falls back to everything.
      if (ids !== undefined && users.length === 0) return { all: true, tests };
      users.forEach(name => classes.add(name));
      continue;
    }
    const testFile = path.match(/^apps\/ios\/KakeiMatchUITests\/(\w+)\.swift$/)?.[1];
    if (testFile !== undefined) {
      const file = testFiles.get(testFile);
      if (file === undefined) continue; // deleted test file
      if (file.classes.length === 0) return { all: true, tests }; // shared helper
      file.classes.forEach(name => classes.add(name));
      continue;
    }
    return { all: true, tests };
  }
  return { all: false, tests: tests.filter(name => classes.has(name.split('/')[0])) };
}

// Fewer shards for a small selection: about five minutes of tests per simulator.
export function shardCountFor(tests, maximum, weights = durations) {
  const seconds = tests.reduce((sum, name) => sum + (weights[name] ?? 30), 0);
  return Math.max(1, Math.min(maximum, tests.length, Math.ceil(seconds / 300)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const skipScreenshots = args.includes('--skip-screenshots');
  const changedIndex = args.indexOf('--changed');
  const changedFile = changedIndex === -1 ? undefined : args[changedIndex + 1];
  if (changedIndex !== -1 && changedFile === undefined) throw new Error('--changed requires a file');
  const [count, index] = args.filter((arg, position) => arg !== '--skip-screenshots'
    && (changedIndex === -1 || (position !== changedIndex && position !== changedIndex + 1)));
  let tests = selectTests(await discoverTests(new URL('../KakeiMatchUITests/', import.meta.url)), { skipScreenshots });
  let shardCount = Number(count);
  if (changedFile !== undefined) {
    const changed = (await readFile(changedFile, 'utf8')).split('\n').filter(Boolean);
    const selection = selectForChanges(tests, changed, {
      features: await featureIdentifiers(new URL('../KakeiMatch/Features/', import.meta.url)),
      testFiles: await uiTestFiles(new URL('../KakeiMatchUITests/', import.meta.url)),
    });
    console.error(selection.all ? 'Changed paths need every UI test.' : `Selected ${selection.tests.length} UI tests for the changed paths.`);
    tests = selection.tests;
    if (!selection.all) shardCount = shardCountFor(tests, shardCount);
  }
  const shards = assignShards(tests, shardCount);
  if (index === undefined) {
    console.log(JSON.stringify(shards, null, 2));
  } else {
    if (!/^\d+$/.test(index) || !shards[Number(index)]) throw new Error('Invalid shard index');
    console.log(shards[Number(index)].tests.join('\n'));
  }
}
