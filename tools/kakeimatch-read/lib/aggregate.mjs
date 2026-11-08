// 取引と口座から月次集計を計算し直し、ファイル内の monthly と比べる。
// 規則は apps/ios/KakeiMatch/Data/Aggregation/TransactionAggregation.swift の
// KMTransactionAggregation.monthly(transactions:accounts:categories:month:) に合わせる。
import { checkedAdd, formatYen } from './money.mjs';
import { monthOfDate } from './time.mjs';

const NULL_CATEGORY_KEY = '\u0000';

function categoryKey(categoryId) {
  return categoryId === null ? NULL_CATEGORY_KEY : categoryId;
}

function emptyBucket() {
  return { incomeYen: 0, expenseYen: 0, categories: new Map() };
}

function addCategory(bucket, categoryId, categoryName, amountYen) {
  const key = categoryKey(categoryId);
  const current = bucket.categories.get(key);
  if (current) {
    current.amountYen = checkedAdd(current.amountYen, amountYen);
    if (current.categoryName === null && typeof categoryName === 'string') current.categoryName = categoryName;
    return;
  }
  bucket.categories.set(key, { categoryId, categoryName: typeof categoryName === 'string' ? categoryName : null, amountYen });
}

export function recomputeMonthly(snapshot) {
  const offBudget = new Set(snapshot.accounts.filter(account => account.offBudget === true).map(account => account.id));
  const months = new Map();
  const bucketFor = month => {
    let bucket = months.get(month);
    if (!bucket) {
      bucket = emptyBucket();
      months.set(month, bucket);
    }
    return bucket;
  };
  for (const transaction of snapshot.transactions) {
    // 予算対象外の口座は集計しない。
    if (offBudget.has(transaction.accountId)) continue;
    // 支出集計から外した出金は集計しない（入金は Swift 実装と同じく残す）。
    if (transaction.excludedFromSpending && transaction.amountYen < 0) continue;
    // 振替は収入・支出のどちらにも数えない。
    if (transaction.kind === 'transfer') continue;
    const bucket = bucketFor(monthOfDate(transaction.date));
    if (transaction.amountYen > 0) {
      bucket.incomeYen = checkedAdd(bucket.incomeYen, transaction.amountYen);
      continue;
    }
    if (transaction.amountYen === 0) continue;
    bucket.expenseYen = checkedAdd(bucket.expenseYen, -transaction.amountYen);
    if (transaction.splits.length > 0) {
      for (const split of transaction.splits) {
        addCategory(bucket, split.categoryId, split.categoryName, -split.amountYen);
      }
    } else {
      addCategory(bucket, transaction.categoryId, transaction.categoryName, -transaction.amountYen);
    }
  }
  return months;
}

function categoryLabel(categoryId, categoryName) {
  if (typeof categoryName === 'string') return categoryName;
  if (categoryId === null) return '未分類';
  return `カテゴリ名不明（${categoryId}）`;
}

function compareCategories(month, fileCategories, expectedCategories) {
  const warnings = [];
  const keys = new Set([...fileCategories.keys(), ...expectedCategories.keys()]);
  const sorted = [...keys].sort((left, right) => {
    const leftName = categoryLabel(fileCategories.get(left)?.categoryId ?? expectedCategories.get(left)?.categoryId ?? null,
      fileCategories.get(left)?.categoryName ?? expectedCategories.get(left)?.categoryName ?? null);
    const rightName = categoryLabel(fileCategories.get(right)?.categoryId ?? expectedCategories.get(right)?.categoryId ?? null,
      fileCategories.get(right)?.categoryName ?? expectedCategories.get(right)?.categoryName ?? null);
    if (leftName !== rightName) return leftName < rightName ? -1 : 1;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  for (const key of sorted) {
    const file = fileCategories.get(key);
    const expected = expectedCategories.get(key);
    const fileAmount = file?.amountYen ?? 0;
    const expectedAmount = expected?.amountYen ?? 0;
    if (fileAmount === expectedAmount) continue;
    const label = categoryLabel(
      file?.categoryId ?? expected?.categoryId ?? null,
      file?.categoryName ?? expected?.categoryName ?? null,
    );
    warnings.push({
      code: 'monthly-category-mismatch',
      month,
      message: `${month} のカテゴリ別支出が取引と一致しません: ${label}（ファイル ${formatYen(fileAmount)} 円 / 再計算 ${formatYen(expectedAmount)} 円）`,
    });
  }
  return warnings;
}

export function compareMonthly(snapshot) {
  const recomputed = recomputeMonthly(snapshot);
  const warnings = [];
  for (const entry of snapshot.monthly) {
    const expected = recomputed.get(entry.month) ?? emptyBucket();
    if (entry.incomeYen !== expected.incomeYen) {
      warnings.push({
        code: 'monthly-income-mismatch',
        month: entry.month,
        message: `${entry.month} の収入が取引と一致しません（ファイル ${formatYen(entry.incomeYen)} 円 / 再計算 ${formatYen(expected.incomeYen)} 円）`,
      });
    }
    if (entry.expenseYen !== expected.expenseYen) {
      warnings.push({
        code: 'monthly-expense-mismatch',
        month: entry.month,
        message: `${entry.month} の支出が取引と一致しません（ファイル ${formatYen(entry.expenseYen)} 円 / 再計算 ${formatYen(expected.expenseYen)} 円）`,
      });
    }
    const fileCategories = new Map();
    for (const category of entry.byCategory) {
      const key = categoryKey(category.categoryId);
      const current = fileCategories.get(key);
      if (current) {
        current.amountYen = checkedAdd(current.amountYen, category.amountYen);
      } else {
        fileCategories.set(key, {
          categoryId: category.categoryId,
          categoryName: category.categoryName,
          amountYen: category.amountYen,
        });
      }
    }
    warnings.push(...compareCategories(entry.month, fileCategories, expected.categories));
  }
  return warnings;
}
