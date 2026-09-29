import * as api from '@actual-app/api';

export type DiagnosticStatus = 'pending' | 'pass' | 'warn' | 'fail';
export type DiagnosticSource = 'automatic' | 'reported' | 'manual';
export type Overall = '診断待ち' | '診断中' | 'GO' | 'GO WITH CONSTRAINTS' | 'NO-GO';

export interface DiagnosticItem {
  id: string;
  label: string;
  section: string;
  status: DiagnosticStatus;
  source: DiagnosticSource;
  detail: string;
  checkedAt?: string;
}

export interface DiagnosticReport {
  version: 2;
  runId: string;
  startedAt: string;
  finishedAt?: string;
  phase: 'running' | 'reload' | 'complete';
  url: string;
  userAgent: string;
  pwa: boolean;
  budgetId?: string;
  expectedSnapshot?: string;
  items: DiagnosticItem[];
}

export interface Progress {
  current: number;
  total: number;
  label: string;
}

type Outcome = { status: DiagnosticStatus; detail: string };
type Transaction = Awaited<ReturnType<typeof api.getTransactions>>[number];
type Account = Awaited<ReturnType<typeof api.getAccounts>>[number];
type Category = Awaited<ReturnType<typeof api.getCategories>>[number];

const date = '2026-09-29'; // Synthetic date, independent of the device time zone.
const previousDate = '2026-09-28';
const resultKey = 'kakeimatch-actual-diagnostic-v2';
const definitions: Array<[string, string, string, DiagnosticSource]> = [
  ['isolation', 'crossOriginIsolated', '環境', 'automatic'],
  ['sharedArrayBuffer', 'SharedArrayBuffer', '環境', 'automatic'],
  ['worker', 'Web Worker', '環境', 'automatic'],
  ['indexedDB', 'IndexedDB の読み書き', '環境', 'automatic'],
  ['wasm', 'WebAssembly', '環境', 'automatic'],
  ['storageEstimate', '保存容量の見積もり', '保存領域', 'automatic'],
  ['storagePersist', '永続保存の許可', '保存領域', 'automatic'],
  ['actualInit', 'Actual local-only 起動', 'Actual', 'automatic'],
  ['emptyState', '空の保存領域', 'Actual', 'automatic'],
  ['budgetCreate', 'ローカル家計簿の作成', 'Actual', 'automatic'],
  ['account', '口座の作成・取得', '口座とカテゴリ', 'automatic'],
  ['accountClosed', '口座の開閉状態', '口座とカテゴリ', 'automatic'],
  ['category', 'カテゴリの作成・更新・取得', '口座とカテゴリ', 'automatic'],
  ['transactionCreate', 'importTransactions', '取引', 'automatic'],
  ['transactionRead', '取引の読み戻し', '取引', 'automatic'],
  ['transactionUpdate', '金額・確認状態の更新', '取引', 'automatic'],
  ['dateRange', '日付範囲での取得', '取引', 'automatic'],
  ['dedupe', 'imported_id の重複防止', '取引', 'automatic'],
  ['batch', '3件の一括更新', '取引', 'automatic'],
  ['jpy1', 'JPY ¥1', 'JPY 金額', 'automatic'],
  ['jpy100', 'JPY ¥100', 'JPY 金額', 'automatic'],
  ['jpy3284', 'JPY ¥3,284', 'JPY 金額', 'automatic'],
  ['jpy100000', 'JPY ¥100,000', 'JPY 金額', 'automatic'],
  ['expense', '支出', '取引の意味', 'automatic'],
  ['income', '収入', '取引の意味', 'automatic'],
  ['transfer', '口座間振替', '取引の意味', 'automatic'],
  ['split', '分割取引', '取引の意味', 'automatic'],
  ['export', '家計簿の書き出し', '復旧', 'automatic'],
  ['importEquality', '読み込み後のデータ一致', '復旧', 'automatic'],
  ['reload', '再読込後のデータ一致', '復旧', 'automatic'],
  ['cleanup', '診断用データの片付け', '復旧', 'automatic'],
  ['safariRestart', 'Safari 終了・再起動後の保持', '実機での確認', 'reported'],
  ['pwaRestart', 'ホーム画面アプリでの保持', '実機での確認', 'reported'],
  ['zipSave', 'iPhone での ZIP 保存', '実機での確認', 'reported'],
  ['zipLoad', 'iPhone での ZIP 読み込み', '実機での確認', 'reported'],
  ['zipReload', 'ZIP 読み込み後の再読込保持', '実機での確認', 'reported'],
  ['offline', 'オフライン起動・編集（この端末）', '実機での確認', 'manual'],
];

