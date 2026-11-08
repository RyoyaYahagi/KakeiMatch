import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRclone } from './lib/rclone.mjs';
import { fakeExecFile } from './helpers.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

function sourceFiles(dir = ROOT) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.name.endsWith('.mjs') && !entry.name.endsWith('.test.mjs')) files.push(path);
  }
  return files;
}

// `execFile as nodeExecFile` のような別名は、元の名前で判定する。
function importedNames(list) {
  return list.split(',').map(name => name.trim().split(/\s+as\s+/)[0]).filter(Boolean);
}

// 書き込み・外部通信の API を使っていないことを静的に確かめる。
const FORBIDDEN = [
  /\bwriteFile(Sync)?\b/,
  /\bappendFile(Sync)?\b/,
  /\bmkdir(Sync)?\b/,
  /\brm(Sync)?\b/,
  /\brmdir(Sync)?\b/,
  /\bunlink(Sync)?\b/,
  /\brename(Sync)?\b/,
  /\bcreateWriteStream\b/,
  /\bcopyFile(Sync)?\b/,
  /\btruncate(Sync)?\b/,
  /\bsymlink(Sync)?\b/,
  /\bfetch\s*\(/,
  /from\s+['"]node:https?['"]/,
  /from\s+['"]https?['"]/,
];

test('CLI のソースに書き込み系 API と fetch・http の利用がない', () => {
  const files = sourceFiles();
  assert.ok(files.length >= 5, `ソースファイルが見つかりません: ${files.join(', ')}`);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of FORBIDDEN) {
      assert.doesNotMatch(text, pattern, `${file} が禁止された API を使っています: ${pattern}`);
    }
    for (const match of text.matchAll(/import\s*\{([^}]+)\}\s*from\s*'node:fs'/g)) {
      const names = importedNames(match[1]);
      for (const name of names) {
        assert.ok(['readFileSync', 'readdirSync'].includes(name), `${file} が node:fs の ${name} を import しています`);
      }
    }
    for (const match of text.matchAll(/import\s*\{([^}]+)\}\s*from\s*'node:child_process'/g)) {
      const names = importedNames(match[1]);
      assert.deepEqual(names, ['execFile'], `${file} が child_process の execFile 以外を import しています`);
    }
  }
});

test('rclone の実行は cat と lsjson の引数だけを渡す', async () => {
  const execFile = fakeExecFile(args => {
    if (args[0] === 'lsjson') return { stdout: '[]' };
    return { stdout: '{}' };
  });
  const rclone = createRclone({ execFile });
  await rclone.cat('gdrive:KakeiMatch/snapshot.json');
  await rclone.listFiles('gdrive:KakeiMatch/');
  assert.deepEqual(execFile.calls, [
    { file: 'rclone', args: ['cat', 'gdrive:KakeiMatch/snapshot.json'] },
    { file: 'rclone', args: ['lsjson', '--files-only', 'gdrive:KakeiMatch/'] },
  ]);
  for (const call of execFile.calls) {
    assert.ok(['cat', 'lsjson'].includes(call.args[0]), `許可されないサブコマンド: ${call.args[0]}`);
  }
});
