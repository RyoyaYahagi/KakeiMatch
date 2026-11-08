// rclone は読み取り専用の cat と lsjson だけを呼ぶ。shell を介さず execFile を使う。
import { execFile as nodeExecFile } from 'node:child_process';
import { SnapshotError, UsageError } from './errors.mjs';
import { MAX_SNAPSHOT_BYTES } from './validate.mjs';

const MAX_OUTPUT_BYTES = MAX_SNAPSHOT_BYTES + 1024;

// RCLONE_* variables set global flags, and some of them have side effects (RCLONE_LOG_FILE writes a
// log). They are dropped except the config file location, its password and RCLONE_CONFIG_<REMOTE>_*,
// which only define remotes. Other variables (PATH, HOME, proxies) pass through unchanged.
export function rcloneEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) =>
    !/^RCLONE_/i.test(name) || /^RCLONE_CONFIG(?:$|_)/i.test(name)));
}

function failureMessage(args, error, stderr) {
  const detail = Buffer.isBuffer(stderr) ? stderr.toString('utf8').trim() : String(stderr ?? '').trim();
  if (error && error.code === 'ENOENT') {
    return 'rclone が見つかりません。インストールと PATH を確認してください';
  }
  const command = args[0] === 'lsjson' ? 'lsjson' : 'cat';
  const suffix = detail ? `（${detail}）` : '';
  return `rclone ${command} が失敗しました${suffix}`;
}

export function createRclone({ execFile = nodeExecFile, env = process.env } = {}) {
  function run(args) {
    return new Promise((resolve, reject) => {
      execFile('rclone', args, {
        encoding: 'buffer',
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
        env: rcloneEnv(env),
      }, (error, stdout, stderr) => {
        if (error) {
          reject(new SnapshotError([failureMessage(args, error, stderr)]));
          return;
        }
        resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? ''), 'utf8'));
      });
    });
  }
  return {
    // `--` ends rclone's options, so a path can never be read as a flag.
    cat: remotePath => run(['cat', '--', remotePath]),
    listFiles: remoteDir => run(['lsjson', '--files-only', '--', remoteDir]),
    listRemotes: () => run(['listremotes', '--json']),
  };
}

// Some backends write while reading (cache keeps chunks and a database, hasher a database), and
// wrapping backends point at other remotes. Only Google Drive and local remotes (and plain local paths)
// are read, so the read-only guarantee does not depend on how a remote is configured.
const READ_ONLY_REMOTE_TYPES = new Set(['drive', 'local']);

// rclone treats the text before the first ':' as a remote name unless a '/' comes first.
export function remoteNameOf(path) {
  const match = /^([^/:]*):/.exec(path);
  return match ? match[1] : null;
}

export async function assertReadOnlyRemote(path, rclone) {
  const name = remoteNameOf(path);
  if (name === null) return;
  if (name === '' || name.includes(',')) {
    throw new UsageError(`--remote ではその場で組み立てる接続先（:backend: や 名前,オプション=値:）を使えません: ${path}`);
  }
  let remotes;
  try {
    remotes = JSON.parse((await rclone.listRemotes()).toString('utf8'));
  } catch (error) {
    if (error instanceof SnapshotError) throw error;
    throw new SnapshotError(['rclone listremotes の出力を JSON として読めません']);
  }
  const remote = Array.isArray(remotes) ? remotes.find(entry => entry?.name === name) : undefined;
  if (!remote) throw new SnapshotError([`rclone の接続先 ${name} が見つかりません`]);
  if (!READ_ONLY_REMOTE_TYPES.has(remote.type)) {
    throw new UsageError(`rclone の接続先 ${name} の種類（${remote.type}）は使えません。読み取りで書き込みが起きないことを保証できる Google Drive（drive）かローカル（local）の接続先、またはローカルのパスを指定してください`);
  }
}
