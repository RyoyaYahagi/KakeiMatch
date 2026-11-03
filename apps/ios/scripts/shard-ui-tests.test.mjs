import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import {
  assignShards, discoverTests, featureIdentifiers, screenshotOnly, selectForChanges, selectTests, shardCountFor,
  smokeClasses, uiTestFiles, validateCoverage,
} from './shard-ui-tests.mjs';

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

test('rejects omissions, duplicates, unknown tests, empty shards and invalid counts', () => {
  const tests = ['A', 'B'];
  for (const assigned of [[['A']], [['A'], ['A']], [['A'], ['C']], [['A', 'B'], []]]) {
    assert.throws(() => validateCoverage(tests, assigned.map(names => ({ tests: names }))), /exactly one/);
  }
  for (const count of [0, -1, 1.5, NaN, 3]) assert.throws(() => assignShards(tests, count), /Shard count/);
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

test('uses fewer shards for a small selection', () => {
  assert.equal(shardCountFor(['A', 'B'], 4, { A: 30, B: 30 }), 1);
  assert.equal(shardCountFor(['A', 'B', 'C'], 4, { A: 400, B: 400, C: 400 }), 3);
  assert.equal(shardCountFor(['A', 'B'], 4, { A: 900, B: 900 }), 2);
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