const required = new Set([
  'isolation', 'sharedArrayBuffer', 'worker', 'indexedDB', 'wasm', 'actualInit',
  'budgetCreate', 'account', 'category', 'transactionCreate', 'transactionRead',
  'transactionUpdate', 'dedupe', 'batch', 'jpy1', 'jpy100', 'jpy3284', 'jpy100000',
  'expense', 'income', 'transfer', 'split', 'export', 'importEquality', 'reload', 'offline',
]);

const pass = (detail: string): Outcome => ({ status: 'pass', detail });
const warn = (detail: string): Outcome => ({ status: 'warn', detail });

export function createReport(): DiagnosticReport {
  const reportedAt = '2026-09-29';
  return {
    version: 2,
    runId: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    phase: 'running',
    url: location.href,
    userAgent: navigator.userAgent,
    pwa: matchMedia('(display-mode: standalone)').matches || ('standalone' in navigator && (navigator as Navigator & { standalone?: boolean }).standalone === true),
    items: definitions.map(([id, label, section, source]) => ({
      id, label, section, source,
      status: source === 'reported' ? 'pass' : id === 'storagePersist' ? 'warn' : 'pending',
      detail: source === 'reported' ? '利用者が iOS 27.0 / Safari Version/27.0 で確認済み（2026-09-29）' : id === 'storagePersist' ? 'iPhone 実機では persist() = false（利用者報告）' : '',
      checkedAt: source === 'reported' || id === 'storagePersist' ? reportedAt : undefined,
    })),
  };
}

export function readReport(): DiagnosticReport | null {
  try {
    const value = localStorage.getItem(resultKey);
    if (!value) return null;
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || !('version' in parsed) || parsed.version !== 2 || !('items' in parsed) || !Array.isArray(parsed.items)) return null;
    return parsed as DiagnosticReport;
  } catch {
    return null;
  }
}

export function saveReport(report: DiagnosticReport): boolean {
  try {
    localStorage.setItem(resultKey, JSON.stringify(report));
    return true;
  } catch {
    return false;
  }
}

function setResult(report: DiagnosticReport, id: string, outcome: Outcome, source: DiagnosticSource = 'automatic') {
  const item = report.items.find(candidate => candidate.id === id);
  if (!item) throw new Error(`Unknown diagnostic item: ${id}`);
  item.status = outcome.status;
  item.detail = outcome.detail;
  item.source = source;
  item.checkedAt = new Date().toISOString();
}

export function setManualResult(report: DiagnosticReport, id: string, outcome: Outcome) {
  setResult(report, id, outcome, 'manual');
}

export function summarize(report: DiagnosticReport): { pass: number; warn: number; fail: number; pending: number; overall: Overall } {
  const counts = { pass: 0, warn: 0, fail: 0, pending: 0 };
  for (const item of report.items) counts[item.status] += 1;
  let overall: Overall = '診断待ち';
  if (report.phase === 'running' || report.phase === 'reload') overall = '診断中';
  else if (report.items.some(item => required.has(item.id) && item.status === 'fail')) overall = 'NO-GO';
  else if (report.items.some(item => required.has(item.id) && item.status !== 'pass') || counts.warn > 0 || counts.pending > 0) overall = 'GO WITH CONSTRAINTS';
  else overall = 'GO';
  return { ...counts, overall };
}

