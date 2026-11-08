// 既定の出力（人が読む日本語の表）。金額は3桁区切りにするだけで、計算はしない。
import { formatYen } from './money.mjs';
import { formatAge } from './time.mjs';

const ACCOUNT_TYPE_LABELS = {
  bank: '銀行',
  credit_card: 'クレジットカード',
  cash: '現金',
  other: 'その他',
};

function accountTypeLabel(type) {
  return ACCOUNT_TYPE_LABELS[type] ?? type;
}

function accountLine(account) {
  const closed = account.closed ? '（利用終了）' : '';
  return `${account.name}｜${accountTypeLabel(account.type)}｜${formatYen(account.balanceYen)} 円${closed}`;
}

function warningLines(warnings) {
  if (warnings.length === 0) return ['警告: なし'];
  return [`警告: ${warnings.length}件`, ...warnings.map(warning => `- ${warning.message}`)];
}

export function renderSummary(data) {
  const lines = [
    'KakeiMatch スナップショット',
    `generatedAt: ${data.generatedAt}（${formatAge(data.ageSeconds)}）`,
    `期間: ${data.range.fromMonth} 〜 ${data.range.toMonth}（${data.months}か月）`,
    `口座: ${data.accounts.total}件（利用中 ${data.accounts.open} / 利用終了 ${data.accounts.closed}）`,
    `取引: ${data.transactions}件`,
    ...warningLines(data.warnings),
  ];
  return `${lines.join('\n')}\n`;
}

export function renderBalances(data) {
  const onBudget = data.accounts.filter(account => !account.offBudget);
  const offBudget = data.accounts.filter(account => account.offBudget);
  const lines = [`残高（generatedAt: ${data.generatedAt} 時点）`];
  lines.push(`予算対象（${onBudget.length}件）`);
  if (onBudget.length === 0) lines.push('- なし');
  for (const account of onBudget) lines.push(`- ${accountLine(account)}`);
  lines.push(`予算対象 合計: ${formatYen(data.totals.onBudgetYen)} 円`);
  if (offBudget.length > 0) {
    lines.push(`予算対象外（${offBudget.length}件）`);
    for (const account of offBudget) lines.push(`- ${accountLine(account)}`);
    lines.push(`予算対象外 合計: ${formatYen(data.totals.offBudgetYen)} 円`);
  }
  lines.push(`合計: ${formatYen(data.totals.allYen)} 円`);
  if (!data.includeClosed) lines.push('利用終了の口座は含めていません（--include-closed で含める）');
  lines.push(...warningLines(data.warnings));
  return `${lines.join('\n')}\n`;
}

export function renderTransactions(data) {
  const lines = [`取引（新しい順、generatedAt: ${data.generatedAt} 時点）`];
  if (data.matched === 0) {
    lines.push('該当する取引はありません');
  } else {
    const suffix = data.matched > data.shown ? `（--limit ${data.limit} で打ち切り）` : '';
    lines.push(`一致 ${data.matched}件中 ${data.shown}件を表示${suffix}`);
    for (const transaction of data.transactions) {
      const transferTo = transaction.transferAccountName ?? transaction.transferAccountId;
      const category = transaction.kind === 'transfer' ? `振替（${transferTo ?? '相手口座不明'}）`
        : transaction.splits.length > 0 ? '分割' : transaction.categoryName ?? '未分類';
      const excluded = transaction.excludedFromSpending ? '｜集計外' : '';
      const payee = transaction.payeeName ?? '（店名なし）';
      const memo = transaction.memo ? `（${transaction.memo}）` : '';
      lines.push(`${transaction.date}｜${payee}${memo}｜${category}｜${formatYen(transaction.amountYen)} 円｜${transaction.accountName ?? transaction.accountId}${excluded}`);
    }
  }
  lines.push(...warningLines(data.warnings));
  return `${lines.join('\n')}\n`;
}

export function renderMonthly(data) {
  const lines = [
    `${data.month} の収支（generatedAt: ${data.generatedAt} 時点）`,
    `収入: ${formatYen(data.incomeYen)} 円`,
    `支出: ${formatYen(data.expenseYen)} 円`,
    `差額: ${formatYen(data.balanceYen)} 円`,
  ];
  if (data.byCategory.length === 0) {
    lines.push('カテゴリ別支出: なし');
  } else {
    lines.push('カテゴリ別支出:');
    for (const category of data.byCategory) {
      lines.push(`- ${category.categoryName}: ${formatYen(category.amountYen)} 円`);
    }
  }
  lines.push(...warningLines(data.warnings));
  return `${lines.join('\n')}\n`;
}

export function renderValidate(data) {
  const lines = [
    '検証に成功しました',
    `generatedAt: ${data.generatedAt}`,
    `期間: ${data.range.fromMonth} 〜 ${data.range.toMonth}`,
    `口座: ${data.accounts}件 / 取引: ${data.transactions}件 / 月次: ${data.months}件`,
  ];
  lines.push(...warningLines(data.warnings));
  return `${lines.join('\n')}\n`;
}

export const RENDERERS = {
  summary: renderSummary,
  balances: renderBalances,
  transactions: renderTransactions,
  monthly: renderMonthly,
  validate: renderValidate,
};
