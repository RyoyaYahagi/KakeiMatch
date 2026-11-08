#!/usr/bin/env node
// KakeiMatch iOS が書き出した家計スナップショットを読み取り専用で表示する CLI。
import { execute } from './lib/cli.mjs';

const result = await execute(process.argv.slice(2)).catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
  return null;
});

if (result !== null) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
