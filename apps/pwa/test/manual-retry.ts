import { createActualBrowserLedger } from '../../../src/lib/actual-browser-ledger';
import { showManualTransactionEditor } from '../src/local-transaction-ui';

const records = new Map<string, unknown>();
const rows: Array<Record<string, unknown>> = [];
const accounts = [{ id: 'bank', name: '合成銀行', closed: false }];
const categories = [{ id: 'income', name: '合成収入', is_income: true, hidden: false, group_id: 'income-group' }];
const payees = [{ id: 'payee', name: '合成給与' }];
const state = { saves: 0, cancels: 0, failCleanup: false, failReadback: false, failImport: false, failReads: false };
let failNextRead = false;
const api = {
  init: async () => ({ send: async () => [] }),
  getBudgets: async () => [{ id: 'budget', name: 'Synthetic' }],
  loadBudget: async () => {},
  getAccounts: async () => accounts,
  getCategories: async () => categories,
  getCategoryGroups: async () => [{ id: 'income-group', name: '収入', is_income: true, hidden: false }],
  getPayees: async () => payees,
  getTransactions: async () => {
    if (state.failReads) throw new Error('Synthetic persistent read failure');
    if (failNextRead) { failNextRead = false; throw new Error('Synthetic readback failure'); }
    return rows;
  },
  importTransactions: async (_account: string, values: Array<Record<string, unknown>>) => {
    if (state.failImport) throw new Error('Synthetic failure before import');
    rows.push(...values.map(value => ({ ...value, id: `row-${rows.length + 1}`, payee: 'payee' })));
    if (state.failReadback) { state.failReadback = false; failNextRead = true; }
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
    kind: 'income', onSaved: async () => { state.saves++; document.querySelector('#editor')!.replaceChildren(); },
    onCancel: async () => { state.cancels++; document.querySelector('#editor')!.replaceChildren(); } });
}
Object.assign(window, { manualRetry: { state, rows, records, open } });
open();
