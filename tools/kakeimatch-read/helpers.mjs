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
