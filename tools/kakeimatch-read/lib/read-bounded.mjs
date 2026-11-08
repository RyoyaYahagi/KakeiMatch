// 上限付きの読み込み。上限を1バイト超えた時点で読むのをやめ、それ以上メモリを使わない。
// 超えた分は呼び出し側（readSnapshotBytes）がサイズ超過として扱う。書き込みは行わない。
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { MAX_SNAPSHOT_BYTES } from './validate.mjs';

const CHUNK_BYTES = 1024 * 1024;

function readDescriptor(fd, limit) {
  const chunks = [];
  let total = 0;
  while (total <= limit) {
    const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, limit + 1 - total));
    const read = readSync(fd, chunk, 0, chunk.length, null);
    if (read === 0) break;
    chunks.push(chunk.subarray(0, read));
    total += read;
  }
  return Buffer.concat(chunks, total);
}

// O_NONBLOCK keeps a FIFO without a writer from blocking open; the descriptor is then checked to be a
// regular file, so the type cannot change between the check and the read.
// Without O_NOFOLLOW (Windows) a symbolic link swapped in after listing would be followed, so such a
// read is refused instead of silently losing the protection.
export function readFileBounded(path, { noFollow = false, limit = MAX_SNAPSHOT_BYTES, fsConstants = constants } = {}) {
  if (noFollow && fsConstants.O_NOFOLLOW === undefined) {
    throw Object.assign(new Error('この環境ではシンボリックリンクをたどらずに開けません'), { code: 'ENOFOLLOW_UNSUPPORTED' });
  }
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) | (noFollow ? fsConstants.O_NOFOLLOW : 0);
  const fd = openSync(path, flags);
  try {
    if (!fstatSync(fd).isFile()) {
      throw Object.assign(new Error('通常のファイルではありません'), { code: 'ENOTREG' });
    }
    return readDescriptor(fd, limit);
  } finally {
    closeSync(fd);
  }
}

// Standard input may be a pipe or a terminal, so it is read as a stream and dropped past the limit.
export async function readStreamBounded(stream, { limit = MAX_SNAPSHOT_BYTES } = {}) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const kept = bytes.subarray(0, limit + 1 - total);
    chunks.push(kept);
    total += kept.length;
    if (total > limit) {
      stream.destroy?.();
      break;
    }
  }
  return Buffer.concat(chunks, total);
}
