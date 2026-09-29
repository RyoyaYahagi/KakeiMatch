import * as api from '@actual-app/api';
import './style.css';

const results = document.querySelector<HTMLOListElement>('#results')!;
const environment = document.querySelector<HTMLElement>('#environment')!;
const budgetKey = 'actual-browser-spike-budget';
const importedId = 'kakeimatch:spike:receipt:synthetic-1';
const today = '2026-09-29'; // Fixed synthetic date; independent of the device time zone.
let initialized = false;
environment.textContent = `crossOriginIsolated=${crossOriginIsolated}, SharedArrayBuffer=${typeof SharedArrayBuffer}, IndexedDB=${'indexedDB' in window}, User-Agent=${navigator.userAgent}`;

function report(name: string, detail: unknown, ok = true) {
  const item = document.createElement('li');
  item.textContent = `${ok ? '成功' : '失敗'}: ${name} — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  results.append(item);
}

async function check(name: string, action: () => Promise<unknown>) {
  try {
    const detail = await action();
    if (detail === false) throw new Error('期待した値を読み戻せませんでした');
    report(name, detail ?? '完了');
    return detail;
  } catch (error) {
    const quota = error instanceof DOMException && error.name === 'QuotaExceededError';
    report(name, `${error instanceof Error ? error.message : String(error)}${quota ? '。保存容量不足です。家計簿をファイルへ保存し、端末容量を確認してください' : ''}`, false);
    return undefined;
  }
}

async function init() {
  if (!initialized) {
    await api.init({});
    initialized = true;
  }
}

async function loadExisting() {
  await init();
  const budgets = await api.getBudgets();
  report('getBudgets', budgets.map(budget => ({ id: budget.id, name: budget.name })));
  const id = localStorage.getItem(budgetKey) ?? budgets[0]?.id;
  if (!id) throw new Error('端末内に家計簿がありません');
  await api.loadBudget(id);
  localStorage.setItem(budgetKey, id);
  report('loadBudget', id);
  const accounts = await api.getAccounts();
  const categories = await api.getCategories();
  report('getAccounts / getCategories', { accounts: accounts.map(a => a.name), categories: categories.map(c => c.name) });
  for (const account of accounts) {
    const transactions = await api.getTransactions(account.id, '2000-01-01', '2099-12-31');
    report(`getTransactions ${account.name}`, transactions.map(t => ({ id: t.id, amount: t.amount, imported_id: t.imported_id, transfer_id: t.transfer_id, subtransactions: t.subtransactions?.length, notes: t.notes })));
  }
}

async function runScenario() {
  results.replaceChildren();
  if (!crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') {
    report('分離環境', 'COOP/COEP またはブラウザ対応を確認してください', false);
  }
  await init();
  report('init({})', 'serverURL なし');
  const before = await api.getBudgets();
  report('空の端末の家計簿数', before.length);
  if (before.length !== 0) {
    report('空の端末試験', '既存家計簿があります。初期作成の判定には、このサイトのデータを消してから再実行してください', false);
    return;
  }
  await api.runImport('KakeiMatch Spike', async () => {});
  const budgets = await api.getBudgets();
  const budget = budgets.find(item => item.name === 'KakeiMatch Spike');
  if (!budget?.id) throw new Error('runImport 後の家計簿が見つかりません');
  localStorage.setItem(budgetKey, budget.id);
  report('runImport で空状態から作成', budget.id);

  const accountId = await api.createAccount({ name: '人工データ口座' });
  const transferAccountId = await api.createAccount({ name: '人工データ振替先' });
  const accounts = await api.getAccounts();
  report('createAccount / getAccounts', accounts.map(a => a.name));
  const groupId = await api.createCategoryGroup({ name: '人工データ支出' });
  const categoryId = await api.createCategory({ name: '人工データ食費', group_id: groupId });
  await api.updateCategory(categoryId, { name: '人工データ食費更新' });
  const categories = await api.getCategories();
  report('category 作成・更新・取得', categories.find(c => c.id === categoryId)?.name);

  const expense = { account: accountId, date: today, amount: -3284, payee_name: '人工データ店', category: categoryId, imported_id: importedId };
  const first = await api.importTransactions(accountId, [expense]);
  const second = await api.importTransactions(accountId, [expense]);
  const afterDuplicate = await api.getTransactions(accountId, today, today);
  const matching = afterDuplicate.filter(t => t.imported_id === importedId);
  report('importTransactions / stable imported_id', { first, second, matchingCount: matching.length }, matching.length === 1);
  const target = matching[0];
  if (!target) throw new Error('人工データの支出が見つかりません');
  report('JPY 金額', { expectedYen: -3284, actual: target.amount }, target.amount === -3284);
  await api.updateTransaction(target.id, { notes: '人工データ更新' });
  const updated = (await api.getTransactions(accountId, today, today)).find(t => t.id === target.id);
  report('updateTransaction', updated?.notes, updated?.notes === '人工データ更新');
  await api.batchBudgetUpdates(async () => {
    await api.updateTransaction(target.id, { cleared: true });
    await api.updateTransaction(target.id, { notes: '一括更新済み' });
  });
  const batched = (await api.getTransactions(accountId, today, today)).find(t => t.id === target.id);
  report('batchBudgetUpdates', { cleared: batched?.cleared, notes: batched?.notes }, batched?.cleared === true && batched.notes === '一括更新済み');

  await check('income', async () => {
    await api.importTransactions(accountId, [{ account: accountId, date: today, amount: 5000, payee_name: '人工データ収入', imported_id: 'kakeimatch:spike:income' }]);
    return (await api.getTransactions(accountId, today, today)).some(t => t.amount === 5000);
  });
  await check('split', async () => {
    await api.importTransactions(accountId, [{ account: accountId, date: today, amount: -1000, payee_name: '人工データ分割', imported_id: 'kakeimatch:spike:split', subtransactions: [{ amount: -600, category: categoryId }, { amount: -400, category: categoryId }] }]);
    const split = (await api.getTransactions(accountId, today, today)).find(t => t.imported_id === 'kakeimatch:spike:split');
    const children = split?.subtransactions?.map(child => child.amount);
    if (split?.amount !== -1000 || children?.join(',') !== '-600,-400') throw new Error('分割取引の金額が一致しません');
    return { amount: split.amount, children };
  });
  await check('transfer', async () => {
    const payees = await api.getPayees();
    const transferPayee = payees.find(p => p.transfer_acct === transferAccountId);
    if (!transferPayee) throw new Error('振替先口座の payee が見つかりません');
    await api.importTransactions(accountId, [{ account: accountId, date: today, amount: -700, payee: transferPayee.id, imported_id: 'kakeimatch:spike:transfer' }]);
    const source = (await api.getTransactions(accountId, today, today)).find(t => t.imported_id === 'kakeimatch:spike:transfer');
    const destination = (await api.getTransactions(transferAccountId, today, today)).find(t => t.transfer_id === source?.id);
    if (!source?.transfer_id || !destination || destination.amount !== 700) throw new Error('振替先取引を読み戻せませんでした');
    return { source: source.transfer_id, destination: destination.id, valid: true };
  });
  report('検証終了', '家計簿ファイルを保存し、再読込・Safari終了・ホーム画面・オフラインを続けて確認してください');
}

function bind(id: string, action: () => Promise<unknown>) {
  document.querySelector<HTMLButtonElement>(`#${id}`)!.addEventListener('click', () => void check(id, action));
}

