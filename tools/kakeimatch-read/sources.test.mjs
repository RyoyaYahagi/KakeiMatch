import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execute } from './lib/cli.mjs';
import { isSnapshotCandidate } from './lib/source.mjs';
import { clone, fakeExecFile, loadSample, snapshotBytes } from './helpers.mjs';

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

test('--remote はファイルを rclone cat だけで読む', async () => {
  const execFile = fakeExecFile(args => {
    assert.equal(args[0], 'cat');
    return { stdout: snapshotBytes(loadSample('snapshot-sample-normal')) };
  });
  const result = await execute(['summary', '--remote', 'gdrive:KakeiMatch/snapshot.json', '--json'], { execFile });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).transactions, 12);
  assert.deepEqual(execFile.calls, [
    { file: 'rclone', args: ['listremotes', '--json'] },
    { file: 'rclone', args: ['cat', '--', 'gdrive:KakeiMatch/snapshot.json'] },
  ]);
});

test('--remote の末尾 / は lsjson で候補を列挙し、--dir と同じ規則で選ぶ', async () => {
  const older = withGeneratedAt('2026-11-02T09:00:00+09:00');
  const newer = withGeneratedAt('2026-11-05T09:00:00+09:00');
  const execFile = fakeExecFile(args => {
    if (args[0] === 'lsjson') {
      return {
        stdout: JSON.stringify([
          { Name: 'snapshot.json', Size: 1, IsDir: false },
          { Name: 'kakeimatch-snapshot-20261105000000.json', Size: 1, IsDir: false },
          { Name: 'notes.txt', Size: 1, IsDir: false },
          { Name: 'folder', Size: 0, IsDir: true },
        ]),
      };
    }
    if (args[1] === 'gdrive:KakeiMatch/snapshot.json') return { stdout: snapshotBytes(older) };
    return { stdout: snapshotBytes(newer) };
  });
  const result = await execute(['summary', '--remote', 'gdrive:KakeiMatch/', '--json'], { execFile });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).generatedAt, '2026-11-05T09:00:00+09:00');
  assert.deepEqual(execFile.calls.map(call => call.args[0]), ['listremotes', 'lsjson', 'cat', 'cat']);
  assert.deepEqual(execFile.calls[1], { file: 'rclone', args: ['lsjson', '--files-only', '--', 'gdrive:KakeiMatch/'] });
  for (const call of execFile.calls) {
    assert.equal(call.file, 'rclone');
    assert.ok(['cat', 'lsjson', 'listremotes'].includes(call.args[0]), `許可されないサブコマンド: ${call.args[0]}`);
  }
});

test('rclone の失敗と不正な lsjson 出力はエラーになる', async () => {
  const notFound = fakeExecFile(() => ({
    error: Object.assign(new Error('spawn rclone ENOENT'), { code: 'ENOENT' }),
    stderr: 'rclone: command not found',
  }));
  const missing = await execute(['summary', '--remote', 'gdrive:KakeiMatch/snapshot.json'], { execFile: notFound, env: {} });
  assert.equal(missing.exitCode, 2);
  assert.match(missing.stderr, /rclone が見つかりません/);

  const failed = fakeExecFile(() => ({ error: new Error('exit 1'), stderr: 'directory not found' }));
  const failure = await execute(['summary', '--remote', 'gdrive:KakeiMatch/snapshot.json'], { execFile: failed, env: {} });
  assert.equal(failure.exitCode, 2);
  assert.match(failure.stderr, /rclone cat が失敗しました/);
  assert.match(failure.stderr, /directory not found/);

  const badListing = fakeExecFile(() => ({ stdout: 'not json' }));
  const bad = await execute(['summary', '--remote', 'gdrive:KakeiMatch/'], { execFile: badListing, env: {} });
  assert.equal(bad.exitCode, 2);
  assert.match(bad.stderr, /lsjson の出力を JSON として読めません/);
});

test('候補のファイル名の規則', () => {
  assert.equal(isSnapshotCandidate('snapshot.json'), true);
  assert.equal(isSnapshotCandidate('kakeimatch-snapshot-20261108090000.json'), true);
  assert.equal(isSnapshotCandidate('kakeimatch-snapshot-.json'), true);
  assert.equal(isSnapshotCandidate('kakeimatch-snapshot.json'), false);
  assert.equal(isSnapshotCandidate('snapshot.json.bak'), false);
  assert.equal(isSnapshotCandidate('notes.txt'), false);
});

test('--remote は drive 以外の接続先と、その場で組み立てる接続先を使わない', async () => {
  const remotes = [{ name: 'gdrive', type: 'drive' }, { name: 'cached', type: 'cache' }, { name: 'hashed', type: 'hasher' }];
  for (const [remote, pattern] of [
    ['cached:KakeiMatch/snapshot.json', /cached の種類（cache）は使えません/],
    ['hashed:KakeiMatch/', /hashed の種類（hasher）は使えません/],
    [':cache,remote=/tmp:snapshot.json', /その場で組み立てる接続先/],
    ['gdrive,root_folder_id=root:KakeiMatch/snapshot.json', /その場で組み立てる接続先/],
  ]) {
    const execFile = fakeExecFile(() => ({ stdout: '{}' }), { remotes });
    const result = await execute(['summary', '--remote', remote], { execFile, env: {} });
    assert.equal(result.exitCode, 1, remote);
    assert.match(result.stderr, pattern);
    assert.ok(execFile.calls.every(call => call.args[0] === 'listremotes'), `${remote} で cat / lsjson を呼んでいます`);
  }
  const missing = await execute(['summary', '--remote', 'nowhere:snapshot.json'], { execFile: fakeExecFile(() => ({})), env: {} });
  assert.equal(missing.exitCode, 2);
  assert.match(missing.stderr, /接続先 nowhere が見つかりません/);
});

test('--remote のローカルのパスは接続先の確認なしで rclone cat で読む', async () => {
  const execFile = fakeExecFile(() => ({ stdout: snapshotBytes(loadSample('snapshot-sample-normal')) }));
  const result = await execute(['summary', '--remote', '/data/KakeiMatch/snapshot.json', '--json'], { execFile, env: {} });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(execFile.calls.map(call => call.args[0]), ['cat']);
});
