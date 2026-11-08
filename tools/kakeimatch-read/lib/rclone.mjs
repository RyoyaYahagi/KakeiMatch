// rclone は読み取り専用の cat と lsjson だけを呼ぶ。shell を介さず execFile を使う。
import { execFile as nodeExecFile } from 'node:child_process';
import { SnapshotError } from './errors.mjs';
import { MAX_SNAPSHOT_BYTES } from './validate.mjs';

const MAX_OUTPUT_BYTES = MAX_SNAPSHOT_BYTES + 1024;

function failureMessage(args, error, stderr) {
  const detail = Buffer.isBuffer(stderr) ? stderr.toString('utf8').trim() : String(stderr ?? '').trim();
  if (error && error.code === 'ENOENT') {
    return 'rclone が見つかりません。インストールと PATH を確認してください';
  }
  const command = args[0] === 'lsjson' ? 'lsjson' : 'cat';
  const suffix = detail ? `（${detail}）` : '';
  return `rclone ${command} が失敗しました${suffix}`;
}

export function createRclone({ execFile = nodeExecFile } = {}) {
  function run(args) {
    return new Promise((resolve, reject) => {
      execFile('rclone', args, {
        encoding: 'buffer',
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
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
    cat: remotePath => run(['cat', remotePath]),
    listFiles: remoteDir => run(['lsjson', '--files-only', remoteDir]),
  };
}
