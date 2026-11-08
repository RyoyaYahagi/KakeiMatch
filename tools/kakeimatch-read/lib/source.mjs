// --file / --dir からスナップショットを1つ読む。書き込みも子プロセスの起動も行わない。
import { join } from 'node:path';
import { SnapshotError, UsageError } from './errors.mjs';
import { readSnapshotBytes } from './validate.mjs';

export const SNAPSHOT_FILENAME = 'snapshot.json';
const GENERATED_NAME_PATTERN = /^kakeimatch-snapshot-.*\.json$/;

export function isSnapshotCandidate(name) {
  return name === SNAPSHOT_FILENAME || GENERATED_NAME_PATTERN.test(name);
}

function errorCode(error) {
  if (error && typeof error.code === 'string') return error.code;
  return error instanceof Error ? error.message : String(error);
}

function errorText(error) {
  if (error instanceof SnapshotError) return error.messages.join(' / ');
  return error instanceof Error ? error.message : String(error);
}

function readLocalBytes(io, path) {
  try {
    return io.readFile(path);
  } catch (error) {
    throw new SnapshotError([`${path} を読めません（${errorCode(error)}）`]);
  }
}

// 検証に通る候補のうち generatedAt が最も新しいものを返す。同名なら名前順で安定させる。
async function selectNewest(candidates, label) {
  const failures = [];
  const valid = [];
  for (const candidate of candidates) {
    try {
      valid.push({ ...candidate, snapshot: await candidate.load() });
    } catch (error) {
      failures.push(errorText(error));
    }
  }
  if (valid.length === 0) {
    throw new SnapshotError([`${label} に検証を通るスナップショットがありません`, ...failures]);
  }
  valid.sort((left, right) => {
    const difference = Date.parse(right.snapshot.generatedAt) - Date.parse(left.snapshot.generatedAt);
    if (difference !== 0) return difference;
    if (left.name === right.name) return 0;
    return left.name < right.name ? -1 : 1;
  });
  const selected = valid[0];
  return { snapshot: selected.snapshot, label: selected.label };
}

async function loadFromDir(dir, io) {
  let entries;
  try {
    entries = io.readDir(dir);
  } catch (error) {
    throw new SnapshotError([`ディレクトリ ${dir} を読めません（${errorCode(error)}）`]);
  }
  const names = entries
    .filter(entry => entry.isFile() && isSnapshotCandidate(entry.name))
    .map(entry => entry.name)
    .sort();
  if (names.length === 0) {
    throw new SnapshotError([`${dir} に ${SNAPSHOT_FILENAME} も kakeimatch-snapshot-*.json もありません`]);
  }
  const candidates = names.map(name => {
    const path = join(dir, name);
    return { name, label: path, load: () => readSnapshotBytes(readLocalBytes(io, path), path) };
  });
  return selectNewest(candidates, dir);
}

export async function loadSnapshot(source, io) {
  if (!source || !source.kind) throw new UsageError('読み込み元がありません');
  if (source.kind === 'file') {
    if (source.value === '-') {
      return { snapshot: readSnapshotBytes(io.readStdin(), '標準入力'), label: '標準入力' };
    }
    const bytes = readLocalBytes(io, source.value);
    return { snapshot: readSnapshotBytes(bytes, source.value), label: source.value };
  }
  if (source.kind === 'dir') return loadFromDir(source.value, io);
  throw new UsageError(`不明な読み込み元です: ${source.kind}`);
}
