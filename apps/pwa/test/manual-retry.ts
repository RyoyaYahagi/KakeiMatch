import { createActualBrowserLedger } from '../../../src/lib/actual-browser-ledger';
import { showManualTransactionEditor } from '../src/local-transaction-ui';

const records = new Map<string, unknown>();
const rows: Array<Record<string, unknown>> = [];
const accounts = [{ id: 'bank', name: '合成銀行', closed: false }];
const categories = [{ id: 'income', name: '合成収入', is_income: true, hidden: false, group_id: 'income-group' }];
const payees = [{ id: 'payee', name: '合成給与' }];
const state = { saves: 0, failCleanup: false, failReadback: false };
const api = {
  init: async () => ({ send: async () => [] }),
  getBudgets: async () => [{ id: 'budget', name: 'Synthetic' }],
  loadBudget: async () => {},
  getAccounts: async () => accounts,
  getCategories: async () => categories,
  getCategoryGroups: async () => [{ id: 'income-group', name: '収入', is_income: true, hidden: false }],
  getPayees: async () => payees,
  getTransactions: async () => {
    if (state.failReadback && rows.length) { state.failReadback = false; throw new Error('Synthetic readback failure'); }
    return rows;
  },
  importTransactions: async (_account: string, values: Array<Record<string, unknown>>) => {
    rows.push(...values.map(value => ({ ...value, id: `row-${rows.length + 1}`, payee: 'payee' })));
    return { errors: [], added: [] };
  },
};
const ledger = createActualBrowserLedger({ api: api as never, getBudgetId: () => 'budget', saveBudgetId: async () => {} });
const repository = {
  get: async (id: string) => records.get(id),
  put: async (record: { id: string }) => { records.set(record.id, structuredClone(record)); },
  delete: async (id: string) => {
    if (state.failCleanup) { state.failCleanup = false; throw new Error('Synthetic cleanup failure'); }
    records.delete(id);
  },
};
function open() {
  showManualTransactionEditor({ view: document.querySelector<HTMLElement>('#editor')!, ledger, repository: repository as never,
    kind: 'income', onSaved: async () => { state.saves++; document.querySelector('#editor')!.replaceChildren(); }, onCancel: async () => {} });
}
Object.assign(window, { manualRetry: { state, rows, records, open } });
open();
