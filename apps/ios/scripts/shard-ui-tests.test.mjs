import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { assignShards, discoverTests, screenshotOnly, selectTests, validateCoverage } from './shard-ui-tests.mjs';

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
