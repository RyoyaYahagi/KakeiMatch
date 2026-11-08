// テスト用の合成データ読み込みと CLI 実行の補助。実在の家計情報は使わない。
import { readFileSync } from 'node:fs';

export function loadSample(name) {
  const path = new URL(`../../test/fixtures/muse-snapshot/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function clone(value) {
  return structuredClone(value);
}

export function snapshotBytes(snapshot) {
  return Buffer.from(JSON.stringify(snapshot), 'utf8');
}

export function fakeExecFile(handler) {
  const calls = [];
  const fake = (file, args, options, callback) => {
    calls.push({ file, args });
    const outcome = handler(args, calls.length - 1) ?? {};
    queueMicrotask(() => {
      if (outcome.error) callback(outcome.error, Buffer.alloc(0), Buffer.from(outcome.stderr ?? '', 'utf8'));
      else callback(null, Buffer.from(outcome.stdout ?? '', 'utf8'), Buffer.alloc(0));
    });
  };
  fake.calls = calls;
  return fake;
}