bind('run', runScenario);
bind('reload', loadExisting);
bind('edit', async () => {
  await init();
  const budgets = await api.getBudgets();
  const id = localStorage.getItem(budgetKey) ?? budgets[0]?.id;
  if (!id) throw new Error('端末内に家計簿がありません');
  await api.loadBudget(id);
  const account = (await api.getAccounts()).find(item => item.name === '人工データ口座');
  if (!account) throw new Error('人工データ口座がありません');
  const transaction = (await api.getTransactions(account.id, '2000-01-01', '2099-12-31')).find(item => item.imported_id === importedId);
  if (!transaction) throw new Error('人工データ支出がありません');
  const notes = `端末内編集 ${new Date().toISOString()}`;
  await api.updateTransaction(transaction.id, { notes });
  const updated = (await api.getTransactions(account.id, '2000-01-01', '2099-12-31')).find(item => item.id === transaction.id);
  if (updated?.notes !== notes) throw new Error('編集結果を読み戻せませんでした');
  return { id: updated.id, notes: updated.notes };
});
bind('storage', async () => {
  const estimate = await navigator.storage.estimate();
  const persisted = await navigator.storage.persisted();
  return { usage: estimate.usage, quota: estimate.quota, persisted };
});
bind('persist', async () => {
  const granted = await navigator.storage.persist();
  if (!granted) report('永続保存', '許可されませんでした。家計簿をファイルへ保存してください', false);
  return { granted };
});
bind('export', async () => {
  await init();
  await loadExisting();
  const zip = await api.exportBudget();
  const bytes = new Uint8Array(zip);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'kakeimatch-spike-actual.zip';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { byteLength: bytes.byteLength };
});
document.querySelector<HTMLInputElement>('#import')!.addEventListener('change', event => {
  void check('importBudget', async () => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) throw new Error('ファイルが選択されていません');
    await init();
    const imported = await api.importBudget(await file.arrayBuffer(), { filename: file.name });
    localStorage.setItem(budgetKey, imported.id);
    await loadExisting();
    return imported;
  });
});
if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js').then(() => report('Service Worker', '登録済み')).catch(error => report('Service Worker', String(error), false));
}
