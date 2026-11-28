import { readdir, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Seconds per UI test method, written by generate-ui-test-weights.mjs from CI logs. Do not edit the table by hand.
// Every UI test needs an entry, and shard-ui-tests.test.mjs fails when one is missing or deleted.
// BEGIN generated weights
// Measured from macos-26 runs. Pull requests: 45611315818, 45712539279, 45720081011. Main: 45723472510.
export const durations = {
  'AddButtonHitAreaTests/testAddButtonAccessibilityOrderAndLandscapeLock': 51,
  'AddButtonHitAreaTests/testAddTileCornerBoundaryRespondsJustInsideAndIgnoresJustOutside': 44,
  'AddButtonHitAreaTests/testAddTileOnlyRespondsInsideItsRaisedShapeOnHomeTab': 52,
  'AddButtonHitAreaTests/testAddTileTracksDynamicTypeAndKeyboard': 59,
  'AddButtonHitAreaTests/testAddTileTracksMoneyForwardRoute': 22,
  'AddButtonHitAreaTests/testTapBesideRaisedTileStillActivatesUnderlyingRecordRow': 48,
  'AppShellSettingsTests/testLegacyScreenLockPreferenceNoLongerLocksAnUpgradedApp': 26,
  'AppShellSettingsTests/testThemeSelectionChangesTheWholeApplicationImmediately': 20,
  'BackupFlowTests/testBackupInitialScreenshotsInLightAndDark': 24,
  'BackupFlowTests/testBackupPageShowsPWACopyDisclosureAndActionStatus': 20,
  'BudgetFlowTests/testBudgetInitialDarkScreenshot': 10,
  'BudgetFlowTests/testBudgetInitialLightScreenshot': 13,
  'BudgetFlowTests/testHomeOpensBudgetSavesAndReflectsUpdatedTotal': 18,
  'DriveSyncFlowTests/testDriveSyncInitialScreenshotsInLightAndDark': 23,
  'DriveSyncFlowTests/testSettingsRowShowsOffAndPageOpensWithToggleOff': 18,
  'DynamicTypeLayoutTests/testAccessibilityXLHomeRecordsEntryAndSettingsStayInsideScreen': 95,
  'DynamicTypeLayoutTests/testAccessibilityXLReceiptAndReconciliationStayInsideScreen': 49,
  'EntryFlowTests/testManualExpenseScreensAndSaveInLight': 54,
  'EntryFlowTests/testManualExpenseScreensInDark': 50,
  'FixtureLaunchTests/testInvalidFixtureShowsErrorInsteadOfEmptyHousehold': 7,
  'FixtureLaunchTests/testNamedFixturesBootWithoutChangingPlaceholderScreens': 20,
  'HomeBottomInsetTests/testHomeLastRecordClearsBottomNavigationInBothAppearances': 21,
  'HomeFlowTests/testAttentionOpensReconciliation': 11,
  'HomeFlowTests/testHomeReferenceStatesInLightAndDark': 119,
  'HomeFlowTests/testMonthSwitchAndCategoryDisclosureStayReachableAboveNavigation': 13,
  'MasterManagementFlowTests/testCreateCategoryFromSettings': 24,
  'MasterManagementFlowTests/testMasterCategoriesInitialScreenshots': 17,
  'MoneyForwardFlowTests/testMoneyForwardImportScreenshotsLightAndDark': 36,
  'MuseExportFlowTests/testMuseExportInitialScreenshotsInLightAndDark': 26,
  'MuseExportFlowTests/testSettingsOpensScreenWithDefaultRangeAndSharesGeneratedFile': 21,
  'NativeAuthFlowTests/testGuestUsageScreenshotInDark': 13,
  'NativeAuthFlowTests/testUnsupportedDeviceExplainsCloudStopAndKeepsLocalUse': 18,
  'NativeAuthFlowTests/testUsageAndSupportIdCopyWithoutAccountUI': 30, // no measurement yet: default
  'NavigationSmokeTests/testBottomNavigationAndReferenceScreenshots': 53,
  'PayrollFlowTests/testPayrollConfirmDarkScreenshot': 15,
  'PayrollFlowTests/testPayrollConfirmedFieldsRequireReviewCheckbox': 17,
  'PayrollFlowTests/testPayrollConfirmLightScreenshot': 16,
  'PayrollFlowTests/testPayrollIncomeFlowAndConfirmedBreakdown': 15,
  'PayrollFlowTests/testPayrollInitialDarkScreenshot': 14,
  'PayrollFlowTests/testPayrollInitialLightScreenshot': 15,
  'ReceiptFlowTests/testAppliedReceiptDetailZoomsImageAndEditsItemCategory': 27,
  'ReceiptFlowTests/testDecliningAIConsentKeepsManualReceiptEntryAvailable': 17,
  'ReceiptFlowTests/testPendingReceiptCanCorrectItemCategoryRegisterAndReturnToRecords': 32,
  'ReceiptFlowTests/testScreensDark': 67,
  'ReceiptFlowTests/testScreensLight': 72,
  'ReceiptFlowTests/testUnfinishedPendingInputIsRestoredAfterLeavingTheEditor': 27,
  'ReceiptFlowTests/testWarningCorrectionSaveAndRecords': 30,
  'ReconciliationBadgeTests/testReconciliationBadgeCountAccessibilityAndEmptyState': 28,
  'ReconciliationFlowTests/testCountsNavigateToHistoryAndPending': 17,
  'ReconciliationFlowTests/testManualMatchHistoryAndConfirmedUndo': 39,
  'ReconciliationFlowTests/testReferenceStatesAndEmptyImporterInDark': 35,
  'ReconciliationFlowTests/testReferenceStatesAndEmptyImporterInLight': 34,
  'ReconciliationFlowTests/testSuspectedRequiresConfirmationAndCanBeCleared': 25,
  'ReconciliationFlowTests/testUnmatchedWithKnownUseCreatesPrefilledRecordAndRerunsReconciliation': 28,
  'RecordsFlowTests/testDarkReferenceStatesAndEmptyHousehold': 32,
  'RecordsFlowTests/testDeleteLayoutAtAccessibilityXLFromSearchResult': 28,
  'RecordsFlowTests/testDeletionUndoSurvivesTabSwitchAndAccountLinkOpensAccounts': 32,
  'RecordsFlowTests/testPayrollBreakdownDarkScreenshot': 18,
  'RecordsFlowTests/testPayrollBreakdownInIncomeRecordDetail': 19,
  'RecordsFlowTests/testPayrollBreakdownLightScreenshot': 17,
  'RecordsFlowTests/testRecordsSearchDetailEditDeleteUndoAndReturn': 49,
  'RecordsFlowTests/testSearchChipsSelectRequestedCondition': 31,
  'RecordsFlowTests/testSearchPeriodOpensCalendar': 30,
  'RecurringFlowTests/testCatchUpCurrentMonthAppearsInRecordsAndCanBeUndoneFromHistory': 49,
  'RecurringFlowTests/testCatchUpDialogDarkScreenshot': 36,
  'RecurringFlowTests/testCatchUpDialogLightScreenshot': 40,
  'RecurringFlowTests/testCatchUpHistoryDarkScreenshot': 59,
  'RecurringFlowTests/testCatchUpHistoryLightScreenshot': 40,
  'RecurringFlowTests/testCreateRecurringScheduleFromSettings': 31,
  'RecurringFlowTests/testRecurringInitialDarkScreenshot': 8,
  'RecurringFlowTests/testRecurringInitialLightScreenshot': 10,
  'RecurringFlowTests/testRecurringSpendingExclusionIsSavedAndAppliedToGeneratedRecord': 40,
  'SettingsFlowTests/testAppInformationOpensAndReturnsToSettings': 32,
  'SettingsFlowTests/testDarkSettingsRootScreenshot': 12,
  'SettingsFlowTests/testGuestCanReachPolicyAndSupportFromSettings': 12,
  'SettingsFlowTests/testThemeSelectionUpdatesRowAndSettingsNavigation': 21,
  'UXExplorationTests/testU1EmptyHomeShowsTabsAndBudgetSetup': 17,
  'UXExplorationTests/testU2EmptyEntryObservesSourceAccountTrap': 45,
  'UXExplorationTests/testU3EditsRegisteredRecordCategory': 38,
  'UXExplorationTests/testU4ReconciliationEmptyAndPopulatedStates': 36,
  'UXExplorationTests/testU5SettingsRowsAndBudgetDiscovery': 28,
};
// END generated weights

// Methods that only open a screen and attach reference screenshots. Pull requests
// skip them; pushes to main and manual runs keep them. Methods that also check
// behaviour (navigation, empty states, saving) stay out of this list.
export const screenshotOnly = [
  'BackupFlowTests/testBackupInitialScreenshotsInLightAndDark',
  'BudgetFlowTests/testBudgetInitialDarkScreenshot',
  'BudgetFlowTests/testBudgetInitialLightScreenshot',
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
  // Dark passes split out of the light tests. Their behaviour matches the light pass, which pull requests still run.
  'EntryFlowTests/testManualExpenseScreensInDark',
  'ReconciliationFlowTests/testReferenceStatesAndEmptyImporterInDark',
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
  if (assigned.length !== tests.length
      || new Set(assigned).size !== assigned.length
      || tests.some(name => !assigned.includes(name))) {
    throw new Error('Every selected test must appear in exactly one shard');
  }
}

// Shard 0 also runs the Swift Testing unit tests. Median of four macos-26 runs (118 to 148 seconds across runs).
export const unitTestSeconds = 121;

// firstShardSeconds is time that shard 0 spends before its UI tests start.
// A selection smaller than count leaves some shards empty; ui-tests still needs every matrix entry.
export function assignShards(tests, count, weights = durations, { firstShardSeconds = 0 } = {}) {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error('Shard count must be a positive integer');
  }
  const weight = name => weights[name] ?? 30;
  const ordered = [...tests].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b, 'en'));
  const shards = Array.from({ length: count }, (_, index) => ({
    tests: [],
    estimatedSeconds: index === 0 ? firstShardSeconds : 0,
  }));
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const skipScreenshots = args.includes('--skip-screenshots');
  const changedIndex = args.indexOf('--changed');
  const changedFile = changedIndex === -1 ? undefined : args[changedIndex + 1];
  if (changedIndex !== -1 && changedFile === undefined) throw new Error('--changed requires a file');
  const [count, index] = args.filter((arg, position) => arg !== '--skip-screenshots'
    && (changedIndex === -1 || (position !== changedIndex && position !== changedIndex + 1)));
  let tests = selectTests(await discoverTests(new URL('../KakeiMatchUITests/', import.meta.url)), { skipScreenshots });
  const shardCount = Number(count);
  if (changedFile !== undefined) {
    const changed = (await readFile(changedFile, 'utf8')).split('\n').filter(Boolean);
    const selection = selectForChanges(tests, changed, {
      features: await featureIdentifiers(new URL('../KakeiMatch/Features/', import.meta.url)),
      testFiles: await uiTestFiles(new URL('../KakeiMatchUITests/', import.meta.url)),
    });
    console.error(selection.all ? 'Changed paths need every UI test.' : `Selected ${selection.tests.length} UI tests for the changed paths.`);
    tests = selection.tests;
  }
  const shards = assignShards(tests, shardCount, durations, { firstShardSeconds: unitTestSeconds });
  if (index === undefined) {
    console.log(JSON.stringify(shards, null, 2));
  } else {
    if (!/^\d+$/.test(index) || !shards[Number(index)]) throw new Error('Invalid shard index');
    console.log(shards[Number(index)].tests.join('\n'));
  }
}
