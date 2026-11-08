// コマンドライン解析と実行。ファイルやネットワークへの書き込みは行わない。
import { readFileSync, readdirSync } from 'node:fs';
import { UsageError, SnapshotError } from './errors.mjs';
import { loadSnapshot } from './source.mjs';
import { compareMonthly } from './aggregate.mjs';
import { runCommand } from './commands.mjs';
import { createRclone } from './rclone.mjs';

const COMMANDS = new Set(['summary', 'balances', 'transactions', 'monthly', 'validate']);
const GLOBAL_FLAGS = new Set(['--json', '--strict']);
const BOOLEAN_FLAGS = new Set(['--json', '--strict', '--include-closed']);
const VALUE_FLAGS = new Set(['--file', '--dir', '--remote', '--month', '--from', '--to', '--account', '--category', '--limit']);
const ALLOWED_FLAGS = {
  summary: [],
  balances: ['--include-closed'],
  transactions: ['--month', '--from', '--to', '--account', '--category', '--limit'],
  monthly: ['--month'],
  validate: [],
};

export const USAGE = `KakeiMatch の読み取り専用スナップショットを表示します。

使い方:
  kakeimatch-read <サブコマンド> [オプション]

サブコマンド:
  summary                       生成日時・期間・件数・警告
  balances [--include-closed]   口座ごとの残高と合計
  transactions [--month yyyy-MM | --from yyyy-MM-dd --to yyyy-MM-dd]
               [--account <id>] [--category <id または名前>] [--limit N]
                                取引を新しい順に表示（既定 50 件）
  monthly [--month yyyy-MM]     月次の収入・支出・カテゴリ別支出
  validate                      形式の検証だけを行う

読み込み元（どれか1つ）:
  --file <path>                 ファイル。\`-\` で標準入力
  --dir <dir>                   ローカルのディレクトリ
  --remote <path>               rclone のパス。\`/\` で終わるとディレクトリ
  環境変数 KAKEIMATCH_SNAPSHOT  ファイルのパス

共通オプション:
  --json      機械向けの JSON で出力する
  --strict    警告があれば終了コード 3 にする
  --help      この使い方を表示する

終了コード: 0 成功 / 1 使い方の誤り / 2 読めない・検証に失敗 / 3 --strict で警告あり
`;

function parseLimit(value) {
  if (!/^\d+$/.test(value)) throw new UsageError(`--limit が正の整数ではありません: ${value}`);
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new UsageError(`--limit が正の整数ではありません: ${value}`);
  }
  return limit;
}

function readFlagValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new UsageError(`${flag} の値がありません`);
  }
  if (value === '') throw new UsageError(`${flag} の値が空です`);
  return value;
}

export function parseArgs(argv, env = process.env) {
  const flags = new Map();
  let command = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return { command: 'help', json: false, strict: false, source: null, options: {} };
    if (argument.startsWith('--')) {
      if (BOOLEAN_FLAGS.has(argument)) {
        flags.set(argument, true);
        continue;
      }
      if (!VALUE_FLAGS.has(argument)) throw new UsageError(`不明なオプションです: ${argument}`);
      flags.set(argument, readFlagValue(argv, index, argument));
      index += 1;
      continue;
    }
    if (argument.startsWith('-') && argument !== '-') throw new UsageError(`不明なオプションです: ${argument}`);
    if (command !== null) throw new UsageError(`コマンドは1つだけ指定できます: ${command} と ${argument}`);
    command = argument;
  }
  if (command === null) throw new UsageError('サブコマンドを指定してください');
  if (!COMMANDS.has(command)) throw new UsageError(`不明なサブコマンドです: ${command}`);
  for (const flag of flags.keys()) {
    if (GLOBAL_FLAGS.has(flag)) continue;
    if (flag === '--file' || flag === '--dir' || flag === '--remote') continue;
    if (!ALLOWED_FLAGS[command].includes(flag)) {
      throw new UsageError(`${command} では ${flag} を使えません`);
    }
  }
  const sourceFlags = ['--file', '--dir', '--remote'].filter(flag => flags.has(flag));
  if (sourceFlags.length > 1) {
    throw new UsageError('読み込み元は --file / --dir / --remote のどれか1つだけ指定してください');
  }
  let source;
  if (sourceFlags.length === 1) {
    const flag = sourceFlags[0];
    source = { kind: flag.slice(2), value: flags.get(flag) };
  } else if (env.KAKEIMATCH_SNAPSHOT) {
    source = { kind: 'file', value: env.KAKEIMATCH_SNAPSHOT };
  } else {
    throw new UsageError('読み込み元がありません（--file / --dir / --remote、または環境変数 KAKEIMATCH_SNAPSHOT）');
  }
  const options = {
    includeClosed: flags.get('--include-closed') === true,
    month: flags.get('--month'),
    from: flags.get('--from'),
    to: flags.get('--to'),
    accountId: flags.get('--account'),
    category: flags.get('--category'),
    limit: flags.has('--limit') ? parseLimit(flags.get('--limit')) : 50,
  };
  return {
    command,
    json: flags.get('--json') === true,
    strict: flags.get('--strict') === true,
    source,
    options,
  };
}

function createIo(options) {
  return {
    readFile: options.readFile ?? (path => readFileSync(path)),
    readDir: options.readDir ?? (dir => readdirSync(dir, { withFileTypes: true })),
    readStdin: options.readStdin ?? (() => readFileSync(0)),
    rclone: options.rclone ?? (() => createRclone({ execFile: options.execFile })),
    now: options.now ?? (() => new Date()),
  };
}

export async function execute(argv, options = {}) {
  const io = createIo(options);
  try {
    const parsed = parseArgs(argv, options.env ?? process.env);
    if (parsed.command === 'help') return { exitCode: 0, stdout: USAGE, stderr: '' };
    const { snapshot } = await loadSnapshot(parsed.source, io);
    const warnings = compareMonthly(snapshot);
    const result = runCommand(parsed.command, parsed.options, snapshot, warnings, io.now());
    const stdout = parsed.json ? `${JSON.stringify(result.data, null, 2)}\n` : result.human;
    const stderr = warnings.map(warning => `警告: ${warning.message}\n`).join('');
    return { exitCode: parsed.strict && warnings.length > 0 ? 3 : 0, stdout, stderr };
  } catch (error) {
    if (error instanceof UsageError) {
      return { exitCode: 1, stdout: '', stderr: `${error.message}\n\n${USAGE}` };
    }
    if (error instanceof SnapshotError) {
      return { exitCode: 2, stdout: '', stderr: `${error.messages.join('\n')}\n` };
    }
    throw error;
  }
}
