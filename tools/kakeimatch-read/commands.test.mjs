import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execute } from './lib/cli.mjs';
import { clone, loadSample, snapshotBytes } from './helpers.mjs';

const NORMAL = new URL('../../test/fixtures/muse-snapshot/snapshot-sample-normal.json', import.meta.url).pathname;
const EMPTY = new URL('../../test/fixtures/muse-snapshot/snapshot-sample-empty.json', import.meta.url).pathname;

function json(result) {
  assert.equal(result.exitCode, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('summary は generatedAt・経過時間・range・件数・警告を返す', async () => {
  const data = json(await execute(['summary', '--file', NORMAL, '--json']));
  assert.equal(data.command, 'summary');
  assert.equal(data.generatedAt, '2026-11-08T09:00:00+09:00');
  assert.equal(typeof data.ageSeconds, 'number');
  assert.deepEqual(data.range, { fromMonth: '2026-09', toMonth: '2026-10' });
  assert.equal(data.months, 2);
  assert.deepEqual(data.accounts, { total: 5, open: 4, closed: 1 });
  assert.equal(data.transactions, 12);
  assert.deepEqual(data.warnings, []);
  const human = await execute(['summary', '--file', NORMAL]);
  assert.match(human.stdout, /generatedAt: 2026-11-08T09:00:00\+09:00/);
  assert.match(human.stdout, /期間: 2026-09 〜 2026-10/);
});

test('balances は口座ごとの残高と予算対象・対象外の合計を返す', async () => {
  const data = json(await execute(['balances', '--file', NORMAL, '--json']));
  assert.equal(data.accounts.length, 4);
  assert.ok(!data.accounts.some(account => account.id === 'acc-old'));
  assert.deepEqual(data.totals, { onBudgetYen: 177120, offBudgetYen: 450000, allYen: 627120 });
  assert.equal(data.generatedAt, '2026-11-08T09:00:00+09:00');
  const included = json(await execute(['balances', '--file', NORMAL, '--json', '--include-closed']));
  assert.equal(included.accounts.length, 5);
  assert.ok(included.accounts.some(account => account.id === 'acc-old'));
  assert.equal(included.totals.allYen, 627120);
  const human = await execute(['balances', '--file', NORMAL, '--include-closed']);
  assert.match(human.stdout, /予算対象外/);
  assert.match(human.stdout, /利用終了/);
  assert.match(human.stdout, /generatedAt/);
});

test('transactions は新しい順に返し、月・期間・口座・カテゴリ・件数で絞れる', async () => {
  const all = json(await execute(['transactions', '--file', NORMAL, '--json']));
  assert.equal(all.matched, 12);
  assert.equal(all.shown, 12);
  assert.equal(all.limit, 50);
  assert.deepEqual(all.transactions.map(item => item.id).slice(0, 3), ['tx-1001', 'tx-1002', 'tx-1003']);
  assert.equal(all.transactions[0].accountName, '合成カード');
  assert.equal(all.transactions[0].splits.length, 2);

  const month = json(await execute(['transactions', '--file', NORMAL, '--json', '--month', '2026-09']));
  assert.equal(month.matched, 4);
  assert.ok(month.transactions.every(item => item.date.startsWith('2026-09')));

  const range = json(await execute(['transactions', '--file', NORMAL, '--json', '--from', '2026-10-01', '--to', '2026-10-12']));
  assert.deepEqual(range.transactions.map(item => item.date), ['2026-10-12', '2026-10-05', '2026-10-03']);

  const account = json(await execute(['transactions', '--file', NORMAL, '--json', '--account', 'acc-card']));
  assert.equal(account.matched, 6);
  assert.ok(account.transactions.every(item => item.accountId === 'acc-card'));

  const byName = json(await execute(['transactions', '--file', NORMAL, '--json', '--category', '食費']));
  assert.deepEqual(byName.transactions.map(item => item.id), ['tx-1001', 'tx-1008', 'tx-0903', 'tx-0904']);
  const byId = json(await execute(['transactions', '--file', NORMAL, '--json', '--category', 'cat-food']));
  assert.deepEqual(byId.transactions.map(item => item.id), byName.transactions.map(item => item.id));

  const limited = json(await execute(['transactions', '--file', NORMAL, '--json', '--limit', '3']));
  assert.equal(limited.matched, 12);
  assert.equal(limited.shown, 3);
  const human = await execute(['transactions', '--file', NORMAL, '--limit', '3']);
  assert.match(human.stdout, /一致 12件中 3件/);
  assert.match(human.stdout, /generatedAt/);
});

test('monthly は既定で range の最後の月を返し、--month で選べる', async () => {
  const latest = json(await execute(['monthly', '--file', NORMAL, '--json']));
  assert.equal(latest.month, '2026-10');
  assert.equal(latest.incomeYen, 250000);
  assert.equal(latest.expenseYen, 5400);
  assert.equal(latest.balanceYen, 244600);
  assert.deepEqual(latest.byCategory.map(category => category.amountYen), [4260, 640, 500]);
  assert.equal(latest.generatedAt, '2026-11-08T09:00:00+09:00');

  const september = json(await execute(['monthly', '--file', NORMAL, '--json', '--month', '2026-09']));
  assert.equal(september.month, '2026-09');
  assert.equal(september.incomeYen, 248300);
  const human = await execute(['monthly', '--file', NORMAL]);
  assert.match(human.stdout, /2026-10 の収支/);
  assert.match(human.stdout, /generatedAt/);
});

test('空のサンプルでも各サブコマンドが動く', async () => {
  const summary = json(await execute(['summary', '--file', EMPTY, '--json']));
  assert.deepEqual(summary.accounts, { total: 0, open: 0, closed: 0 });
  const balances = json(await execute(['balances', '--file', EMPTY, '--json']));
  assert.deepEqual(balances.totals, { onBudgetYen: 0, offBudgetYen: 0, allYen: 0 });
  const transactions = json(await execute(['transactions', '--file', EMPTY, '--json']));
  assert.equal(transactions.matched, 0);
  assert.equal(transactions.shown, 0);
  const monthly = json(await execute(['monthly', '--file', EMPTY, '--json']));
  assert.equal(monthly.month, '2026-11');
  const human = await execute(['transactions', '--file', EMPTY]);
  assert.match(human.stdout, /該当する取引はありません/);
});

test('validate は検証結果だけを表示する', async () => {
  const data = json(await execute(['validate', '--file', NORMAL, '--json']));
  assert.equal(data.valid, true);
  assert.equal(data.generatedAt, '2026-11-08T09:00:00+09:00');
  assert.equal(data.accounts, 5);
  assert.equal(data.transactions, 12);
  assert.equal(data.months, 2);
  const human = await execute(['validate', '--file', NORMAL]);
  assert.match(human.stdout, /検証に成功しました/);
  assert.match(human.stdout, /generatedAt/);
});

test('validate も集計の警告を --json の warnings と終了コードに反映する', async () => {
  const snapshot = clone(loadSample('snapshot-sample-normal'));
  snapshot.monthly[1].incomeYen += 1;
  snapshot.monthly[1].balanceYen += 1;
  const options = { readStdin: () => snapshotBytes(snapshot) };
  const result = await execute(['validate', '--file', '-', '--json'], options);
  assert.equal(result.exitCode, 0);
  const data = JSON.parse(result.stdout);
  assert.equal(data.valid, true);
  assert.deepEqual(data.warnings.map(warning => warning.code), ['monthly-income-mismatch']);
  assert.equal((await execute(['validate', '--file', '-', '--strict'], options)).exitCode, 3);
});

test('--remote は使えず、標準入力で渡す方法を案内する', async () => {
  const result = await execute(['summary', '--remote', 'gdrive:KakeiMatch/snapshot.json']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /--remote はありません/);
  assert.match(result.stderr, /--file -/);
});

test('使い方の誤りは終了コード 1 になる', async () => {
  const cases = [
    [],
    ['unknown'],
    ['summary'],
    ['summary', '--file', NORMAL, '--dir', '.'],
    ['summary', '--file', NORMAL, '--month', '2026-10'],
    ['transactions', '--file', NORMAL, '--from', '2026-10-01'],
    ['transactions', '--file', NORMAL, '--month', '2026-10', '--from', '2026-10-01', '--to', '2026-10-02'],
    ['transactions', '--file', NORMAL, '--limit', '0'],
    ['transactions', '--file', NORMAL, '--account', 'acc-missing'],
    ['monthly', '--file', NORMAL, '--month', '2026-08'],
    ['monthly', '--file', NORMAL, '--month', '2026-13'],
    ['summary', '--file', NORMAL, '--bogus'],
    ['summary', '--file'],
  ];
  for (const argv of cases) {
    const result = await execute(argv, { env: {} });
    assert.equal(result.exitCode, 1, `${argv.join(' ')}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /使い方|サブコマンド|オプション|指定|形式|含まれません|ありません|正の整数|後です|両方/);
  }
});

test('読めないファイルと検証に失敗するファイルは終了コード 2 になる', async () => {
  const missing = await execute(['summary', '--file', '/no/such/kakeimatch-snapshot.json']);
  assert.equal(missing.exitCode, 2);
  assert.match(missing.stderr, /読めません/);

  const dir = mkdtempSync(join(tmpdir(), 'kakeimatch-read-'));
  const invalidPath = join(dir, 'snapshot.json');
  const invalid = clone(loadSample('snapshot-sample-normal'));
  invalid.kind = 'kakeimatch-backup';
  writeFileSync(invalidPath, snapshotBytes(invalid));
  const invalidResult = await execute(['summary', '--file', invalidPath]);
  assert.equal(invalidResult.exitCode, 2);
  assert.match(invalidResult.stderr, /kind/);
  assert.equal(invalidResult.stdout, '');
});

test('--help は使い方を表示して終了コード 0 になる', async () => {
  const result = await execute(['--help']);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /kakeimatch-read <サブコマンド>/);
  assert.match(result.stdout, /終了コード/);
});
