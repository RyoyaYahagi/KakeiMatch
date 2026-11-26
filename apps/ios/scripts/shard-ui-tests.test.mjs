import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import {
  assignShards, discoverTests, durations, featureIdentifiers, screenshotOnly, selectForChanges, selectTests,
  smokeClasses, uiTestFiles, unitTestSeconds, validateCoverage,
} from './shard-ui-tests.mjs';
import {
  buildWeights, estimates, formatWeightTable, median, parseDurations, replaceWeightTable,
} from './generate-ui-test-weights.mjs';

test('discovers methods per class and ignores comments, helpers and non-test functions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ios-shards-'));
  try {
    const url = pathToFileURL(`${directory}/`);
    await writeFile(join(directory, 'Added.swift'), [
      '// class Fake: XCTestCase { func testFake() {} }',
      '/* func testHidden() {} */',
      'final class NewTests:\n XCTestCase {',
      '  @MainActor func testOne() {}',
      '  func helper() {}',
      '  func testTwo() throws {}',
      '}',
      'class OtherTests: XCTestCase { func testThree() {} }',
    ].join('\n'));
    await writeFile(join(directory, 'Helper.swift'), 'struct Helper { func testNotATest() {} }');
    assert.deepEqual(await discoverTests(url), ['NewTests/testOne', 'NewTests/testTwo', 'OtherTests/testThree']);
    await writeFile(join(directory, 'Duplicate.swift'), 'class NewTests: XCTestCase { func testOne() {} }');
    await assert.rejects(discoverTests(url), /uniquely named/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('skips screenshot-only methods only when asked and rejects stale entries', () => {
  const tests = ['A/testFlow', 'A/testShot'];
  assert.deepEqual(selectTests(tests, { skipped: ['A/testShot'] }), tests);
  assert.deepEqual(selectTests(tests, { skipScreenshots: true, skipped: ['A/testShot'] }), ['A/testFlow']);
  assert.throws(() => selectTests(tests, { skipped: ['A/testRenamed'] }), /Unknown screenshot-only/);
});

test('spreads expensive methods first, with stable ties and new-method defaults', () => {
  const tests = ['Heavy', 'Medium', 'New', 'Small'];
  const weights = { Heavy: 130, Medium: 100, Small: 10 };
  const shards = assignShards(tests, 3, weights);
  assert.deepEqual(shards.map(shard => shard.tests), [['Heavy'], ['Medium'], ['New', 'Small']]);
  assert.deepEqual(assignShards([...tests].reverse(), 3, weights), shards);
});

test('rejects omissions, duplicates, unknown tests and invalid counts', () => {
  const tests = ['A', 'B'];
  for (const assigned of [[['A']], [['A'], ['A']], [['A'], ['C']]]) {
    assert.throws(() => validateCoverage(tests, assigned.map(names => ({ tests: names }))), /exactly one/);
  }
  for (const count of [0, -1, 1.5, NaN]) assert.throws(() => assignShards(tests, count), /Shard count/);
});

test('accepts empty shards, so a short selection still fills every matrix entry', () => {
  const tests = ['A', 'B'];
  assert.doesNotThrow(() => validateCoverage(tests, [{ tests: ['A', 'B'] }, { tests: [] }]));
  const shards = assignShards(tests, 4, { A: 200, B: 200 });
  assert.deepEqual(shards.map(shard => shard.tests), [['A'], ['B'], [], []]);
  assert.equal(assignShards(['A', 'B', 'C'], 4, { A: 10, B: 10, C: 10 }).length, 4);
});

test('repository tests fill four shards with and without screenshot-only methods', async () => {
  const discovered = await discoverTests(new URL('../KakeiMatchUITests/', import.meta.url));
  for (const skipScreenshots of [false, true]) {
    const tests = selectTests(discovered, { skipScreenshots });
    const shards = assignShards(tests, 4);
    assert.deepEqual(shards.flatMap(shard => shard.tests).sort(), tests);
  }
  assert.ok(screenshotOnly.every(name => discovered.includes(name)));
});

const fixture = {
  features: new Map([
    ['Receipt', new Set(['receipt.saveButton'])],
    ['Budget', new Set(['budget.saveButton'])],
    ['Transfer', new Set(['transfer.untested'])],
  ]),
  testFiles: new Map([
    ['ReceiptFlowTests', { classes: ['ReceiptFlowTests'], strings: new Set(['receipt.saveButton']) }],
    ['BudgetFlowTests', { classes: ['BudgetFlowTests'], strings: new Set(['budget.saveButton']) }],
    ['NavigationSmokeTests', { classes: ['NavigationSmokeTests'], strings: new Set() }],
    ['FixtureLaunchTests', { classes: ['FixtureLaunchTests'], strings: new Set() }],
    ['UITestHelpers', { classes: [], strings: new Set() }],
  ]),
};
const fixtureTests = ['BudgetFlowTests/testSave', 'FixtureLaunchTests/testBoot', 'NavigationSmokeTests/testTabs', 'ReceiptFlowTests/testSave'];
const pick = paths => selectForChanges(fixtureTests, paths, fixture);

test('runs the smoke tests plus the classes that use a changed feature', () => {
  assert.deepEqual(pick(['apps/ios/KakeiMatch/Features/Receipt/ReceiptView.swift']),
    { all: false, tests: ['FixtureLaunchTests/testBoot', 'NavigationSmokeTests/testTabs', 'ReceiptFlowTests/testSave'] });
  assert.deepEqual(pick(['apps/ios/KakeiMatchUITests/BudgetFlowTests.swift']).tests,
    ['BudgetFlowTests/testSave', 'FixtureLaunchTests/testBoot', 'NavigationSmokeTests/testTabs']);
});

test('unit-test, data and docs changes only need the smoke tests', () => {
  for (const path of ['apps/ios/KakeiMatch/Data/Store/KMSQLite.swift', 'apps/ios/KakeiMatchTests/LocalStoreTests.swift',
    'test/fixtures/ios-parity/a.json', 'apps/ios/README.md', 'apps/ios/scripts/testflight.sh']) {
    assert.deepEqual(pick([path]).tests, ['FixtureLaunchTests/testBoot', 'NavigationSmokeTests/testTabs'], path);
  }
});

test('falls back to every test for shared or unmapped changes', () => {
  for (const path of ['apps/ios/KakeiMatch/App/AppShell.swift', 'apps/ios/KakeiMatch/Components/KMBanner.swift',
    'apps/ios/project.yml', '.github/workflows/ios.yml', 'apps/ios/scripts/shard-ui-tests.mjs',
    'apps/ios/KakeiMatch/Features/Transfer/TransferView.swift', 'apps/ios/KakeiMatchUITests/UITestHelpers.swift']) {
    assert.deepEqual(pick(['apps/ios/README.md', path]), { all: true, tests: fixtureTests }, path);
  }
});

test('a deleted feature folder or test file adds no tests', () => {
  assert.deepEqual(pick(['apps/ios/KakeiMatch/Features/Removed/RemovedView.swift', 'apps/ios/KakeiMatchUITests/RemovedTests.swift']).tests,
    ['FixtureLaunchTests/testBoot', 'NavigationSmokeTests/testTabs']);
});

test('repository mapping covers every UI test class through a feature or the smoke set', async () => {
  const features = await featureIdentifiers(new URL('../KakeiMatch/Features/', import.meta.url));
  const testFiles = await uiTestFiles(new URL('../KakeiMatchUITests/', import.meta.url));
  const discovered = await discoverTests(new URL('../KakeiMatchUITests/', import.meta.url));
  for (const name of smokeClasses) assert.ok(discovered.some(test => test.startsWith(`${name}/`)), name);
  const receipt = selectForChanges(discovered, ['apps/ios/KakeiMatch/Features/Receipt/ReceiptView.swift'], { features, testFiles });
  assert.equal(receipt.all, false);
  assert.ok(receipt.tests.some(name => name.startsWith('ReceiptFlowTests/')));
  assert.ok(receipt.tests.length < discovered.length);
});

test('every UI test has its own weight and no weight is left for a deleted test', async () => {
  const discovered = await discoverTests(new URL('../KakeiMatchUITests/', import.meta.url));
  const unregistered = discovered.filter(name => !(name in durations));
  const stale = Object.keys(durations).filter(name => !discovered.includes(name));
  assert.deepEqual(unregistered, [], 'run generate-ui-test-weights.mjs --write to register these UI tests');
  assert.deepEqual(stale, [], 'run generate-ui-test-weights.mjs --write to drop these weights');
});

test('shard 0 starts with the unit-test seconds counted', () => {
  const shards = assignShards(['A', 'B', 'C', 'D'], 2, { A: 100, B: 100, C: 100, D: 100 }, { firstShardSeconds: 200 });
  assert.deepEqual(shards.map(shard => shard.tests), [['C'], ['A', 'B', 'D']]);
  assert.deepEqual(shards.map(shard => shard.estimatedSeconds), [300, 300]);
  assert.equal(unitTestSeconds, 121);
});

test('a partial selection under 450 seconds keeps four shards', async () => {
  const features = await featureIdentifiers(new URL('../KakeiMatch/Features/', import.meta.url));
  const testFiles = await uiTestFiles(new URL('../KakeiMatchUITests/', import.meta.url));
  const discovered = await discoverTests(new URL('../KakeiMatchUITests/', import.meta.url));
  const selection = selectForChanges(discovered, ['apps/ios/KakeiMatch/Features/Receipt/ReceiptView.swift'], { features, testFiles });
  assert.equal(selection.all, false);
  const shards = assignShards(selection.tests, 4, Object.fromEntries(selection.tests.map(name => [name, 10])));
  assert.equal(shards.length, 4);
  assert.equal(shards.flatMap(shard => shard.tests).length, selection.tests.length);
});

test('reads passed durations from xcodebuild output and ignores other lines', () => {
  const log = [
    "Test Case '-[KakeiMatchUITests.AddButtonHitAreaTests testAddTileTracksMoneyForwardRoute]' passed (12.5 seconds)",
    "Test Case '-[KakeiMatchUITests.RecordsFlowTests testX]' failed (3.0 seconds)",
    "Test Case '-[KakeiMatchUITests.RecordsFlowTests testY]' skipped (0.1 seconds)",
    'Executed 2 tests, with 0 failures',
  ].join('\n');
  assert.deepEqual(parseDurations(log), [['AddButtonHitAreaTests/testAddTileTracksMoneyForwardRoute', 12.5]]);
});

test('medians use the middle value, or the mean of the two middle values', () => {
  assert.equal(median([30, 10, 20]), 20);
  assert.equal(median([10, 40, 20, 30]), 25);
});

test('weights prefer estimates, then pull-request runs, then main runs, then the default', () => {
  const weights = buildWeights(['Est', 'Pr', 'Main', 'None'], {
    pullRequestSamples: new Map([['Pr', [10, 12, 100]], ['Main', [999]]]),
    mainSamples: new Map([['Main', [50, 60, 70]], ['Est', [5]]]),
    estimated: { Est: 48 },
  });
  assert.deepEqual(weights, {
    Est: { seconds: 48, source: 'estimate' },
    Pr: { seconds: 12, source: 'pull-request' },
    Main: { seconds: 999, source: 'pull-request' },
    None: { seconds: 30, source: 'default' },
  });
});

test('the generated table replaces only the marked block', () => {
  const source = 'before\n// BEGIN generated weights\nold table\n// END generated weights\nafter';
  assert.equal(replaceWeightTable(source, formatWeightTable({ 'A/testB': { seconds: 7, source: 'main' } })),
    "before\n// BEGIN generated weights\nexport const durations = {\n  'A/testB': 7,\n};\n// END generated weights\nafter");
  assert.throws(() => replaceWeightTable('no markers', 'x'), /markers/);
  assert.ok(Object.keys(estimates).every(name => name.includes('/test')));
});

test('dark passes split out of the light tests run on main only, and the light passes run on every push', async () => {
  const all = await discoverTests(new URL('../KakeiMatchUITests/', import.meta.url));
  const dark = ['EntryFlowTests/testManualExpenseScreensInDark', 'ReconciliationFlowTests/testReferenceStatesAndEmptyImporterInDark'];
  const light = ['EntryFlowTests/testManualExpenseScreensAndSaveInLight', 'ReconciliationFlowTests/testReferenceStatesAndEmptyImporterInLight'];
  for (const name of [...dark, ...light]) assert.ok(all.includes(name), `${name} is not a UI test`);
  const pullRequest = selectTests(all, { skipScreenshots: true });
  const main = selectTests(all, { skipScreenshots: false });
  assert.deepEqual(dark.filter(name => pullRequest.includes(name)), [], 'pull requests must skip the dark passes');
  assert.deepEqual(dark.filter(name => !main.includes(name)), [], 'main must still run the dark passes');
  assert.deepEqual(light.filter(name => !pullRequest.includes(name)), [], 'pull requests must keep the light passes');
  assert.deepEqual(dark.filter(name => !screenshotOnly.includes(name)), [], 'the dark passes must be listed as screenshot-only');
});
