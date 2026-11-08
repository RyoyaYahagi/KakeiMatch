// rclone は読み取り専用の cat と lsjson だけを呼ぶ。shell を介さず execFile を使う。
import { execFile as nodeExecFile } from 'node:child_process';
import { SnapshotError } from './errors.mjs';
import { MAX_SNAPSHOT_BYTES } from './validate.mjs';

const MAX_OUTPUT_BYTES = MAX_SNAPSHOT_BYTES + 1024;

// RCLONE_* variables can turn on side effects such as RCLONE_LOG_FILE, so only the variables
// rclone needs to find its config and run are passed through.
const PASSED_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME', 'RCLONE_CONFIG', 'RCLONE_CONFIG_PASS', 'SystemRoot', 'APPDATA', 'USERPROFILE'];

export function rcloneEnv(env = process.env) {
  return Object.fromEntries(PASSED_ENV.filter(name => env[name] !== undefined).map(name => [name, env[name]]));
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
  };
}
