// Read-only adapter, loaded by Playwright from the local Vite server (not shipped).
import { createActualBrowserLedger } from '../../../src/lib/actual-browser-ledger';
import { LocalDataRepository } from '../../../src/lib/local-data';
import { createAccountMetadataAccess } from '../src/local-account-metadata';
import { LocalMonthlyBudgetService } from '../src/local-monthly-budget-service';
import { categoryRank } from '../src/category-tone';

const text = value => value == null || !String(value).trim() ? null : String(value).normalize('NFC').trim();
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const canonical = value => JSON.stringify(value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
const sorted = rows => rows.sort((a, b) => {
  const field = Object.keys(a)[0];
  return compare(a[field] ?? '', b[field] ?? '') || compare(canonical(a), canonical(b));
});

export async function snapshot(scenario) {
  const repository = await LocalDataRepository.open();
  const { value: { budgetId, dataDir } } = await repository.get('settings:budget');
  const ledger = createActualBrowserLedger({ ...createAccountMetadataAccess(repository), getBudgetId: () => budgetId, getDataDir: () => dataDir, saveBudgetId: async () => { throw new Error('read only'); } });
  const accounts = await ledger.getAccountBalances();
  const categories = await ledger.listCategories();
  const accountName = id => text(accounts.find(a => a.id === id)?.name);
  const categoryName = id => text(categories.find(c => c.id === id)?.name);
  const transactions = await ledger.getTransactions({ startDate: '0001-01-01', endDate: '9999-12-31' });
  const normalizedTransactions = [];
  for (const row of transactions) {
    const tree = row.isSplit ? await ledger.getTransactionTree(row.id) : null;
    const children = tree?.filter(child => child.parent_id === row.id) ?? [];
    normalizedTransactions.push({ date: row.date, amountYen: row.amountYen, kind: row.kind,
      payee: row.kind === 'transfer' ? null : text(row.payeeName), category: text(row.categoryName), memo: text(row.memo), account: accountName(row.accountId),
      cleared: !!row.cleared, excludedFromSpending: !!row.excludedFromSpending,
      transferAccount: accountName(row.transferAccountId),
      splits: sorted(children.map(c => ({ category: categoryName(c.category), amountYen: c.amount, memo: text(c.notes), payee: text(c.payee ? row.payeeName : null) }))) });
  }
  const month = '2026-10';
  const summary = await ledger.getMonthlySummary({ yearMonth: month });
  const budget = await new LocalMonthlyBudgetService(repository, ledger, budgetId).getSummary(month);
  // Resolution fields are persisted UI state, not IDs/fingerprints/timestamps.
  const records = await repository.list();
  const statements = records.filter(r => r.kind === 'statement-transaction');
  const resolutions = records.filter(r => r.kind === 'reconciliation-resolution');
  const pointer = await repository.get('reconciliation:latest-run');
  const run = records.find(r => r.kind === 'reconciliation-run' && r.value.runId === pointer?.value.runId)?.value;
  // The screen combines pending rows from the latest run with resolutions from ALL
  // runs. A post-confirmation run intentionally omits already resolved statements.
  const statusItems = sorted(statements.flatMap(({ value: statement }) => {
    const result = run?.statementResults.find(r => r.statementTransactionId === statement.id);
    const resolution = resolutions.find(r => r.value.statementId === statement.id && !r.value.undoRequestedAt)?.value;
    if (!resolution && !result) return [];
    const status = resolution?.status === 'failed' ? 'failed' : resolution?.status === 'applied'
      ? ({ ignored: 'ignored', same_expense: 'matched', no_receipt: 'registered', transfer: 'registered' })[resolution.resolution]
      : ({ needs_review: 'needs-review', unmatched_statement: 'unmatched', matched: 'matched' })[result?.status] ?? 'failed';
    return [{ merchant: text(statement.merchant), date: statement.usedDate, amountYen: statement.amountYen, status }];
  }));
  const counts = Object.fromEntries(['matched', 'needs-review', 'unmatched', 'ignored', 'failed'].map(status => [status, statusItems.filter(i => i.status === status).length]));
  const usage = new Map();
  for (const row of transactions.filter(t => t.kind !== 'transfer')) {
    const tree = row.isSplit ? await ledger.getTransactionTree(row.id) : [];
    for (const id of new Set([row.categoryId, ...tree.filter(c => c.parent_id === row.id).map(c => c.category)].filter(Boolean))) usage.set(id, (usage.get(id) ?? 0) + 1);
  }
  const orderedCategories = [...categories].sort((a,b) => Number(a.isIncome)-Number(b.isIncome) || Number(a.hidden)-Number(b.hidden) || (usage.get(b.id) ?? 0)-(usage.get(a.id) ?? 0) || categoryRank(a.name)-categoryRank(b.name));
  const items = sorted(resolutions.map(({ value: r }) => {
    const statement = statements.find(s => s.id === r.statementId)?.value;
    return { merchant: text(statement?.merchant ?? r.statementSnapshot?.merchant), date: statement?.usedDate ?? r.statementSnapshot?.usedDate ?? null,
      amountYen: r.statementAmountYen, resolution: r.resolution, status: r.status, undone: !!r.undoRequestedAt };
  }));
  return { format: 'kakeimatch-ledger-snapshot', version: 1, scenario,
    accounts: sorted(accounts.map(a => ({ name: text(a.name), type: a.accountType, closed: !!a.closed, balanceYen: a.balanceYen }))),
    // Preserve PWA's category display order, including hidden masters.
    categories: orderedCategories.map(c => ({ name: text(c.name), group: text(c.groupName), isIncome: c.isIncome, hidden: c.hidden })),
    transactions: normalizedTransactions.sort((a,b) => compare(b.date,a.date) || compare(a.payee ?? '',b.payee ?? '') || a.amountYen-b.amountYen || compare(a.account ?? '',b.account ?? '') || compare(a.memo ?? '',b.memo ?? '') || compare(canonical(a),canonical(b))),
    monthly: [{ month, incomeYen: summary.incomeYen, expenseYen: summary.expenseYen, balanceYen: summary.balanceYen,
      categories: sorted(summary.categories.filter(c => c.amountYen !== 0).map(c => ({ category: text(c.categoryName), amountYen: c.amountYen }))) }],
    budgets: [{ month, budgetYen: budget.budgetYen, spentYen: budget.spentYen, remainingYen: budget.remainingYen,
      budgetConfigured: budget.budgetConfigured, overallBudgetConfigured: budget.overallBudgetConfigured, breakdownEnabled: budget.breakdownEnabled,
      categories: sorted(budget.categories.map(c => ({ category: text(c.categoryName), budgetYen: c.budgetYen, spentYen: c.spentYen, remainingYen: c.remainingYen }))) }],
    reconciliation: { counts, statements: statusItems, items } };
}
