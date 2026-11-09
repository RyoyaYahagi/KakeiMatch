import { readdir, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Method totals in seconds measured on run 42481996769 (main, 2026-11-08),
// run 42713631077 (PR #381, 2026-11-09) and run 42720659398 (PR #383,
// 2026-11-09); values are the rounded mean of the available runs. These are
// hints, not a test list: deleted methods disappear and new methods receive the
// default estimate.
const durations = {
  'AppShellSettingsTests/testLegacyScreenLockPreferenceNoLongerLocksAnUpgradedApp': 19,
  'AppShellSettingsTests/testThemeSelectionChangesTheWholeApplicationImmediately': 53,
  'BackupFlowTests/testBackupInitialScreenshotsInLightAndDark': 36,
  'BackupFlowTests/testBackupPageShowsPWACopyDisclosureAndActionStatus': 19,
  'BudgetFlowTests/testBudgetInitialDarkScreenshot': 11,
  'BudgetFlowTests/testBudgetInitialLightScreenshot': 26,
  'BudgetFlowTests/testHomeOpensBudgetSavesAndReflectsUpdatedTotal': 28,
  'ContactFlowTests/testContactInitialScreenshotsInLightAndDark': 42,
  'ContactFlowTests/testSettingsContactSubmitShowsFailureAndKeepsDraft': 31,
  'DriveSyncFlowTests/testSettingsRowShowsOffAndPageOpensWithToggleOff': 19,
  'DynamicTypeLayoutTests/testAccessibilityXLHomeRecordsEntryAndSettingsStayInsideScreen': 73,
  'DynamicTypeLayoutTests/testAccessibilityXLReceiptAndReconciliationStayInsideScreen': 47,
  'EntryFlowTests/testManualExpenseScreensAndSaveInLightAndDark': 103,
  'FixtureLaunchTests/testInvalidFixtureShowsErrorInsteadOfEmptyHousehold': 11,
  'FixtureLaunchTests/testNamedFixturesBootWithoutChangingPlaceholderScreens': 24,
  'HomeBottomInsetTests/testHomeLastRecordClearsBottomNavigationInBothAppearances': 48,
  'HomeFlowTests/testAttentionOpensReconciliation': 13,
  'HomeFlowTests/testHomeReferenceStatesInLightAndDark': 83,
  'HomeFlowTests/testMonthSwitchAndCategoryDisclosureStayReachableAboveNavigation': 13,
  'MasterManagementFlowTests/testCreateCategoryFromSettings': 17,
  'MasterManagementFlowTests/testMasterCategoriesInitialScreenshots': 25,
  'MoneyForwardFlowTests/testMoneyForwardImportScreenshotsLightAndDark': 35,
  'MuseExportFlowTests/testMuseExportInitialScreenshotsInLightAndDark': 37,
  'MuseExportFlowTests/testSettingsOpensScreenWithDefaultRangeAndSharesGeneratedFile': 30,
  'NativeAuthFlowTests/testGuestUsagePasskeyLoginAndLogout': 27,
  'NativeAuthFlowTests/testGuestUsageScreenshotInDark': 20,
  'NativeAuthFlowTests/testUnsupportedDeviceExplainsCloudStopAndKeepsLocalUse': 23,
  'NavigationSmokeTests/testBottomNavigationAndReferenceScreenshots': 59,
  'PayrollFlowTests/testPayrollConfirmDarkScreenshot': 13,
  'PayrollFlowTests/testPayrollConfirmedFieldsRequireReviewCheckbox': 16,
  'PayrollFlowTests/testPayrollConfirmLightScreenshot': 13,
  'PayrollFlowTests/testPayrollIncomeFlowAndConfirmedBreakdown': 19,
  'PayrollFlowTests/testPayrollInitialDarkScreenshot': 13,
  'PayrollFlowTests/testPayrollInitialLightScreenshot': 15,
  'ReceiptFlowTests/testAppliedReceiptDetailZoomsImageAndEditsItemCategory': 23,
  'ReceiptFlowTests/testPendingReceiptCanCorrectItemCategoryRegisterAndReturnToRecords': 29,
  'ReceiptFlowTests/testPendingReceiptUsesEditorAndReturnsToRecords': 13,
  'ReceiptFlowTests/testScreensDark': 62,
  'ReceiptFlowTests/testScreensLight': 79,
  'ReceiptFlowTests/testUnfinishedPendingInputIsRestoredAfterLeavingTheEditor': 22,
  'ReceiptFlowTests/testWarningCorrectionSaveAndRecords': 37,
  'ReconciliationBadgeTests/testReconciliationBadgeCountAccessibilityAndEmptyState': 21,
  'ReconciliationFlowTests/testCountsNavigateToHistoryAndPending': 13,
  'ReconciliationFlowTests/testManualMatchHistoryAndConfirmedUndo': 32,
  'ReconciliationFlowTests/testReferenceStatesLightDarkAndEmptyImporter': 72,
  'ReconciliationFlowTests/testSuspectedRequiresConfirmationAndCanBeCleared': 24,
  'RecordsFlowTests/testDarkReferenceStatesAndEmptyHousehold': 26,
  'RecordsFlowTests/testDeletionUndoSurvivesTabSwitchAndAccountLinkOpensAccounts': 29,
  'RecordsFlowTests/testPayrollBreakdownDarkScreenshot': 14,
  'RecordsFlowTests/testPayrollBreakdownInIncomeRecordDetail': 22,
  'RecordsFlowTests/testPayrollBreakdownLightScreenshot': 13,
  'RecordsFlowTests/testRecordsSearchDetailEditDeleteUndoAndReturn': 38,
  'RecordsFlowTests/testSearchChipsSelectRequestedCondition': 27,
  'RecordsFlowTests/testSearchPeriodOpensCalendar': 58,
  'RecurringFlowTests/testCatchUpCurrentMonthAppearsInRecordsAndCanBeUndoneFromHistory': 37,
  'RecurringFlowTests/testCatchUpDialogDarkScreenshot': 28,
  'RecurringFlowTests/testCatchUpDialogLightScreenshot': 31,
  'RecurringFlowTests/testCatchUpHistoryDarkScreenshot': 39,
  'RecurringFlowTests/testCatchUpHistoryLightScreenshot': 47,
  'RecurringFlowTests/testCreateRecurringScheduleFromSettings': 29,
  'RecurringFlowTests/testRecurringInitialDarkScreenshot': 8,
  'RecurringFlowTests/testRecurringInitialLightScreenshot': 8,
  'RecurringFlowTests/testRecurringSpendingExclusionIsSavedAndAppliedToGeneratedRecord': 39,
  'SettingsFlowTests/testAppInformationOpensAndReturnsToSettings': 32,
  'SettingsFlowTests/testDarkSettingsRootScreenshot': 12,
  'SettingsFlowTests/testThemeSelectionUpdatesRowAndSettingsNavigation': 20,
};

// Methods that only open a screen and attach reference screenshots. Pull requests
// skip them; pushes to main and manual runs keep them. Methods that also check
// behaviour (navigation, empty states, saving) stay out of this list.
export const screenshotOnly = [
  'BackupFlowTests/testBackupInitialScreenshotsInLightAndDark',
  'BudgetFlowTests/testBudgetInitialDarkScreenshot',
  'BudgetFlowTests/testBudgetInitialLightScreenshot',
  'ContactFlowTests/testContactInitialScreenshotsInLightAndDark',
  'DriveSyncFlowTests/testDriveSyncInitialScreenshotsInLightAndDark',
  'MasterManagementFlowTests/testMasterCategoriesInitialScreenshots',
  'MoneyForwardFlowTests/testMoneyForwardImportScreenshotsLightAndDark',
  'MuseExportFlowTests/testMuseExportInitialScreenshotsInLightAndDark',
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

export function assignShards(tests, count, weights = durations, { reservedSeconds = 0, reservedShard = 0 } = {}) {
  if (!Number.isInteger(count) || count < 1 || count > tests.length) {
    throw new Error('Shard count must be an integer between 1 and the test count');
  }
  if (!Number.isFinite(reservedSeconds) || reservedSeconds < 0
      || !Number.isInteger(reservedShard) || reservedShard < 0 || reservedShard >= count) {
    throw new Error('Reserved load must be non-negative and point at an existing shard');
  }
  const weight = name => weights[name] ?? 30;
  const ordered = [...tests].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b, 'en'));
  const shards = Array.from({ length: count }, () => ({ tests: [], estimatedSeconds: 0 }));
  // Shard 0 runs the simulator unit tests and parity export before its UI tests.
  // Starting it with that load makes the greedy assignment give it fewer UI tests.
  shards[reservedShard].estimatedSeconds = reservedSeconds;
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
  // Shard 0 also runs the simulator Swift Testing suite, parity export and uploads
  // (about 110s on PR #383: 88s unit tests + 11s parity + 11s uploads). Reserve
  // that load so it receives fewer UI tests without becoming the critical path.
  const shards = assignShards(tests, shardCount, durations, { reservedSeconds: 110, reservedShard: 0 });
  if (index === undefined) {
    console.log(JSON.stringify(shards, null, 2));
  } else {
    if (!/^\d+$/.test(index) || !shards[Number(index)]) throw new Error('Invalid shard index');
    console.log(shards[Number(index)].tests.join('\n'));
  }
}
