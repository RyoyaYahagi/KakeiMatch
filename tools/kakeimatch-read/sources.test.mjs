import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execute } from './lib/cli.mjs';
import { isSnapshotCandidate } from './lib/source.mjs';
import { clone, loadSample, snapshotBytes } from './helpers.mjs';

const NORMAL = new URL('../../test/fixtures/muse-snapshot/snapshot-sample-normal.json', import.meta.url).pathname;

function withGeneratedAt(generatedAt) {
  const snapshot = clone(loadSample('snapshot-sample-normal'));
  snapshot.generatedAt = generatedAt;
  return snapshot;
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'kakeimatch-read-'));
}

test('--dir は snapshot.json と kakeimatch-snapshot-*.json から最新の有効なものを選ぶ', async () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'snapshot.json'), snapshotBytes(withGeneratedAt('2026-11-01T09:00:00+09:00')));
  writeFileSync(join(dir, 'kakeimatch-snapshot-20261107000000.json'), snapshotBytes(withGeneratedAt('2026-11-07T09:00:00+09:00')));
  writeFileSync(join(dir, 'kakeimatch-snapshot-20261106000000.json'), '{"kind":"broken"}');
  writeFileSync(join(dir, 'unrelated.json'), 'not a snapshot');

  const result = await execute(['summary', '--dir', dir, '--json']);
  assert.equal(result.exitCode, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.generatedAt, '2026-11-07T09:00:00+09:00');
});

test('--dir は有効なファイルがなければ理由付きでエラーになる', async () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'snapshot.json'), '{"kind":"kakeimatch-backup"}');
  const invalid = await execute(['summary', '--dir', dir], { env: {} });
  assert.equal(invalid.exitCode, 2);
  assert.match(invalid.stderr, /検証を通るスナップショットがありません/);
  assert.match(invalid.stderr, /snapshot\.json/);
  assert.match(invalid.stderr, /kind/);

  const empty = tempDir();
  const missing = await execute(['summary', '--dir', empty], { env: {} });
  assert.equal(missing.exitCode, 2);
  assert.match(missing.stderr, /snapshot\.json も kakeimatch-snapshot-\*\.json もありません/);

  const noDir = await execute(['summary', '--dir', join(empty, 'missing')], { env: {} });
  assert.equal(noDir.exitCode, 2);
  assert.match(noDir.stderr, /ディレクトリ/);
});

test('--file - は標準入力を読む', async () => {
  const result = await execute(['summary', '--file', '-', '--json'], {
    readStdin: () => snapshotBytes(loadSample('snapshot-sample-empty')),
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).generatedAt, '2026-11-08T09:00:00+09:00');
});

test('指定がなければ環境変数 KAKEIMATCH_SNAPSHOT を使う', async () => {
  const result = await execute(['summary', '--json'], { env: { KAKEIMATCH_SNAPSHOT: NORMAL } });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).transactions, 12);
});

test('候補のファイル名の規則', () => {
  assert.equal(isSnapshotCandidate('snapshot.json'), true);
  assert.equal(isSnapshotCandidate('kakeimatch-snapshot-20261108090000.json'), true);
  assert.equal(isSnapshotCandidate('kakeimatch-snapshot-.json'), true);
  assert.equal(isSnapshotCandidate('kakeimatch-snapshot.json'), false);
  assert.equal(isSnapshotCandidate('snapshot.json.bak'), false);
  assert.equal(isSnapshotCandidate('notes.txt'), false);
});

