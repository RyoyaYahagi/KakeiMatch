import { initializeMasterUi } from '../src/local-master-ui';

declare global {
  interface Window {
    masterNavigationFailureState: typeof state;
  }
}

const category = { id: 'synthetic-category', name: '合成カテゴリ', isIncome: false, hidden: false, groupName: '支出' };
const account = { id: 'synthetic-account', name: '合成支払元', accountType: 'bank', closed: false, balanceYen: 1200 };
const state: {
  failCategories: boolean;
  failCategoryUsage: boolean;
  failAccountBalances: boolean;
  failProvider: boolean;
  deferCategories: boolean;
  rejectCategories?: (error: Error) => void;
} = { failCategories: false, failCategoryUsage: false, failAccountBalances: false, failProvider: false, deferCategories: false };
const ledger = {
  listCategories: async () => {
    if (state.deferCategories) return new Promise<typeof category[]>((_resolve, reject) => { state.rejectCategories = reject; });
    if (state.failCategories) throw new Error('合成カテゴリ一覧の取得に失敗しました。');
    return [category];
  },
  getCategoryUsage: async () => {
    if (state.failCategoryUsage) throw new Error('合成カテゴリ利用数の取得に失敗しました。');
    return 0;
  },
  getAccountBalances: async () => {
    if (state.failAccountBalances) throw new Error('合成口座残高の取得に失敗しました。');
    return [account];
  },
} as never;

initializeMasterUi(document.querySelector<HTMLElement>('#settings-top')!, ledger, {
  onBack: () => {},
  getStatementProvider: async () => {
    if (state.failProvider) throw new Error('合成明細サービスの取得に失敗しました。');
    return null;
  },
});

Object.assign(window, { masterNavigationFailureState: state });