function failure(error: unknown): Outcome {
  const message = error instanceof Error ? error.message : String(error);
  const quota = error instanceof DOMException && error.name === 'QuotaExceededError';
  return { status: 'fail', detail: quota ? `保存容量不足: ${message}。ZIPを保存し、端末容量を確認してください` : message };
}

async function verifyWorker(): Promise<void> {
  const url = URL.createObjectURL(new Blob(['self.onmessage = event => self.postMessage(event.data);'], { type: 'text/javascript' }));
  const worker = new Worker(url);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Web Worker が応答しませんでした')), 5000);
      worker.onmessage = event => {
        clearTimeout(timer);
        if (event.data === 'ready') resolve();
        else reject(new Error('Web Worker の応答が一致しません'));
      };
      worker.onerror = event => { clearTimeout(timer); reject(new Error(event.message)); };
      worker.postMessage('ready');
    });
  } finally {
    worker.terminate();
    URL.revokeObjectURL(url);
  }
}

async function verifyIndexedDB(runId: string): Promise<void> {
  const name = `kakeimatch-diagnostic-probe-${runId}`;
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('probe');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('probe', 'readwrite');
      transaction.objectStore('probe').put('ok', 'key');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    const value = await new Promise<unknown>((resolve, reject) => {
      const request = db.transaction('probe').objectStore('probe').get('key');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (value !== 'ok') throw new Error('書き込んだ値を読み戻せませんでした');
  } finally {
    db.close();
    indexedDB.deleteDatabase(name);
  }
}

interface Context {
  runId: string;
  prefix: string;
  initialized: boolean;
  budgetsBefore?: number;
  budgetId?: string;
  accountId?: string;
  transferAccountId?: string;
  categoryId?: string;
  expenseId?: string;
  zip?: Uint8Array;
  snapshot?: string;
  importedBudgetId?: string;
}

function importedId(context: Context, suffix: string) {
  return `${context.prefix}:${suffix}`;
}

function needsBudget(context: Context): Outcome | null {
  return context.budgetId ? null : warn('診断専用の家計簿を作成できなかったため未実行');
}

function needsAccount(context: Context): Outcome | null {
  return needsBudget(context) ?? (context.accountId ? null : warn('診断専用の口座を作成できなかったため未実行'));
}

async function importRows(accountId: string, rows: Parameters<typeof api.importTransactions>[1]) {
  const result = await api.importTransactions(accountId, rows);
  if (result.errors.length) throw new Error(result.errors.map(error => error.message).join('; '));
  return result;
}

async function getImported(accountId: string, id: string): Promise<Transaction | undefined> {
  return (await api.getTransactions(accountId, date, date)).find(transaction => transaction.imported_id === id);
}

async function snapshotBudget(): Promise<string> {
  const accounts = await api.getAccounts();
  const categories = await api.getCategories();
  const groups = await api.getCategoryGroups();
  const categoryNames = new Map(categories.map(category => [category.id, category.name]));
  const groupNames = new Map(groups.map(group => [group.id, group.name]));
  const all: Array<{ account: Account; transaction: Transaction }> = [];
  for (const account of accounts) {
    for (const transaction of await api.getTransactions(account.id, previousDate, date)) all.push({ account, transaction });
  }
  const byId = new Map(all.map(({ account, transaction }) => [transaction.id, account.name]));
  const transactions = all.map(({ account, transaction }) => ({
    account: account.name,
    date: transaction.date,
    amount: transaction.amount,
    importedId: transaction.imported_id ?? null,
    cleared: transaction.cleared ?? false,
    category: transaction.category ? categoryNames.get(transaction.category) ?? null : null,
    isParent: transaction.is_parent ?? false,
    isChild: transaction.is_child ?? false,
    transferAccount: transaction.transfer_id ? byId.get(transaction.transfer_id) ?? null : null,
    children: (transaction.subtransactions ?? []).map(child => ({ amount: child.amount, category: child.category ? categoryNames.get(child.category) ?? null : null })).sort((a, b) => a.amount - b.amount),
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify({
    accounts: accounts.map(account => ({ name: account.name, closed: account.closed ?? false })).sort((a, b) => a.name.localeCompare(b.name)),
    categories: categories.map((category: Category) => ({ name: category.name, group: category.group_id ? groupNames.get(category.group_id) ?? null : null, income: category.is_income ?? false })).sort((a, b) => a.name.localeCompare(b.name)),
    transactions,
  });
}

export async function runDiagnostics(onUpdate: (report: DiagnosticReport, progress: Progress) => void): Promise<DiagnosticReport> {
  const report = createReport();
  const context: Context = { runId: report.runId, prefix: `kakeimatch:diagnostic:${report.runId}`, initialized: false };
  const total = definitions.filter(([, , , source]) => source === 'automatic').length;
  let current = 0;
  async function step(id: string, action: () => Promise<Outcome>) {
    current += 1;
    const label = report.items.find(item => item.id === id)?.label ?? id;
    onUpdate(report, { current, total, label: `${label}を確認しています…` });
    try {
      setResult(report, id, await action());
    } catch (error) {
      setResult(report, id, failure(error));
    }
    onUpdate(report, { current, total, label });
  }

  await step('isolation', async () => crossOriginIsolated ? pass('crossOriginIsolated === true') : { status: 'fail', detail: 'crossOriginIsolated === false。COOP/COEP を確認してください' });
  await step('sharedArrayBuffer', async () => typeof SharedArrayBuffer === 'function' ? pass('SharedArrayBuffer を利用可能') : { status: 'fail', detail: 'SharedArrayBuffer を利用できません' });
  await step('worker', async () => { await verifyWorker(); return pass('Blob URL の Web Worker が応答'); });
  await step('indexedDB', async () => { await verifyIndexedDB(report.runId); return pass('一時データベースの open / write / read に成功'); });
  await step('wasm', async () => { await WebAssembly.instantiate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])); return pass('WebAssembly の最小モジュールを起動'); });
  await step('storageEstimate', async () => {
    if (!navigator.storage?.estimate) return warn('navigator.storage.estimate() を利用できません');
    const { usage, quota } = await navigator.storage.estimate();
    if (usage === undefined || quota === undefined) return warn('usage または quota が返されませんでした');
    return pass(`usage=${usage} byte、quota=${quota} byte、使用率=${quota > 0 ? (usage / quota * 100).toFixed(3) : '不明'}%`);
  });
  await step('storagePersist', async () => {
    if (!navigator.storage?.persist) return warn('persist() は利用できません。ZIP を保存してください');
    try {
      const before = navigator.storage.persisted ? await navigator.storage.persisted() : undefined;
      const granted = await navigator.storage.persist();
      return granted ? pass(`persisted()=${before}、persist()=true`) : warn(`persisted()=${before}、persist()=false。ZIP を定期的に保存してください`);
    } catch (error) {
      return warn(`永続保存を要求できませんでした: ${error instanceof Error ? error.message : String(error)}。ZIP を保存してください`);
    }
  });
  await step('actualInit', async () => {
    await api.init({});
    context.initialized = true;
    const budgets = await api.getBudgets();
    context.budgetsBefore = budgets.length;
    return pass(`serverURL・password・Sync ID なしで起動。既存家計簿 ${budgets.length} 件`);
  });
  await step('emptyState', async () => context.budgetsBefore === undefined ? warn('Actual を起動できず、空状態を確認できません') : context.budgetsBefore === 0 ? pass('診断開始時に家計簿 0 件') : warn(`既存家計簿 ${context.budgetsBefore} 件。空の保存領域からの作成は今回確認できません`));
  await step('budgetCreate', async () => {
    if (!context.initialized) return warn('Actual を起動できなかったため未実行');
    const name = `KM Diagnostic ${context.runId.slice(0, 8)}`;
    await api.runImport(name, async () => {});
    const budget = (await api.getBudgets()).find(item => item.name === name);
    if (!budget?.id) throw new Error('runImport 後の診断用家計簿を取得できません');
    context.budgetId = budget.id;
    report.budgetId = budget.id;
    await api.loadBudget(budget.id);
    return pass(`runImport で専用家計簿を作成。${context.budgetsBefore === 0 ? '空の保存領域から成功' : '既存家計簿には触れていません'}`);
  });
  await step('account', async () => {
    const skipped = needsBudget(context); if (skipped) return skipped;
    const prefix = `KM診断 ${context.runId.slice(0, 8)}`;
    context.accountId = await api.createAccount({ name: `${prefix} Wallet` });
    context.transferAccountId = await api.createAccount({ name: `${prefix} Card` });
    const accounts = await api.getAccounts();
    if (!accounts.some(item => item.id === context.accountId && !item.closed) || !accounts.some(item => item.id === context.transferAccountId && !item.closed)) throw new Error('作成した2口座を開いた状態で取得できません');
    return pass('Wallet / Card の2口座を作成・取得');
  });
  await step('accountClosed', async () => {
    const skipped = needsBudget(context); if (skipped) return skipped;
    const id = await api.createAccount({ name: `KM診断 ${context.runId.slice(0, 8)} Closed` });
    await api.closeAccount(id);
    const account = (await api.getAccounts()).find(item => item.id === id);
    return account?.closed ? pass('閉じた口座を closed=true で取得') : warn('閉じた口座を getAccounts で確認できません');
  });
  await step('category', async () => {
    const skipped = needsBudget(context); if (skipped) return skipped;
    const prefix = `KM診断 ${context.runId.slice(0, 8)}`;
    const groupId = await api.createCategoryGroup({ name: `${prefix} Expenses` });
    context.categoryId = await api.createCategory({ name: `${prefix} Food`, group_id: groupId });
    await api.createCategory({ name: `${prefix} Transport`, group_id: groupId });
    await api.updateCategory(context.categoryId, { name: `${prefix} Food Updated` });
    const categories = await api.getCategories();
    if (!categories.some(item => item.id === context.categoryId && item.name === `${prefix} Food Updated`)) throw new Error('更新したカテゴリを取得できません');
    return pass('支出カテゴリ2件を作成、1件を更新し取得');
  });
  await step('transactionCreate', async () => {
    const skipped = needsAccount(context); if (skipped) return skipped;
    const accountId = context.accountId!;
    const id = importedId(context, 'expense-base');
    await importRows(accountId, [{ account: accountId, date, amount: -3284, payee_name: 'KM Diagnostic Store A', category: context.categoryId, imported_id: id, cleared: false }]);
    context.expenseId = (await getImported(accountId, id))?.id;
    if (!context.expenseId) throw new Error('importTransactions 後の取引が見つかりません');
    return pass('人工支出 ¥3,284 を importTransactions で作成');
  });
  await step('transactionRead', async () => {
    const skipped = needsAccount(context); if (skipped) return skipped;
    const transaction = await getImported(context.accountId!, importedId(context, 'expense-base'));
    if (!transaction || transaction.amount !== -3284 || transaction.date !== date || transaction.account !== context.accountId) throw new Error('口座・日付・金額の読み戻しが一致しません');
    return pass('口座・日付・整数円金額を取得');
  });
  await step('transactionUpdate', async () => {
    if (!context.expenseId || !context.accountId) return warn('元の取引を作成できず未実行');
    await api.updateTransaction(context.expenseId, { amount: -3285, cleared: true });
    const changed = await getImported(context.accountId, importedId(context, 'expense-base'));
    if (changed?.amount !== -3285 || changed.cleared !== true) throw new Error('金額または cleared の更新が一致しません');
    await api.updateTransaction(context.expenseId, { amount: -3284 });
    return pass('amount=-3285、cleared=true を読み戻し、金額を元に戻した');
  });
  await step('dateRange', async () => {
    if (!context.accountId) return warn('口座を作成できず未実行');
    const id = importedId(context, 'expense-base');
    const included = (await api.getTransactions(context.accountId, date, date)).some(item => item.imported_id === id);
    const excluded = !(await api.getTransactions(context.accountId, previousDate, previousDate)).some(item => item.imported_id === id);
    if (!included || !excluded) throw new Error('日付範囲の境界が期待と異なります');
    return pass('当日は取得、前日は除外');
  });
  await step('dedupe', async () => {
    if (!context.accountId) return warn('口座を作成できず未実行');
    const accountId = context.accountId;
    const id = importedId(context, 'dedupe-001');
    const row = { account: accountId, date, amount: -100, payee_name: 'KM Diagnostic Dedupe', imported_id: id };
    const before = (await api.getTransactions(accountId, date, date)).filter(item => item.imported_id === id).length;
    const first = await importRows(accountId, [row]);
    const middle = (await api.getTransactions(accountId, date, date)).filter(item => item.imported_id === id).length;
    const second = await importRows(accountId, [row]);
    const after = (await api.getTransactions(accountId, date, date)).filter(item => item.imported_id === id).length;
    if (before !== 0 || middle !== 1 || after !== 1 || first.added.length !== 1 || second.added.length !== 0) throw new Error(`重複防止が成立しません: 件数 ${before}→${middle}→${after}`);
    return pass(`同一 imported_id を2回取り込み、件数 ${before}→${middle}→${after}`);
  });
  await step('batch', async () => {
    if (!context.accountId) return warn('口座を作成できず未実行');
    const accountId = context.accountId;
    const ids = ['A', 'B', 'C'].map(letter => importedId(context, `batch-${letter}`));
    await importRows(accountId, ids.map((id, index) => ({ account: accountId, date, amount: -(index + 1) * 10, payee_name: `KM Diagnostic ${index}`, imported_id: id, cleared: false })));
    const all = await api.getTransactions(accountId, date, date);
    const target = ids.map(id => all.find(item => item.imported_id === id));
    if (target.some(item => !item)) throw new Error('3件の取引が揃いません');
    for (const item of target) await api.updateTransaction(item!.id, { cleared: false });
    await api.batchBudgetUpdates(async () => { for (const item of target) await api.updateTransaction(item!.id, { cleared: true }); });
    const updated = await api.getTransactions(accountId, date, date);
    if (!ids.every(id => updated.find(item => item.imported_id === id)?.cleared === true)) throw new Error('3件すべてが cleared=true になりません');
    return pass('3件を cleared=false から true へ一括更新し、全件を読み戻した');
  });
  for (const value of [1, 100, 3284, 100000]) {
    await step(`jpy${value}`, async () => {
      if (!context.accountId) return warn('口座を作成できず未実行');
      const accountId = context.accountId;
      const id = importedId(context, `jpy-${value}`);
      await importRows(accountId, [{ account: accountId, date, amount: -value, payee_name: 'KM Diagnostic JPY', imported_id: id }]);
      const created = await getImported(accountId, id);
      if (!created || created.amount !== -value) throw new Error(`書き込み後の金額が -${value} 円と一致しません`);
      await api.updateTransaction(created.id, { amount: -(value + 1) });
      const updated = await getImported(accountId, id);
      if (updated?.amount !== -(value + 1)) throw new Error(`更新後の金額が -${value + 1} 円と一致しません`);
      await api.updateTransaction(created.id, { amount: -value });
      if ((await getImported(accountId, id))?.amount !== -value) throw new Error('元の整数円金額へ戻せません');
      return pass(`-${value} 円を作成・取得し、-${value + 1} 円へ更新・取得後に復元`);
    });
  }
  await step('expense', async () => {
    if (!context.accountId) return warn('口座を作成できず未実行');
    const transaction = await getImported(context.accountId, importedId(context, 'expense-base'));
    if (!transaction || transaction.amount >= 0 || transaction.transfer_id || transaction.is_child) throw new Error('負の通常支出として判別できません');
    return pass(`amount=${transaction.amount}、transfer_id なし、child ではない`);
  });
  await step('income', async () => {
    if (!context.accountId) return warn('口座を作成できず未実行');
    const accountId = context.accountId;
    const id = importedId(context, 'income');
    await importRows(accountId, [{ account: accountId, date, amount: 5000, payee_name: 'KM Diagnostic Income', imported_id: id }]);
    const transaction = await getImported(accountId, id);
    if (!transaction || transaction.amount !== 5000 || transaction.transfer_id) throw new Error('収入と支出を区別できません');
    return pass('amount=5000。正額かつ振替ではないため収入として区別可能');
  });
  await step('transfer', async () => {
    if (!context.accountId || !context.transferAccountId) return warn('2口座を作成できず未実行');
    const payee = (await api.getPayees()).find(item => item.transfer_acct === context.transferAccountId);
    if (!payee) throw new Error('振替先口座の payee が見つかりません');
    const id = importedId(context, 'transfer');
    await importRows(context.accountId, [{ account: context.accountId, date, amount: -700, payee: payee.id, imported_id: id }]);
    const source = await getImported(context.accountId, id);
    const counterpart = (await api.getTransactions(context.transferAccountId, date, date)).find(item => item.id === source?.transfer_id);
    if (!source?.transfer_id || !counterpart || counterpart.amount !== 700 || counterpart.transfer_id !== source.id) throw new Error('振替元・振替先の対応と金額が一致しません');
    return pass('元口座 -700 円、先口座 +700 円。相互の transfer_id で振替と判別可能');
  });
  await step('split', async () => {
    if (!context.accountId) return warn('口座を作成できず未実行');
    const accountId = context.accountId;
    const id = importedId(context, 'split');
    await importRows(accountId, [{ account: accountId, date, amount: -1000, payee_name: 'KM Diagnostic Split', imported_id: id, subtransactions: [{ amount: -600, category: context.categoryId }, { amount: -400, category: context.categoryId }] }]);
    const parent = await getImported(accountId, id);
    const children = parent?.subtransactions ?? [];
    if (!parent || parent.amount !== -1000 || children.length !== 2 || children.reduce((sum, child) => sum + child.amount, 0) !== -1000 || !parent.is_parent) throw new Error('親子の識別または金額合計が一致しません');
    return pass(`親 is_parent=true、子 ${children.length} 件、子の合計 -1000 円。親子の二重計上を避けられる`);
  });
  await step('export', async () => {
    const skipped = needsBudget(context); if (skipped) return skipped;
    context.snapshot = await snapshotBudget();
    report.expectedSnapshot = context.snapshot;
    context.zip = new Uint8Array(await api.exportBudget());
    if (!context.zip.byteLength) throw new Error('書き出し ZIP が空です');
    return pass(`合成家計簿の ZIP ${context.zip.byteLength} byte を生成`);
  });
  await step('importEquality', async () => {
    if (!context.zip || !context.snapshot || !context.budgetId) return warn('ZIP の書き出しに失敗したため未実行');
    try {
      const imported = await api.importBudget(context.zip, { filename: 'kakeimatch-diagnostic.zip' });
      context.importedBudgetId = imported.id;
      await api.loadBudget(imported.id);
      const actual = await snapshotBudget();
      if (actual !== context.snapshot) throw new Error('口座・カテゴリ・取引・cleared・imported_id・振替・分割が書き出し前と一致しません');
      return pass(`ZIP 読み込み後の合成データが一致。imported Budget ID: ${imported.id}`);
    } finally {
      await api.loadBudget(context.budgetId);
    }
  });
  await step('cleanup', async () => context.budgetId ? warn(`Actual browser 公開APIに deleteBudget がありません。診断専用 Budget が端末に残ります${context.importedBudgetId && context.importedBudgetId !== context.budgetId ? '（ZIP読込分を含む）' : ''}`) : pass('診断用 Budget は作成されていません'));

  if (context.budgetId && context.snapshot) {
    report.phase = 'reload';
    report.budgetId = context.budgetId;
    report.expectedSnapshot = context.snapshot;
    onUpdate(report, { current, total, label: '再読込後の保持を確認するため、ページを再読込します…' });
  } else {
    setResult(report, 'reload', warn('比較する家計簿の記録がないため未実行'));
    report.phase = 'complete';
    report.finishedAt = new Date().toISOString();
    onUpdate(report, { current: total, total, label: '診断が完了しました' });
  }
  return report;
}

export async function resumeAfterReload(report: DiagnosticReport, onUpdate: (report: DiagnosticReport, progress: Progress) => void): Promise<DiagnosticReport> {
  if (report.phase !== 'reload') return report;
  const total = definitions.filter(([, , , source]) => source === 'automatic').length;
  onUpdate(report, { current: total, total, label: '再読込後の家計簿を確認しています…' });
  try {
    if (!report.budgetId || !report.expectedSnapshot) throw new Error('比較する診断用家計簿の記録がありません');
    await api.init({});
    await api.loadBudget(report.budgetId);
    if (await snapshotBudget() !== report.expectedSnapshot) throw new Error('再読込後の合成データが一致しません');
    setResult(report, 'reload', pass('再読込後も口座・カテゴリ・取引・cleared・imported_id・振替・分割が一致'));
  } catch (error) {
    setResult(report, 'reload', failure(error));
  }
  report.phase = 'complete';
  report.finishedAt = new Date().toISOString();
  onUpdate(report, { current: total, total, label: '診断が完了しました' });
  return report;
}

export async function checkOffline(report: DiagnosticReport): Promise<Outcome> {
  if (navigator.onLine) return warn('オンラインです。機内モードで開き直してから「Offline確認」を押してください');
  try {
    if (!report.budgetId) return warn('診断用家計簿がありません');
    await api.init({});
    await api.loadBudget(report.budgetId);
    const accounts = await api.getAccounts();
    const account = accounts.find(item => item.name.includes(report.runId.slice(0, 8)) && item.name.endsWith('Wallet'));
    if (!account) throw new Error('診断用口座を取得できません');
    const transaction = (await api.getTransactions(account.id, date, date)).find(item => item.imported_id === `kakeimatch:diagnostic:${report.runId}:expense-base`);
    if (!transaction) throw new Error('診断用取引を取得できません');
    const notes = `offline-${new Date().toISOString()}`;
    await api.updateTransaction(transaction.id, { notes });
    if ((await api.getTransactions(account.id, date, date)).find(item => item.id === transaction.id)?.notes !== notes) throw new Error('オフライン編集を読み戻せません');
    return pass('機内モードで既存取引の取得とメモ編集に成功');
  } catch (error) {
    return failure(error);
  }
}

export function formatReport(report: DiagnosticReport): string {
  const summary = summarize(report);
  const ios = report.userAgent.match(/(?:iPhone OS|CPU OS) ([\d_]+)/)?.[1]?.replaceAll('_', '.') ?? '利用者報告: 27.0';
  const lines = [
    'KakeiMatch Actual Browser Diagnostic',
    `Date: ${report.finishedAt ?? report.startedAt}`,
    `URL: ${report.url}`,
    `User Agent: ${report.userAgent}`,
    `iOS: ${ios}`,
    `PWA: ${report.pwa}`,
    '',
    `Overall: ${summary.overall}`,
    `PASS ${summary.pass} / WARN ${summary.warn} / FAIL ${summary.fail} / PENDING ${summary.pending}`,
  ];
  let section = '';
  for (const item of report.items) {
    if (section !== item.section) { section = item.section; lines.push('', section); }
    lines.push(`${item.status.toUpperCase()} ${item.label}: ${item.detail || '未実行'}${item.source === 'reported' ? ' [利用者報告]' : ''}`);
  }
  lines.push('', 'Constraints:', '- persist() が false の場合は手動 ZIP バックアップが必要', '- 診断専用 Budget は公開 API で削除できない');
  return lines.join('\n');
}
