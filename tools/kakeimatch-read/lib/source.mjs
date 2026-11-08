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

function readLocalBytes(io, path, readOptions) {
  try {
    return io.readFile(path, readOptions);
  } catch (error) {
    if (error?.code === 'ENOTREG') throw new SnapshotError([`${path} は通常のファイルではないので読みません`]);
    if (error?.code === 'ELOOP') throw new SnapshotError([`${path} はシンボリックリンクなので読みません`]);
    if (error?.code === 'ENOFOLLOW_UNSUPPORTED') {
      throw new SnapshotError([`${path}: この環境では --dir の候補を安全に開けません。--file でファイルを指定してください`]);
    }
    throw new SnapshotError([`${path} を読めません（${errorCode(error)}）`]);
  }
}

function isNewer(candidate, current) {
  const difference = Date.parse(candidate.snapshot.generatedAt) - Date.parse(current.snapshot.generatedAt);
  if (difference !== 0) return difference > 0;
  return candidate.name < current.name;
}

// 検証に通る候補のうち generatedAt が最も新しいものを返す。同名なら名前順で安定させる。
async function selectNewest(candidates, label) {
  const failures = [];
  // Only the newest candidate so far is kept, so memory does not grow with the number of files.
  let selected = null;
  for (const candidate of candidates) {
    try {
      const loaded = { ...candidate, snapshot: await candidate.load() };
      if (selected === null || isNewer(loaded, selected)) selected = loaded;
    } catch (error) {
      failures.push(errorText(error));
    }
  }
  if (selected === null) {
    throw new SnapshotError([`${label} に検証を通るスナップショットがありません`, ...failures]);
  }
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
    // The entry was a regular file when listed; O_NOFOLLOW keeps a symbolic link swapped in later from being read.
    return { name, label: path, load: () => readSnapshotBytes(readLocalBytes(io, path, { noFollow: true }), path) };
  });
  return selectNewest(candidates, dir);
}

export async function loadSnapshot(source, io) {
  if (!source || !source.kind) throw new UsageError('読み込み元がありません');
  if (source.kind === 'file') {
    if (source.value === '-') {
      return { snapshot: readSnapshotBytes(await io.readStdin(), '標準入力'), label: '標準入力' };
    }
    const bytes = readLocalBytes(io, source.value);
    return { snapshot: readSnapshotBytes(bytes, source.value), label: source.value };
  }
  if (source.kind === 'dir') return loadFromDir(source.value, io);
  throw new UsageError(`不明な読み込み元です: ${source.kind}`);
}
