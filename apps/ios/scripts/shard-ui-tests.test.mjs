import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { assignShards, discoverClasses, validateCoverage } from './shard-ui-tests.mjs';

test('discovers new classes, multiple declarations and ignores comments/helpers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ios-shards-'));
  try {
    const url = pathToFileURL(`${directory}/`);
    await writeFile(join(directory, 'Added.swift'), '// class Fake: XCTestCase {}\n/* class Nope: XCTestCase {} */\nfinal class NewTests:\n XCTestCase {}\nclass OtherTests: XCTestCase {}');
    await writeFile(join(directory, 'Helper.swift'), 'struct Helper {}');
    assert.deepEqual(await discoverClasses(url), ['NewTests', 'OtherTests']);
    await writeFile(join(directory, 'Duplicate.swift'), 'class NewTests: XCTestCase {}');
    await assert.rejects(discoverClasses(url), /uniquely named/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('spreads expensive classes first, with stable ties and new-class defaults', () => {
  const classes = ['Heavy', 'Medium', 'New', 'Small'];
  const weights = { Heavy: 130, Medium: 100, Small: 10 };
  const shards = assignShards(classes, 3, weights);
  assert.deepEqual(shards.map(shard => shard.classes), [['Heavy'], ['Medium'], ['New', 'Small']]);
  assert.deepEqual(assignShards([...classes].reverse(), 3, weights), shards);
});

test('rejects omissions, duplicates, unknown classes, empty shards and invalid counts', () => {
  const classes = ['A', 'B'];
  for (const assigned of [[['A']], [['A'], ['A']], [['A'], ['C']], [['A', 'B'], []]]) {
    assert.throws(() => validateCoverage(classes, assigned.map(names => ({ classes: names }))), /exactly one/);
  }
  for (const count of [0, -1, 1.5, NaN, 3]) assert.throws(() => assignShards(classes, count), /Shard count/);
});

test('all repository classes belong to exactly one of three non-empty shards', async () => {
  const classes = await discoverClasses(new URL('../KakeiMatchUITests/', import.meta.url));
  const shards = assignShards(classes, 3);
  validateCoverage(classes, shards);
  assert.deepEqual(shards.flatMap(shard => shard.classes).sort(), classes);
});
