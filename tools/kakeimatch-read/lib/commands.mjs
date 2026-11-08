// 各サブコマンドのデータと既定の表示を組み立てる。
import { UsageError } from './errors.mjs';
import { checkedAdd } from './money.mjs';
import { isDate, isMonth, monthList, monthOfDate } from './time.mjs';
import { RENDERERS } from './format.mjs';

function buildSummary(snapshot, warnings, now) {
  const closed = snapshot.accounts.filter(account => account.closed).length;
  const data = {
    command: 'summary',
    generatedAt: snapshot.generatedAt,
    ageSeconds: Math.floor((now.getTime() - Date.parse(snapshot.generatedAt)) / 1000),
    range: { ...snapshot.range },
    months: monthList(snapshot.range.fromMonth, snapshot.range.toMonth).length,
    accounts: {
      total: snapshot.accounts.length,
      open: snapshot.accounts.length - closed,
      closed,
    },
    transactions: snapshot.transactions.length,
    warnings,
  };
  return { data, human: RENDERERS.summary(data) };
}

function buildBalances(snapshot, options, warnings) {
  const includeClosed = options.includeClosed === true;
  const accounts = snapshot.accounts
    .filter(account => includeClosed || !account.closed)
    .map(account => ({
      id: account.id,
      name: account.name,
      type: account.type,
      closed: account.closed,
      offBudget: account.offBudget,
      balanceYen: account.balanceYen,
    }));
  let onBudgetYen = 0;
  let offBudgetYen = 0;
  for (const account of accounts) {
    if (account.offBudget) offBudgetYen = checkedAdd(offBudgetYen, account.balanceYen);
    else onBudgetYen = checkedAdd(onBudgetYen, account.balanceYen);
  }
  const data = {
    command: 'balances',
    generatedAt: snapshot.generatedAt,
    includeClosed,
    accounts,
    totals: {
      onBudgetYen,
      offBudgetYen,
      allYen: checkedAdd(onBudgetYen, offBudgetYen),
    },
    warnings,
  };
  return { data, human: RENDERERS.balances(data) };
}

function matchesCategory(transaction, category) {
  if (transaction.categoryId === category || transaction.categoryName === category) return true;
  return transaction.splits.some(split => split.categoryId === category || split.categoryName === category);
}

function presentTransaction(transaction, accountNames) {
  const presented = {
    id: transaction.id,
    date: transaction.date,
    amountYen: transaction.amountYen,
    kind: transaction.kind,
    accountId: transaction.accountId,
    accountName: accountNames.get(transaction.accountId) ?? null,
    categoryId: transaction.categoryId,
    categoryName: transaction.categoryName,
    payeeName: transaction.payeeName,
    memo: transaction.memo,
    transferAccountId: transaction.transferAccountId,
    transferAccountName: transaction.transferAccountId === null ? null : accountNames.get(transaction.transferAccountId) ?? null,
    excludedFromSpending: transaction.excludedFromSpending,
    // Kept as an array even when empty, like the snapshot itself.
    splits: transaction.splits.map(split => ({
      id: split.id,
      categoryId: split.categoryId,
      categoryName: split.categoryName,
      amountYen: split.amountYen,
      payeeName: split.payeeName,
      memo: split.memo,
    })),
  };
  return presented;
}

function buildTransactions(snapshot, options, warnings) {
  const month = options.month ?? null;
  const from = options.from ?? null;
  const to = options.to ?? null;
  const category = options.category ?? null;
  const accountId = options.accountId ?? null;
  const limit = options.limit ?? 50;
  if (month !== null && !isMonth(month)) {
    throw new UsageError(`--month が yyyy-MM 形式ではありません: ${month}`);
  }
  if ((from === null) !== (to === null)) {
    throw new UsageError('--from と --to は両方指定してください');
  }
  if (from !== null && !isDate(from)) throw new UsageError(`--from が yyyy-MM-dd の日付ではありません: ${from}`);
  if (to !== null && !isDate(to)) throw new UsageError(`--to が yyyy-MM-dd の日付ではありません: ${to}`);
  if (from !== null && from > to) throw new UsageError(`--from（${from}）が --to（${to}）より後です`);
  if (month !== null && from !== null) {
    throw new UsageError('--month と --from / --to は同時に指定できません');
  }
  if (accountId !== null && !snapshot.accounts.some(account => account.id === accountId)) {
    throw new UsageError(`口座 ${accountId} はスナップショットの accounts にありません`);
  }
  const matched = snapshot.transactions
    .map((transaction, index) => ({ transaction, index }))
    .filter(({ transaction }) => {
      if (month !== null && monthOfDate(transaction.date) !== month) return false;
      if (from !== null && (transaction.date < from || transaction.date > to)) return false;
      if (accountId !== null && transaction.accountId !== accountId) return false;
      if (category !== null && !matchesCategory(transaction, category)) return false;
      return true;
    })
    .sort((left, right) => {
      if (left.transaction.date !== right.transaction.date) {
        return left.transaction.date < right.transaction.date ? 1 : -1;
      }
      return left.index - right.index;
    });
  const accountNames = new Map(snapshot.accounts.map(account => [account.id, account.name]));
  const selected = matched.slice(0, limit).map(({ transaction }) => presentTransaction(transaction, accountNames));
  const data = {
    command: 'transactions',
    generatedAt: snapshot.generatedAt,
    filters: { month, from, to, accountId, category },
    matched: matched.length,
    shown: selected.length,
    limit,
    transactions: selected,
    warnings,
  };
  return { data, human: RENDERERS.transactions(data) };
}

function buildMonthly(snapshot, options, warnings) {
  const months = monthList(snapshot.range.fromMonth, snapshot.range.toMonth);
  const month = options.month ?? snapshot.range.toMonth;
  if (!isMonth(month)) throw new UsageError(`--month が yyyy-MM 形式ではありません: ${month}`);
  if (!months.includes(month)) {
    throw new UsageError(`${month} は range（${snapshot.range.fromMonth} 〜 ${snapshot.range.toMonth}）に含まれません`);
  }
  const entry = snapshot.monthly.find(item => item.month === month);
  const byCategory = [...entry.byCategory]
    .map(category => ({
      categoryId: category.categoryId,
      categoryName: category.categoryName,
      amountYen: category.amountYen,
    }))
    .sort((left, right) => right.amountYen - left.amountYen);
  const data = {
    command: 'monthly',
    generatedAt: snapshot.generatedAt,
    month,
    incomeYen: entry.incomeYen,
    expenseYen: entry.expenseYen,
    balanceYen: entry.balanceYen,
    byCategory,
    warnings,
  };
  return { data, human: RENDERERS.monthly(data) };
}

function buildValidate(snapshot, warnings) {
  const data = {
    command: 'validate',
    generatedAt: snapshot.generatedAt,
    valid: true,
    range: { ...snapshot.range },
    accounts: snapshot.accounts.length,
    transactions: snapshot.transactions.length,
    months: snapshot.monthly.length,
    warnings,
  };
  return { data, human: RENDERERS.validate(data) };
}

export function runCommand(command, options, snapshot, warnings, now) {
  switch (command) {
    case 'summary':
      return buildSummary(snapshot, warnings, now);
    case 'balances':
      return buildBalances(snapshot, options, warnings);
    case 'transactions':
      return buildTransactions(snapshot, options, warnings);
    case 'monthly':
      return buildMonthly(snapshot, options, warnings);
    case 'validate':
      return buildValidate(snapshot, warnings);
    default:
      throw new UsageError(`不明なサブコマンドです: ${command}`);
  }
}
