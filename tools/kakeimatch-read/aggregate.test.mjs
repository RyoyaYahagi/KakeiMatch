import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compareMonthly, recomputeMonthly } from './lib/aggregate.mjs';
import { execute } from './lib/cli.mjs';
import { clone, loadSample } from './helpers.mjs';

test('サンプルの monthly は取引から計算し直した値と一致する', () => {
  const snapshot = loadSample('snapshot-sample-normal');
  assert.deepEqual(compareMonthly(snapshot), []);
  const october = recomputeMonthly(snapshot).get('2026-10');
  assert.equal(october.incomeYen, 250000);
  assert.equal(october.expenseYen, 5400);
  assert.deepEqual([...october.categories.values()].map(category => category.amountYen).sort((a, b) => a - b), [500, 640, 4260]);
});

test('予算対象外・支出除外・振替・0円は集計に入らない', () => {
  const snapshot = clone(loadSample('snapshot-sample-normal'));
  snapshot.transactions.push({
    id: 'tx-zero',
    date: '2026-10-15',
    amountYen: 0,
    kind: 'expense',
    accountId: 'acc-bank',
    categoryId: 'cat-food',
    categoryName: '食費',
    payeeName: null,
    memo: null,
    transferAccountId: null,
    excludedFromSpending: false,
    splits: [],
  });
  assert.deepEqual(compareMonthly(snapshot), []);
  const october = recomputeMonthly(snapshot).get('2026-10');
  assert.equal(october.categories.get('cat-food').amountYen, 4260);
});

test('monthly の収入・支出・カテゴリ別金額を書き換えると警告になる', () => {
  const income = clone(loadSample('snapshot-sample-normal'));
  income.monthly[1].incomeYen += 1;
  income.monthly[1].balanceYen += 1;
  const incomeWarnings = compareMonthly(income);
  assert.equal(incomeWarnings.length, 1);
  assert.match(incomeWarnings[0].message, /2026-10 の収入/);
  assert.equal(incomeWarnings[0].code, 'monthly-income-mismatch');

  const expense = clone(loadSample('snapshot-sample-normal'));
  expense.monthly[0].expenseYen -= 1;
  expense.monthly[0].balanceYen += 1;
  const expenseWarnings = compareMonthly(expense);
  assert.equal(expenseWarnings.length, 1);
  assert.match(expenseWarnings[0].message, /2026-09 の支出/);

  const category = clone(loadSample('snapshot-sample-normal'));
  category.monthly[1].byCategory[0].amountYen += 100;
  const categoryWarnings = compareMonthly(category);
  assert.equal(categoryWarnings.length, 1);
  assert.match(categoryWarnings[0].message, /カテゴリ別支出/);
  assert.match(categoryWarnings[0].message, /食費/);
});

test('--strict は警告があると終了コード 3 になる', async () => {
  const snapshot = clone(loadSample('snapshot-sample-normal'));
  snapshot.monthly[1].incomeYen += 1000;
  snapshot.monthly[1].balanceYen += 1000;
  const dir = mkdtempSync(join(tmpdir(), 'kakeimatch-read-'));
  const path = join(dir, 'snapshot.json');
  writeFileSync(path, JSON.stringify(snapshot));

  const warned = await execute(['summary', '--file', path]);
  assert.equal(warned.exitCode, 0);
  assert.match(warned.stderr, /警告: 2026-10 の収入/);
  assert.match(warned.stdout, /警告: 1件/);

  const strict = await execute(['summary', '--file', path, '--strict']);
  assert.equal(strict.exitCode, 3);

  const json = await execute(['summary', '--file', path, '--json', '--strict']);
  assert.equal(json.exitCode, 3);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.warnings.length, 1);
  assert.equal(parsed.warnings[0].month, '2026-10');

  const sample = loadSample('snapshot-sample-normal');
  const cleanPath = join(dir, 'clean.json');
  writeFileSync(cleanPath, JSON.stringify(sample));
  assert.equal((await execute(['summary', '--file', cleanPath, '--strict'])).exitCode, 0);
});
