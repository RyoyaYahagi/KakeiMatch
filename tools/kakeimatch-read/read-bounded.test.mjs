import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { constants, mkdtempSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { execute } from './lib/cli.mjs';
import { readFileBounded, readStreamBounded } from './lib/read-bounded.mjs';
import { MAX_SNAPSHOT_BYTES } from './lib/validate.mjs';
import { loadSample, snapshotBytes } from './helpers.mjs';

function workDir() {
  return mkdtempSync(join(tmpdir(), 'kakeimatch-read-bounded-'));
}

test('上限を超えるファイルは上限+1バイトで読むのをやめ、サイズ超過のエラーになる', async () => {
  const dir = workDir();
  const path = join(dir, 'big.json');
  writeFileSync(path, '');
  truncateSync(path, 4096);
  assert.equal(readFileBounded(path, { limit: 100 }).length, 101);

  truncateSync(path, MAX_SNAPSHOT_BYTES + 4096);
  assert.equal(readFileBounded(path).length, MAX_SNAPSHOT_BYTES + 1);
  const result = await execute(['summary', '--file', path]);
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /ファイルが大きすぎます/);
});

test('標準入力も上限+1バイトで読むのをやめる', async () => {
  const stream = Readable.from((function* () {
    for (let index = 0; index < 50; index += 1) yield Buffer.alloc(10, 0x20);
  })());
  assert.equal((await readStreamBounded(stream, { limit: 25 })).length, 26);
  const whole = snapshotBytes(loadSample('snapshot-sample-empty'));
  assert.deepEqual(await readStreamBounded(Readable.from([whole])), whole);
});

test('FIFO などの通常でないファイルは待たずにエラーになる', { skip: process.platform === 'win32' }, async () => {
  const dir = workDir();
  const fifo = join(dir, 'snapshot.fifo');
  execFileSync('mkfifo', [fifo]);
  const started = Date.now();
  const result = await execute(['summary', '--file', fifo]);
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /通常のファイルではない/);
  assert.ok(Date.now() - started < 2000, 'FIFO で待っています');
});

test('--dir の候補がシンボリックリンクなら読まない', { skip: process.platform === 'win32' }, async () => {
  const dir = workDir();
  const target = join(dir, 'outside.json');
  writeFileSync(target, snapshotBytes(loadSample('snapshot-sample-normal')));
  symlinkSync(target, join(dir, 'snapshot.json'));
  const listed = await execute(['summary', '--dir', dir]);
  assert.equal(listed.exitCode, 2);
  assert.match(listed.stderr, /snapshot\.json も kakeimatch-snapshot-\*\.json もありません/);

  // 列挙の後にシンボリックリンクへ差し替えられても、O_NOFOLLOW で読まない。
  assert.throws(() => readFileBounded(join(dir, 'snapshot.json'), { noFollow: true }), { code: 'ELOOP' });
});

test('O_NOFOLLOW のない環境では、たどらずに開くことを求められた読み込みを拒否する', () => {
  const dir = workDir();
  const path = join(dir, 'snapshot.json');
  writeFileSync(path, snapshotBytes(loadSample('snapshot-sample-empty')));
  const withoutNoFollow = { ...constants, O_NOFOLLOW: undefined };
  assert.throws(() => readFileBounded(path, { noFollow: true, fsConstants: withoutNoFollow }), { code: 'ENOFOLLOW_UNSUPPORTED' });
  // --file のように noFollow を求めない読み込みは、その環境でも読める。
  assert.ok(readFileBounded(path, { fsConstants: withoutNoFollow }).length > 0);
});
