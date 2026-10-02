import { renderMonthlyBudgets, showMonthlyBudgetEditor } from './local-monthly-budgets';
import { LocalRecurringService } from './local-recurring';
import { showRecurringSchedules } from './local-recurring-ui';
import { attachReceiptSearchItems, emptySearchFilters, type TransactionSearchFilters } from './local-transaction-search';
import { showTransactionSearch } from './local-transaction-search-ui';
import { renderMonthlyDashboard, monthEnd, shiftMonth } from './local-monthly-dashboard';
import { LocalTransactionDeletionService } from './local-transaction-deletions';
import { showManualTransactionEditor } from './local-transaction-ui';
import type { ActualTransaction } from '../../../src/lib/actual-ledger';
import { initializeMasterUi, createMasterShortcut } from './local-master-ui';
import { initializeBackupUi } from './local-backup-ui';
import { restoreStandaloneBudget, type LocalBudgetSettings } from './local-backup';
import { ActualBudgetSelectionRequiredError, createActualBrowserLedger } from '../../../src/lib/actual-browser-ledger';
import { LocalDataRepository } from '../../../src/lib/local-data';
import { LocalReceiptService, type LocalReceipt, type ReceiptItem, type ReceiptAdjustment } from './local-receipts';
import { LocalStatementService } from './local-statements';
import type { StatementProvider } from './statement-parser';
import { LocalReconciliationService } from './local-reconciliation';
import { CATEGORY_LABELS, isCategoryId } from '../../../src/lib/category';

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const yen = (n: number) => `¥${Math.abs(n).toLocaleString('ja-JP')}`;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
function text(tag: string, value: string, className = '') { const node = document.createElement(tag); node.textContent = value; node.className = className; return node; }
function button(label: string, action: () => Promise<unknown> | void, secondary = true) {
  const node = document.createElement('button'); node.type = 'button'; node.textContent = label; node.className = secondary ? 'secondary' : '';
  node.addEventListener('click', () => { void busy(node, action); }); return node;
}
async function busy(node: HTMLButtonElement, action: () => Promise<unknown> | void) {
  node.disabled = true;
  try { await action(); } catch (error) { report(error); } finally { node.disabled = false; }
}
function report(error: unknown) {
  const message = error instanceof Error && /[ぁ-んァ-ヶ一-龠]/.test(error.message) ? error.message : '操作を完了できませんでした。保存済みのデータを確認して再試行してください。';
  el('message').textContent = message;
}
type ReceiptDraft = { merchant: string; purchasedDate: string; purchasedTime: string | null; totalAmountYen: number; categoryId: string; accountId: string; items: ReceiptItem[]; adjustments: ReceiptAdjustment[]; taxAmountYen: number | null; memo?: string | null };
function fieldLabel<K extends keyof HTMLElementTagNameMap>(tag: K, value: string, id: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = value;
  if (node instanceof HTMLLabelElement) node.htmlFor = id;
  return node;
}
function parseNullableInteger(value: string): number | null { if (!value.trim()) return null; const parsed = Number(value); return Number.isSafeInteger(parsed) ? parsed : null; }
function parseNullableNumber(value: string): number | null { if (!value.trim()) return null; const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }

export async function initializeLocalUi(options: { openAccount: () => void }) {
  const repository = await LocalDataRepository.open();
  const saved = await repository.get<LocalBudgetSettings>('settings:budget');
  let budgetId = saved?.value.budgetId ?? null;
  const dataDir = saved?.value.dataDir ?? '/documents';
  const ledger = createActualBrowserLedger({ getBudgetId: () => budgetId, getDataDir: () => dataDir, saveBudgetId: async id => {
    budgetId = id; await repository.put({ id: 'settings:budget', kind: 'app-settings', value: { budgetId: id, dataDir }, updatedAt: new Date().toISOString() });
  } });
  const receipts = new LocalReceiptService(repository, ledger);
  const statements = new LocalStatementService(repository);
  const reconciliation = new LocalReconciliationService(repository, ledger);
  const deletions = new LocalTransactionDeletionService(repository, ledger);
  const recurring = new LocalRecurringService(repository, ledger);
  const view = el('local-view');
  const deletionToast = text('div', '', 'deletion-toast'); deletionToast.setAttribute('role', 'status');
  el('message').after(deletionToast);
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  function showDeletionToast(audit: { operationId: string; undoUntil: string }) {
    if (toastTimer) clearTimeout(toastTimer);
    const remaining = Date.parse(audit.undoUntil) - Date.now();
    deletionToast.replaceChildren(text('span', '削除しました。'));
    if (remaining <= 0) return;
    const undo = button('元に戻す', async () => { await deletions.undo(audit.operationId); if (toastTimer) clearTimeout(toastTimer); await returnToRecords(); deletionToast.replaceChildren(text('span', '削除を取り消しました。')); });
    deletionToast.append(undo, text('span', '10秒以内なら元に戻せます。'));
    toastTimer = setTimeout(() => { deletionToast.replaceChildren(text('span', '削除しました。')); }, remaining);
  }
  function deleteButton(id: string) {
    const remove = button('削除する', async () => {
      if (!window.confirm('この取引を削除しますか？レシート画像などの原本は残ります。')) return;
      const audit = await deletions.delete(id);
      await returnToRecords(); showDeletionToast(audit);
    });
    remove.classList.add('destructive'); return remove;
  }
  let imageUrl: string | null = null;
  let resetMasterUi = () => {};
  let openAccountBalances: () => Promise<void> = () => Promise.resolve();
  let flushReceiptDraft: () => Promise<void> = () => Promise.resolve();
  async function open(tab: 'home' | 'receipt' | 'statement' | 'reconciliation') { await flushReceiptDraft(); flushReceiptDraft = () => Promise.resolve(); resetMasterUi(); if (imageUrl) { URL.revokeObjectURL(imageUrl); imageUrl = null; }
    el('household-view').hidden = tab !== 'home'; el('settings-view').hidden = true; view.hidden = tab === 'home';
    for (const id of ['home', 'receipt', 'statement', 'reconciliation', 'settings']) {
      const item = el(`${id}-tab`); const active = id === tab || (tab === 'statement' && id === 'settings'); item.classList.toggle('active', active); item.setAttribute('aria-pressed', String(active));
    }
    el('message').textContent = ''; view.replaceChildren();
  }
  let selectedMonth = today().slice(0, 7);
  let searchFilters: TransactionSearchFilters = { ...emptySearchFilters };
  let searchOrigin = false;
  let newEntryReturn: () => Promise<void> = () => recordsPage();
  let homeRevision = 0;
  async function home() {
    searchOrigin = false;
    const revision = ++homeRevision;
    el('home-summary').setAttribute('aria-busy', 'true');
    await open('home');
    const month = selectedMonth;
    const [rows, summary, budgetSummary] = await Promise.all([ledger.getTransactions({ startDate: `${month}-01`, endDate: monthEnd(month) }), ledger.getMonthlySummary({ yearMonth: month }), ledger.getMonthlyBudgets({ yearMonth: month })]);
    if (revision !== homeRevision || el('household-view').hidden) return;
    renderMonthlyDashboard(el('home-summary'), summary, today().slice(0, 7), action => {
      selectedMonth = action.type === 'current' ? today().slice(0, 7) : shiftMonth(selectedMonth, action.offset);
      void home().catch(report);
    });
    renderMonthlyBudgets(el('home-summary'), budgetSummary, () => { void budgetEditor().catch(report); });
    const list = el('transactions'); list.replaceChildren();
    for (const row of rows.filter(row => row.kind !== 'transfer' || row.amountYen < 0)) {
      const item = document.createElement('li'); item.className = 'row'; const entry = button(`${row.date} · ${row.payeeName || (row.kind === 'transfer' ? '口座間振替' : row.kind === 'income' ? '収入' : '支出')} · ${row.kind === 'transfer' ? '振替 ' : row.kind === 'income' ? '収入 ' : ''}${yen(row.amountYen)}`, () => transactionDetail(row)); entry.className = 'transaction-entry'; item.append(entry); list.append(item);
    }
    if (!rows.length) list.append(text('li', 'まだ記録がありません。'));

    const resolutions = await reconciliation.resolutions();
    const latest = await reconciliation.latest();
    const attention = resolutions.filter(r => r.status !== 'applied').length + (latest?.statementResults.filter(r => r.status !== 'matched' && !resolutions.some(d => d.statementId === r.statementTransactionId)).length ?? 0);
    el('home-attention').replaceChildren(button(latest ? `確認が必要な明細 ${attention}件` : '明細を取り込んで照合してください', reviewPage));
    if (revision === homeRevision) el('home-summary').setAttribute('aria-busy', 'false');
  }
  async function budgetEditor() {
    await open('statement');
    await showMonthlyBudgetEditor({ view, ledger, yearMonth: selectedMonth, onBack: () => el('settings-tab').click(), onMonth: month => { selectedMonth = month; } });
  }
  async function recurringOverview() {
    await open('statement');
    await showRecurringSchedules({ view, ledger, service: recurring, onBack: () => el('settings-tab').click() });
  }
  async function recordChooser() {
    newEntryReturn = recordsPage;
    await open('receipt'); view.append(text('h2', '記録する'));
    view.append(button('支出', expenseMethodChooser), button('収入', () => { newEntryReturn = recordChooser; return manualEditor('income'); }), button('口座間振替', () => { newEntryReturn = recordChooser; return manualEditor('transfer'); }),
      button('記録一覧へ戻る', recordsPage));
  }
  async function expenseMethodChooser() {
    newEntryReturn = expenseMethodChooser;
    await open('receipt'); view.append(text('h2', '支出を記録'));
    view.append(button('手入力', () => { newEntryReturn = expenseMethodChooser; return manualEditor('expense'); }),
      button('レシートから入力', () => { newEntryReturn = expenseMethodChooser; return receiptPage(); }),
      button('記録する画面へ戻る', recordChooser));
  }
  async function accountBalancesPage() {
    await open('receipt');
    el('settings-tab').click();
    await openAccountBalances();
  }
  async function manualEditor(kind: 'expense' | 'income' | 'transfer', transaction?: ActualTransaction) {
    if (kind === 'expense' && !transaction) {
      const draft = (await receipts.list()).find(value => !value.image && value.registration.status !== 'applied' && value.registration.status !== 'deleted');
      await receiptEditor(draft ?? await receipts.createManual());
      return;
    }
    await open('receipt');
    await showManualTransactionEditor({ view, ledger, repository, kind, transaction,
      onSaved: async () => { if (transaction) await transactionDetail(transaction); else await returnToRecords(); el('message').textContent = transaction ? '変更を保存しました。' : '登録しました。'; },
      onCancel: transaction ? () => transactionDetail(transaction) : newEntryReturn });
  }
  async function returnToRecords() { if (searchOrigin) await searchPage(); else await recordsPage(); }
  async function searchPage() {
    await open('receipt'); searchOrigin = true;
    await showTransactionSearch({ view, ledger, initialFilters: searchFilters,
      loadEntries: async () => {
        const [entries, localReceipts] = await Promise.all([ledger.getSearchTransactions(), receipts.list()]);
        return attachReceiptSearchItems(entries, localReceipts);
      },
      onFiltersChange: filters => { searchFilters = { ...filters }; }, onTransaction: transactionDetail, onBack: recordsPage });
  }
  async function recordsPage() {
    searchOrigin = false;
    newEntryReturn = recordsPage;
    await open('receipt'); view.append(text('h2', '記録'), button('＋記録', recordChooser, false));
    view.append(button('検索・絞り込み', searchPage), button('口座・残高を見る', accountBalancesPage));
    const localReceipts = await receipts.list();
    const list = document.createElement('ul'); list.className = 'record-list';
    for (const receipt of localReceipts.filter(receipt => receipt.registration.status !== 'applied' && receipt.registration.status !== 'deleted')) {
      const item = document.createElement('li');
      item.append(button(`${receipt.confirmedValue?.merchant || receipt.extraction?.merchant || (receipt.image ? '未入力のレシート' : '未入力の支出')} · 確認する`, () => receiptEditor(receipt))); list.append(item);
    }
    for (const row of (await ledger.getRecentTransactions({ limit: 100 })).filter(row => row.kind !== 'transfer' || row.amountYen < 0)) {
      const item = document.createElement('li');
      const receipt = localReceipts.find(receipt => receipt.registration.actualTransactionId === row.id);
      item.append(button(`${row.payeeName || (row.kind === 'transfer' ? '口座間振替' : row.kind === 'income' ? '収入' : '支出')} · ${row.date} · ${row.kind === 'transfer' ? '振替 ' : row.kind === 'income' ? '収入 ' : ''}${yen(row.amountYen)}${receipt ? ' · 登録済み' : ''}`, () => receipt ? receiptEditor(receipt) : transactionDetail(row))); list.append(item);
    }
    view.append(list);
    if (!list.children.length) view.append(text('p', 'まだ記録がありません。'));
  }
  async function transactionDetail(transaction: ActualTransaction) {
    const linked = (await receipts.list()).find(receipt => receipt.registration.actualTransactionId === transaction.id);
    if (linked) { await receiptEditor(linked); return; }
    await open('receipt');
    const [accounts, current] = await Promise.all([ledger.listAccounts(), ledger.getTransactionById(transaction.id)]);
    if (!current) throw new Error('記録が見つかりません。記録一覧を読み込み直してください。');
    view.append(text('h2', current.kind === 'income' ? '収入の記録' : current.kind === 'transfer' ? '振替の記録' : '支出の記録'));
    const detail = document.createElement('dl'); detail.className = 'transaction-detail';
    const values = current.kind === 'transfer' ? [
      ['金額', yen(current.amountYen)], ['日付', current.date],
      ['振替元口座', accounts.find(account => account.id === current.accountId)?.name || '利用不可'],
      ['振替先口座', accounts.find(account => account.id === current.transferAccountId)?.name || '利用不可'],
      ['メモ', current.memo || 'なし'],
    ] : [['金額', yen(current.amountYen)], ['日付', current.date], [current.kind === 'income' ? '入金元・内容' : '店名・支払先', current.payeeName || '未設定'], ['カテゴリ', current.categoryName || '未設定'], [current.kind === 'income' ? '入金先口座' : '支払元', accounts.find(account => account.id === current.accountId)?.name || '利用不可'], ['メモ', current.memo || 'なし']];
    for (const [label, value] of values) {
      detail.append(text('dt', label), text('dd', value));
    }
    view.append(detail);
    if (current.kind === 'transfer') view.append(button('編集する', () => manualEditor('transfer', current), false));
    if (current.kind !== 'transfer' && !current.isSplit) view.append(button('編集する', () => manualEditor(current.kind === 'income' ? 'income' : 'expense', current), false));
    view.append(deleteButton(current.id), button(searchOrigin ? '検索結果へ戻る' : '記録一覧へ戻る', returnToRecords));
  }
  async function receiptPage() {
    await open('receipt'); view.append(text('h2', 'レシートを記録する'), text('p', '画像と入力内容はこの端末に保存します。AIを選んだときだけ画像を送信します。', 'muted'));
    const capture = document.createElement('input'); capture.type = 'file'; capture.accept = 'image/jpeg,image/png,image/webp'; capture.setAttribute('capture', 'environment'); capture.hidden = true;
    const library = document.createElement('input'); library.type = 'file'; library.accept = capture.accept; library.hidden = true;
    const saveFile = (input: HTMLInputElement) => { input.addEventListener('change', () => { const file = input.files?.[0]; if (file) void receipts.saveImage(file).then(receiptEditor).catch(report); }); };
    saveFile(capture); saveFile(library);
    view.append(button('撮影する', () => capture.click(), false), button('写真・ファイルを選ぶ', () => library.click()), capture, library,
      button('支出の選択へ戻る', newEntryReturn));
    const list = document.createElement('ul');
    for (const receipt of (await receipts.list()).filter(receipt => receipt.registration.status !== 'deleted')) {
      const row = document.createElement('li'); const value = receipt.confirmedValue ?? receipt.extraction;
      row.append(button(`${value?.merchant || '未入力のレシート'} · ${receipt.registration.status === 'applied' ? '登録済み' : '確認する'}`, () => receiptEditor(receipt))); list.append(row);
    }
    view.append(list);
  }
  async function receiptDetail(receipt: LocalReceipt) {
    await open('receipt');
    const value = receipt.confirmedValue;
    if (!value) throw new Error('登録したレシートを確認できません。');
    const pending = await receipts.getPendingEdit(receipt.id);
    const accounts = await ledger.listAccounts();
    const categories = await ledger.listCategories();
    const categoryName = (id: string | null) => categories.find(category => category.id === id)?.name ?? (isCategoryId(id) ? CATEGORY_LABELS[id] : '未分類');
    view.append(text('h2', value.merchant), text('p', `支出 ${yen(value.totalAmountYen)}`), text('p', `${value.purchasedDate}${value.purchasedTime ? ` ${value.purchasedTime}` : ''}`), text('p', `${categoryName(value.categoryId)} · ${accounts.find(account => account.id === value.accountId)?.name ?? '利用不可'}`), text('p', '家計簿へ登録済みです。'));
    if (pending) view.append(text('p', '前回の変更は保存結果を確認中です。編集画面で同じ内容を再試行してください。'));
    if (receipt.image) {
      const image = document.createElement('details'); image.append(text('summary', 'レシート画像'));
      image.addEventListener('toggle', () => { if (!image.open || image.childElementCount > 1) return; void repository.getBlob(receipt.image!.blobId).then(blob => { if (!image.isConnected) return; if (!blob) { image.append(text('p', 'レシート画像の原本はありません。')); return; } imageUrl = URL.createObjectURL(blob.blob); const img = document.createElement('img'); img.src = imageUrl; img.alt = '保存したレシート'; img.className = 'receipt-preview'; image.append(img); }).catch(report); });
      view.append(image);
    }
    if (value.memo) view.append(text('p', `メモ：${value.memo}`));
    if (value.items?.length) {
      const items = document.createElement('details'); items.append(text('summary', '購入内容'));
      const list = document.createElement('ul'); list.className = 'record-list';
      for (const item of value.items) list.append(text('li', `${item.name} · ${item.amountYen == null ? '金額未入力' : yen(item.amountYen)} · ${categoryName(item.categoryId ?? value.categoryId)}`));
      items.append(list); view.append(items);
    }
    if (value.adjustments?.length) {
      const adjustments = document.createElement('details'); adjustments.append(text('summary', '値引き・調整'));
      for (const adjustment of value.adjustments) adjustments.append(text('p', `${adjustment.label} · ${adjustment.amountYen < 0 ? '−' : '+'}${yen(adjustment.amountYen)}`));
      view.append(adjustments);
    }
    view.append(button('編集する', () => receiptEditor(receipt, { edit: true }), false), ...(receipt.registration.actualTransactionId ? [deleteButton(receipt.registration.actualTransactionId)] : []), button(searchOrigin ? '検索結果へ戻る' : '記録一覧へ戻る', returnToRecords));
  }
  async function receiptEditor(receipt: LocalReceipt, editorOptions: { useExtraction?: boolean; preserveAccountId?: string; edit?: boolean } = {}) {
    if (receipt.registration.status === 'deleted') throw new Error('この取引は削除済みです。記録一覧を開き直してください。');
    if (receipt.registration.status === 'applied' && !editorOptions.edit) { await receiptDetail(receipt); return; }
    const editing = receipt.registration.status === 'applied';
    await open('receipt'); view.append(text('h2', editing ? '支出の記録を編集' : receipt.image ? 'レシートを登録する' : '支出を入力'));
    const confirmed = receipt.confirmedValue;
    const draftId = `receipt-draft:${receipt.id}`;
    const savedDraft = await repository.get<ReceiptDraft>(draftId);
    const draft = savedDraft?.value;
    let [accounts, categories] = await Promise.all([ledger.listOpenAccounts(), ledger.listExpenseCategories()]);
    const categoryName = (id: string | null | undefined) => {
      if (!id) return 'カテゴリ未選択';
      const builtin = isCategoryId(id) ? CATEGORY_LABELS[id] : null;
      return categories.find(entry => entry.id === id)?.name ?? builtin ?? 'カテゴリを選び直してください';
    };
    const actualCategoryId = (id: string | null | undefined) => {
      if (!id) return '';
      if (categories.some(entry => entry.id === id)) return id;
      return isCategoryId(id) ? categories.find(entry => entry.name === CATEGORY_LABELS[id])?.id ?? '' : '';
    };
    const extraction = receipt.extraction?.documentKind === 'receipt' ? receipt.extraction : null;
    const extractionItems: ReceiptItem[] = (extraction?.items ?? []).map((item, index) => ({
      id: `receipt-item:${receipt.id}:${index}`, name: item.name, amountYen: item.amountYen,
      ...(item.quantity !== undefined ? { quantity: item.quantity } : {}),
      ...(item.unitPriceYen !== undefined ? { unitPriceYen: item.unitPriceYen } : {}),
      categoryId: actualCategoryId(receipt.itemCategories?.[index]),
    }));
    const extractionAdjustments: ReceiptAdjustment[] = (extraction?.adjustments ?? []).map((adjustment, index) => ({
      id: `receipt-adjustment:${receipt.id}:${index}`, label: adjustment.label, amountYen: adjustment.amountYen,
      targetItemId: adjustment.targetItemIndex == null ? null : extractionItems[adjustment.targetItemIndex]?.id ?? null,
    }));
    const useExtraction = editorOptions.useExtraction === true;
    const usefulDraft = draft && (draft.merchant.trim() || draft.totalAmountYen > 0 || draft.items?.length) ? draft : null;
    const pendingEdit = editing ? await receipts.getPendingEdit(receipt.id) : null;
    const base = pendingEdit?.after ?? (useExtraction ? null : (receipt.registration.status === 'pending' || editing) ? usefulDraft ?? confirmed : confirmed);
    const initial: ReceiptDraft = {
      memo: base?.memo !== undefined ? base.memo : usefulDraft?.memo ?? null,
      merchant: base?.merchant ?? extraction?.merchant ?? '',
      purchasedDate: base?.purchasedDate ?? extraction?.purchasedDate ?? today(),
      purchasedTime: base?.purchasedTime ?? extraction?.purchasedTime ?? null,
      totalAmountYen: base?.totalAmountYen ?? extraction?.totalAmountYen ?? 0,
      categoryId: actualCategoryId(base?.categoryId ?? (extractionItems.length ? '' : receipt.itemCategories?.[0] ?? receipt.aiSuggestion.categoryId)),
      accountId: editorOptions.preserveAccountId ?? base?.accountId ?? confirmed?.accountId ?? (accounts.length === 1 ? accounts[0].id : ''),
      items: useExtraction ? extractionItems : base?.items ?? extractionItems,
      adjustments: useExtraction ? extractionAdjustments : base?.adjustments ?? extractionAdjustments,
      taxAmountYen: useExtraction ? extraction?.taxAmountYen ?? null : base?.taxAmountYen ?? extraction?.taxAmountYen ?? null,
    };
    let items = initial.items.map(item => ({ ...item }));
    let adjustments = initial.adjustments.map(item => ({ ...item }));
    const blob = await repository.getBlob(receipt.image?.blobId ?? 'missing');
    if (!blob && receipt.image) view.append(text('p', 'レシート画像の原本はありません。原本の確認・再解析はできません。保存済みの内容は利用できます。'));
    if (blob) { imageUrl = URL.createObjectURL(blob.blob); const img = document.createElement('img'); img.src = imageUrl; img.alt = '保存したレシート'; img.className = 'receipt-preview'; view.append(img); }
    if (receipt.extraction?.warnings.length) view.append(text('p', '読み取り結果に確認が必要な項目があります。画像と照らし合わせてください。'));

    const form = document.createElement('form');
    const inputId = (field: string) => !receipt.image ? `manual-transaction-${field === 'merchant' ? 'payee' : field}` : `receipt-${field}`;
    const merchant = document.createElement('input'); merchant.id = inputId('merchant'); merchant.required = true; merchant.maxLength = 200; merchant.value = initial.merchant;
    const date = document.createElement('input'); date.id = inputId('date'); date.type = 'date'; date.required = true; date.value = initial.purchasedDate;
    const time = document.createElement('input'); time.id = 'receipt-time'; time.type = 'time'; time.value = initial.purchasedTime ?? '';
    const amount = document.createElement('input'); amount.id = inputId('amount'); amount.type = 'number'; amount.inputMode = 'numeric'; amount.min = '1'; amount.step = '1'; amount.required = true; amount.value = initial.totalAmountYen ? String(initial.totalAmountYen) : '';
    const category = document.createElement('select'); category.id = inputId('category'); category.required = true;
    category.replaceChildren(new Option('選択してください', ''), ...categories.map(entry => new Option(entry.name, entry.id)));
    category.value = actualCategoryId(initial.categoryId);
    const account = document.createElement('select'); account.id = inputId('account'); account.required = true;
    account.replaceChildren(new Option('選択してください', ''), ...accounts.map(entry => new Option(entry.name, entry.id)));
    account.value = initial.accountId;
    if (initial.accountId && !account.value) view.append(text('p', '以前の支払元は利用できません。支払元を選び直してください。'));
    if (base?.categoryId && !category.value) view.append(text('p', '以前のカテゴリは利用できません。カテゴリを選び直してください。'));
    const itemsHeading = text('h3', '購入内容');
    const itemsList = document.createElement('ul'); itemsList.className = 'receipt-item-list';
    const adjustmentsHeading = text('h3', '値引き・調整');
    const adjustmentsList = document.createElement('ul'); adjustmentsList.className = 'receipt-adjustment-list';
    const warning = text('p', '', 'receipt-difference'); warning.id = 'receipt-difference'; warning.setAttribute('role', 'status');
    const status = text('p', '', 'status'); status.id = 'receipt-save-state'; status.setAttribute('role', 'status');
    let expandItemId: string | null = null;
    let expandAdjustmentId: string | null = null;
    const addItem = button('品目を追加', () => { items = readItems(); expandItemId = crypto.randomUUID(); items.push({ id: expandItemId, name: '', amountYen: null, categoryId: null }); drawItems(); updateAdjustmentTargets(); updateDifference(); scheduleDraft(); });
    const addAdjustment = button('値引きを追加', () => { adjustments = readAdjustments(); expandAdjustmentId = crypto.randomUUID(); adjustments.push({ id: expandAdjustmentId, label: '', amountYen: 0, targetItemId: null }); drawAdjustments(); updateDifference(); scheduleDraft(); });
    const applyCategory = button('全品目にこのカテゴリを適用', () => { items = readItems().map(item => ({ ...item, categoryId: category.value || null })); drawItems(); updateAdjustmentTargets(); updateDifference(); scheduleDraft(); });
    const taxDetails = document.createElement('details'); taxDetails.className = 'receipt-tax';
    const taxLabel = fieldLabel('label', '税額（円・任意）', 'receipt-tax');
    const tax = document.createElement('input'); tax.id = 'receipt-tax'; tax.type = 'number'; tax.inputMode = 'numeric'; tax.min = '0'; tax.step = '1'; tax.value = initial.taxAmountYen == null ? '' : String(initial.taxAmountYen);
    taxDetails.append(text('summary', '税額（任意）'), taxLabel, tax);
    const memoLabel = fieldLabel('label', 'メモ（任意）', inputId('memo'));
    const memo = document.createElement('textarea'); memo.id = memoLabel.htmlFor; memo.maxLength = 2000; memo.value = initial.memo ?? '';
    const aiArea = document.createElement('div'); aiArea.className = 'receipt-ai-area';
    aiArea.append(text('p', '画像から店名・日付・金額・品目を読み取り、カテゴリを設定します。', 'muted'));
    const aiButton = button(receipt.extraction ? '再読み取り' : 'AIで読み取る', async () => {
      if (receipt.extraction && !window.confirm('もう一度読み取るとAIの利用枠を消費し、入力内容を読み取り結果で置き換えます。続けますか？')) return;
      if (receipt.registration.status === 'applied') return;
      await saveDraft();
      const accountId = account.value;
      form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement | HTMLTextAreaElement>('input,select,textarea,button').forEach(control => { control.disabled = true; });
      try {
        await receipts.analyze(receipt.id);
        try {
          const suggested = await receipts.suggestCategory(receipt.id);
          const updated = await receipts.get(receipt.id);
          if (updated && form.isConnected) await receiptEditor(updated, { useExtraction: true, preserveAccountId: accountId });
          if (updated?.aiSuggestion.source === 'learned_rule') el('message').textContent = 'いつもの分類を適用しました。';
          if (suggested === null && updated?.extraction?.items.length === 0) el('message').textContent = 'カテゴリを選択してください。';
        } catch (error) {
          report(error);
          const updated = await receipts.get(receipt.id);
          if (updated && form.isConnected) await receiptEditor(updated, { useExtraction: true, preserveAccountId: accountId });
          el('message').textContent = `${error instanceof Error ? error.message : 'カテゴリを提案できませんでした。'} 読み取った内容は編集できます。`;
        }
      } catch (error) {
        report(error);
        if (error instanceof Error && /アカウント|ログイン|認証/.test(error.message)) aiArea.append(button('アカウントを確認する', options.openAccount));
      } finally {
        form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement | HTMLTextAreaElement>('input,select,textarea,button').forEach(control => { control.disabled = false; });
      }
    });
    if (blob && !editing) { aiArea.append(aiButton); view.append(aiArea); }
    if (editing) aiArea.replaceChildren();
    const merchantLabel = fieldLabel('label', receipt.image ? '店名' : '店名・支払先', merchant.id);
    const dateLabel = fieldLabel('label', receipt.image ? '購入日' : '日付', date.id);
    const timeLabel = fieldLabel('label', '時刻（任意）', time.id);
    const amountLabel = fieldLabel('label', receipt.image ? '合計金額（円）' : '金額（円）', amount.id);
    const categoryLabel = fieldLabel('label', receipt.image ? '全体カテゴリ' : '支出カテゴリ', category.id);
    const accountLabel = fieldLabel('label', '支払元', account.id);
    const purchaseDetails = document.createElement('details'); purchaseDetails.className = 'purchase-details';
    purchaseDetails.open = Boolean(receipt.image) || items.length > 0 || adjustments.length > 0;
    purchaseDetails.append(text('summary', '購入内容（任意）'), applyCategory, itemsHeading, itemsList, addItem, adjustmentsHeading, adjustmentsList, addAdjustment, taxDetails);
    form.append(merchantLabel, merchant, dateLabel, date, timeLabel, time, amountLabel, amount,
      categoryLabel, category, accountLabel, account, memoLabel, memo, purchaseDetails, warning, status);
    view.append(form);
    function addCategoryShortcut(field: HTMLSelectElement) {
      return createMasterShortcut({ ledger, request: { kind: 'category', isIncome: false }, origin: {
        field, beforeOpen: saveDraft,
        onCreated: async id => {
          categories = await ledger.listExpenseCategories();
          for (const select of [category, ...Array.from(itemsList.querySelectorAll<HTMLSelectElement>('[data-item-category]'))]) {
            const previous = select.value;
            select.replaceChildren(new Option(select === category ? '選択してください' : '全体カテゴリを使う', ''), ...categories.map(entry => new Option(entry.name, entry.id)));
            if (previous && !categories.some(entry => entry.id === previous)) select.append(new Option('カテゴリを選び直してください（利用不可）', previous));
            select.value = previous;
          }
          field.value = id;
          field.dispatchEvent(new Event('input', { bubbles: true }));
          await saveDraft();
        },
      } });
    }
    category.after(addCategoryShortcut(category));
    account.after(createMasterShortcut({ ledger, request: { kind: 'account' }, origin: {
      field: account, beforeOpen: saveDraft,
      onCreated: async id => {
        accounts = await ledger.listOpenAccounts();
        account.replaceChildren(new Option('選択してください', ''), ...accounts.map(entry => new Option(entry.name, entry.id)));
        account.value = id; await saveDraft();
      },
    } }));

    function readItems(): ReceiptItem[] {
      return Array.from(itemsList.querySelectorAll<HTMLElement>('[data-receipt-item]')).map(row => ({
        id: row.dataset.receiptItem!, name: row.querySelector<HTMLInputElement>('[data-item-name]')!.value,
        amountYen: parseNullableInteger(row.querySelector<HTMLInputElement>('[data-item-amount]')!.value),
        quantity: parseNullableNumber(row.querySelector<HTMLInputElement>('[data-item-quantity]')!.value),
        unitPriceYen: parseNullableInteger(row.querySelector<HTMLInputElement>('[data-item-unit-price]')!.value),
        categoryId: row.querySelector<HTMLSelectElement>('[data-item-category]')!.value || null,
      }));
    }
    function readAdjustments(): ReceiptAdjustment[] {
      return Array.from(adjustmentsList.querySelectorAll<HTMLElement>('[data-receipt-adjustment]')).map(row => ({
        id: row.dataset.receiptAdjustment!, label: row.querySelector<HTMLInputElement>('[data-adjustment-label]')!.value,
        amountYen: (row.querySelector<HTMLSelectElement>('[data-adjustment-kind]')!.value === 'discount' ? -1 : 1) * Number(row.querySelector<HTMLInputElement>('[data-adjustment-amount]')!.value),
        targetItemId: row.querySelector<HTMLSelectElement>('[data-adjustment-target]')!.value || null,
      }));
    }
    function read(): ReceiptDraft {
      return { merchant: merchant.value, purchasedDate: date.value, purchasedTime: time.value || null,
        totalAmountYen: Number(amount.value), categoryId: category.value, accountId: account.value,
        items: readItems(), adjustments: readAdjustments(), taxAmountYen: parseNullableInteger(tax.value), memo: memo.value.trim() || null };
    }
    let saveTail: Promise<void> = Promise.resolve();
    let draftTimer: ReturnType<typeof setTimeout> | null = null;
    function saveDraft(): Promise<void> {
      if (pendingEdit) return Promise.resolve();
      const value = read();
      saveTail = saveTail.catch(() => undefined).then(async () => {
        await repository.put({ id: draftId, kind: 'category-state', value, updatedAt: new Date().toISOString() });
        status.textContent = '入力内容を端末に保存しました。';
      });
      return saveTail;
    }
    flushReceiptDraft = async () => {
      if (draftTimer) clearTimeout(draftTimer);
      await saveDraft();
    };
    function scheduleDraft() {
      if (draftTimer) clearTimeout(draftTimer);
      draftTimer = setTimeout(() => { void saveDraft().catch(report); }, 350);
    }
    function updateDifference() {
      const currentItems = readItems(); const currentAdjustments = readAdjustments();
      if (!currentItems.length || currentItems.some(item => item.amountYen == null) || !amount.value) { warning.textContent = ''; return; }
      const knownTotal = currentItems.reduce((sum, item) => sum + (item.amountYen ?? 0), 0) + currentAdjustments.reduce((sum, item) => sum + item.amountYen, 0);
      const difference = Number(amount.value) - knownTotal;
      warning.textContent = difference === 0 ? '' : `購入内容との差額は${difference < 0 ? '−' : '+'}${yen(difference)}です。入力した合計金額を保ちます。値引きや税額を確認してください（税額は差額に含めていません）。`;
    }
    function drawItems() {
      itemsList.replaceChildren();
      for (const item of items) {
        const details = document.createElement('details'); details.className = 'receipt-item';
        details.dataset.receiptItem = item.id;
        const summary = text('summary', `${item.name.trim() || '品目を入力'} · ${item.amountYen == null ? '金額未入力' : yen(item.amountYen)} · ${categoryName(item.categoryId)}`);
        details.open = expandItemId === item.id;
        const nameLabel = fieldLabel('label', '品目名', `item-name-${item.id}`);
        const name = document.createElement('input'); name.id = nameLabel.htmlFor; name.dataset.itemName = ''; name.value = item.name; name.maxLength = 200;
        const amountLabel = fieldLabel('label', '金額（円）', `item-amount-${item.id}`);
        const itemAmount = document.createElement('input'); itemAmount.id = amountLabel.htmlFor; itemAmount.dataset.itemAmount = ''; itemAmount.type = 'number'; itemAmount.inputMode = 'numeric'; itemAmount.min = '0'; itemAmount.step = '1'; itemAmount.value = item.amountYen == null ? '' : String(item.amountYen);
        const quantityLabel = fieldLabel('label', '数量（任意）', `item-quantity-${item.id}`);
        const quantity = document.createElement('input'); quantity.id = quantityLabel.htmlFor; quantity.dataset.itemQuantity = ''; quantity.type = 'number'; quantity.inputMode = 'decimal'; quantity.min = '0'; quantity.step = 'any'; quantity.value = item.quantity == null ? '' : String(item.quantity);
        const unitLabel = fieldLabel('label', '単価（円・任意）', `item-unit-${item.id}`);
        const unit = document.createElement('input'); unit.id = unitLabel.htmlFor; unit.dataset.itemUnitPrice = ''; unit.type = 'number'; unit.inputMode = 'numeric'; unit.min = '0'; unit.step = '1'; unit.value = item.unitPriceYen == null ? '' : String(item.unitPriceYen);
        const itemCategoryLabel = fieldLabel('label', 'カテゴリ', `item-category-${item.id}`);
        const itemCategory = document.createElement('select'); itemCategory.id = itemCategoryLabel.htmlFor; itemCategory.dataset.itemCategory = '';
        itemCategory.replaceChildren(new Option('全体カテゴリを使う', ''), ...categories.map(entry => new Option(entry.name, entry.id)));
        const availableCategoryId = actualCategoryId(item.categoryId);
        if (item.categoryId && !availableCategoryId) itemCategory.append(new Option('カテゴリを選び直してください（利用不可）', item.categoryId));
        itemCategory.value = availableCategoryId || item.categoryId || '';
        const remove = button('品目を削除', () => {
          items = readItems().filter(entry => entry.id !== item.id);
          adjustments = readAdjustments().map(entry => entry.targetItemId === item.id ? { ...entry, targetItemId: null } : entry);
          drawItems(); drawAdjustments(); updateDifference(); scheduleDraft();
        });
        for (const input of [name, itemAmount, quantity, unit, itemCategory]) input.addEventListener('input', () => {
          const displayedAmount = itemAmount.value ? yen(Number(itemAmount.value)) : '金額未入力';
          summary.textContent = `${name.value.trim() || '品目を入力'} · ${displayedAmount} · ${categoryName(itemCategory.value)}`;
          if (input === name) updateAdjustmentTargets();
          updateDifference(); scheduleDraft();
        });
        remove.classList.add('destructive');
        const optional = document.createElement('div'); optional.append(quantityLabel, quantity, unitLabel, unit);
        details.append(summary, nameLabel, name, amountLabel, itemAmount, itemCategoryLabel, itemCategory, addCategoryShortcut(itemCategory), remove, optional);
        const row = document.createElement('li'); row.append(details); itemsList.append(row);
      }
    }
    function updateAdjustmentTargets() {
      const currentItems = readItems();
      adjustmentsList.querySelectorAll<HTMLSelectElement>('[data-adjustment-target]').forEach(select => {
        const selected = select.value;
        select.replaceChildren(new Option('指定しない', ''), ...currentItems.map(item => new Option(item.name || '品目を入力', item.id)));
        select.value = selected;
      });
    }
    function drawAdjustments() {
      adjustmentsList.replaceChildren();
      for (const adjustment of adjustments) {
        const row = document.createElement('li'); row.className = 'receipt-adjustment'; row.dataset.receiptAdjustment = adjustment.id;
        const details = document.createElement('details');
        const summary = text('summary', `${adjustment.label || '値引き・調整'} · ${adjustment.amountYen < 0 ? '−' : '+'}${yen(adjustment.amountYen)}`);
        details.open = expandAdjustmentId === adjustment.id;
        const label = fieldLabel('label', '内容', `adjustment-label-${adjustment.id}`);
        const name = document.createElement('input'); name.id = label.htmlFor; name.dataset.adjustmentLabel = ''; name.value = adjustment.label; name.maxLength = 100;
        const kindLabel = fieldLabel('label', '種類', `adjustment-kind-${adjustment.id}`);
        const kind = document.createElement('select'); kind.id = kindLabel.htmlFor; kind.dataset.adjustmentKind = '';
        kind.replaceChildren(new Option('値引き', 'discount'), new Option('その他の調整（加算）', 'addition'));
        kind.value = adjustment.amountYen > 0 ? 'addition' : 'discount';
        const amountLabel = fieldLabel('label', kind.value === 'discount' ? '値引き額（円）' : '調整額（円）', `adjustment-amount-${adjustment.id}`);
        const value = document.createElement('input'); value.id = amountLabel.htmlFor; value.dataset.adjustmentAmount = ''; value.type = 'number'; value.inputMode = 'numeric'; value.min = '0'; value.step = '1'; value.value = String(Math.abs(adjustment.amountYen));
        const targetLabel = fieldLabel('label', '対象の品目（任意）', `adjustment-target-${adjustment.id}`);
        const target = document.createElement('select'); target.id = targetLabel.htmlFor; target.dataset.adjustmentTarget = '';
        target.replaceChildren(new Option('指定しない', ''), ...items.map(item => new Option(item.name || '品目を入力', item.id)));
        target.value = adjustment.targetItemId ?? '';
        const remove = button('値引きを削除', () => { adjustments = readAdjustments().filter(entry => entry.id !== adjustment.id); drawAdjustments(); updateDifference(); scheduleDraft(); });
        for (const input of [name, value, target, kind]) input.addEventListener('input', () => {
          amountLabel.textContent = kind.value === 'discount' ? '値引き額（円）' : '調整額（円）';
          summary.textContent = `${name.value || (kind.value === 'discount' ? '値引き' : '調整')} · ${kind.value === 'discount' ? '−' : '+'}${yen(Number(value.value))}`;
          updateDifference(); scheduleDraft();
        });
        details.append(summary, label, name, kindLabel, kind, amountLabel, value, targetLabel, target, remove);
        row.append(details); adjustmentsList.append(row);
      }
    }
    drawItems(); drawAdjustments();
    for (const input of [merchant, date, time, amount, category, account, tax, memo]) input.addEventListener('input', () => { updateDifference(); scheduleDraft(); });
    category.addEventListener('change', scheduleDraft); account.addEventListener('change', scheduleDraft);
    updateDifference();
    if (!pendingEdit) void saveDraft().catch(report);

    if (receipt.registration.status !== 'pending' && !editing || pendingEdit) {
      form.querySelectorAll('input,select,textarea,button').forEach(node => { (node as HTMLInputElement).disabled = true; });
      status.textContent = '判断内容は保存されています。同じ内容で保存を再試行してください。';
    }
    const submit = document.createElement('button'); submit.type = 'submit';
    submit.textContent = editing ? pendingEdit ? '同じ内容で再試行する' : '変更を保存する' : receipt.registration.status === 'failed' ? '登録を再試行する' : '登録する';
    form.append(submit);
    form.addEventListener('submit', event => {
      event.preventDefault();
      void busy(submit, async () => {
        if (draftTimer) clearTimeout(draftTimer);
        const value = pendingEdit?.after ?? read();
        if (!value.merchant.trim() || !value.purchasedDate || !value.totalAmountYen || !value.categoryId || !value.accountId) throw new Error('店名、日付、合計金額、全体カテゴリ、支払元を確認してください。');
        if (value.items?.some(item => !item.name.trim()) || value.adjustments?.some(item => !item.label.trim())) throw new Error('品目名と値引き・調整の内容を入力してください。');
        await saveDraft();
        form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement | HTMLTextAreaElement>('input,select,textarea,button').forEach(control => { control.disabled = true; });
        let saved: LocalReceipt;
        try {
          if (editing) saved = await receipts.edit(receipt.id, value, receipt.updatedAt);
          else {
            if (receipt.registration.status === 'pending') await receipts.confirm(receipt.id, value);
            saved = await receipts.register(receipt.id);
          }
        } catch (error) {
          const current = await receipts.get(receipt.id);
          if (current) await receiptEditor(current, { edit: editing });
          throw error;
        }
        await saveTail;
        flushReceiptDraft = () => Promise.resolve();
        await repository.delete(draftId);
        if (editing) await receiptDetail(saved); else if (!receipt.image) await recordsPage(); else await receiptPage();
        el('message').textContent = editing ? '変更を保存しました。' : '登録しました。';
      });
    });
    view.append(button(editing || !receipt.image ? 'キャンセル' : '支出の選択へ戻る', editing ? () => receiptDetail(receipt) : newEntryReturn));
    if (!accounts.length || !categories.length) view.append(text('p', 'カテゴリと支払元は、それぞれの選択欄から追加できます。'));
  }
  async function statementPage(initialProvider: StatementProvider = 'paypay') {
    await open('statement'); view.append(text('h2', '明細を取り込む'), text('p', 'PayPayと三井住友カードのCSVに対応しています。ファイルは端末内で処理し、送信しません。'));
    const providerLabel = text('label', 'サービス'); providerLabel.setAttribute('for', 'statement-provider');
    const provider = document.createElement('select'); provider.id = 'statement-provider';
    provider.append(new Option('PayPay', 'paypay'), new Option('三井住友カード', 'smbc_card'));
    provider.value = initialProvider;
    const label = text('label', 'CSVファイル'); label.setAttribute('for', 'statement-file');
    const input = document.createElement('input'); input.id = 'statement-file'; input.type = 'file'; input.accept = '.csv,text/csv';
    const submit = button('明細を取り込む', async () => {
      const file = input.files?.[0];
      if (!file) { el('message').textContent = 'CSVファイルを選択してください。'; return; }
      const result = await statements.importFile(file, provider.value as StatementProvider);
      await statementPage(provider.value as StatementProvider);
      const reasons = result.needsReviewRows.map(({ rowNumber, reason }) => `${rowNumber}行目: ${reason}`).join(' / ');
      el('message').textContent = `${result.added}件を取り込みました。重複 ${result.duplicates}件。対象外 ${result.excluded}件、要確認 ${result.needsReviewRows.length}件。${reasons}`;
    }, false);
    view.append(providerLabel, provider, label, input, submit, button('照合する', reviewPage));
    const rows = await statements.list(); view.append(text('p', `取り込み済み ${rows.length}件`));
    for (const record of await repository.list('statement-import')) {
      const metadata = record.value as { provider?: string; needsReviewRows?: Array<{ rowNumber: number; reason: string }> };
      if (metadata.needsReviewRows?.length) {
        view.append(text('p', `${metadata.provider === 'smbc_card' ? '三井住友カード' : 'PayPay'}: 要確認 ${metadata.needsReviewRows.length}件`));
        for (const row of metadata.needsReviewRows) view.append(text('p', `${row.rowNumber}行目: ${row.reason}`));
      }
      if (!await repository.getBlob(`statement-source:${record.id}`)) view.append(text('p', '取込元CSVの原本はありません。原本の確認はできませんが、明細行と照合結果は利用できます。'));
    }
  }
  async function reviewPage() {
    await open('reconciliation'); view.append(text('h2', '明細の確認'));
    view.append(button('照合を更新する', async () => { await reconciliation.run(); await reviewPage(); }, false));
    const run = await reconciliation.latest(); const decisions = await reconciliation.resolutions();
    for (const decision of decisions.filter(d => d.status !== 'applied')) view.append(text('p', '家計簿への反映が完了していません。判断内容は保存されています。'), button('反映を再試行する', async () => { await reconciliation.retry(decision.id); await reviewPage(); }));
    if (!run) { view.append(text('p', '明細を取り込んでから照合してください。')); return; }
    const pending = run.statementResults.filter(row => !decisions.some(d => d.statementId === row.statementTransactionId));
    const automatic = decisions.filter(d => d.source === 'automatic' && d.status === 'applied');
    const auto = automatic.length;
    view.append(text('p', `自動確認済み ${auto}件 · 要確認 ${pending.filter(r => r.status === 'needs_review').length}件 · 記録なし ${pending.filter(r => r.status === 'unmatched_statement').length}件 · 明細待ち ${run.receiptResults.filter(r => r.status === 'unmatched_receipt').length}件`));
    const allStatements = await statements.list(), allReceipts = await receipts.list();
    const list = document.createElement('ul');
    for (const row of pending.filter(r => r.status !== 'matched')) {
      const statement = allStatements.find(s => s.id === row.statementTransactionId); if (!statement) continue;
      const item = document.createElement('li'); const detail = document.createElement('details'); detail.append(text('summary', `${statement.usedDate} · ${statement.merchant} · ${yen(statement.amountYen)}`));
      if (statement.kind === 'refund') detail.append(text('p', '返金の記録です。現在は自動処理できません。'));
      else {
        const candidates = run.candidates.filter(c => c.statementTransactionId === statement.id);
        for (const candidate of candidates) {
          const receipt = allReceipts.find(r => r.id === candidate.receiptId); const value = receipt?.confirmedValue; if (!value) continue;
          detail.append(text('p', `似た支出：${value.purchasedDate} · ${value.merchant} · ${yen(value.totalAmountYen)}${candidate.amountDeltaYen ? `（金額差 ${yen(candidate.amountDeltaYen)}）` : ''}`));
          detail.append(button('同じ支出', async () => { await reconciliation.sameExpense(run.runId, statement.id, candidate.receiptId); await reviewPage(); }, false), button('別の支出', async () => { await reconciliation.rejectPair(run.runId, statement.id, candidate.receiptId); await reconciliation.run(); await reviewPage(); }));
        }
        if (!candidates.length) {
          const accountLabel = text('label', '支払元'), categoryLabel = text('label', 'カテゴリ');
          const account = document.createElement('select'), category = document.createElement('select');
          account.id = `account-${statement.id}`; category.id = `category-${statement.id}`; accountLabel.setAttribute('for', account.id); categoryLabel.setAttribute('for', category.id);
          account.append(new Option('選択してください', ''), ...(await ledger.listOpenAccounts()).map(a => new Option(a.name, a.id)));
          category.append(new Option('選択してください', ''), ...(await ledger.listExpenseCategories()).map(c => new Option(c.name, c.id)));
          detail.append(text('p', '記録が見つかりません。ご自身の利用であれば登録できます。'), accountLabel, account, categoryLabel, category, button('自分の利用・レシートなし', async () => { await reconciliation.noReceipt(run.runId, statement.id, { accountId: account.value, categoryId: category.value }); await reviewPage(); }, false));
        }
      }
      item.append(detail); list.append(item);
    }
    view.append(list);
    if (automatic.length) {
      const history = document.createElement('details');
      history.append(text('summary', `自動確認済みの内容を見る（${auto}件）`));
      const matchedList = document.createElement('ul');
      const statementById = new Map(allStatements.map(statement => [statement.id, statement]));
      const receiptById = new Map(allReceipts.map(receipt => [receipt.id, receipt]));
      automatic.sort((a, b) => (statementById.get(b.statementId)?.usedDate ?? b.createdAt).localeCompare(statementById.get(a.statementId)?.usedDate ?? a.createdAt));
      for (const decision of automatic) {
        const statement = statementById.get(decision.statementId), receipt = receiptById.get(decision.receiptId ?? '');
        const item = document.createElement('li'), detail = document.createElement('details');
        detail.append(text('summary', statement ? `${statement.usedDate} · ${statement.merchant} · ${yen(statement.amountYen)}` : `保存済みの照合 · ${yen(decision.statementAmountYen)}`));
        detail.append(text('p', '同じ支出として自動確認済みです。'));
        detail.append(text('p', statement ? `明細：${statement.usedDate}${statement.usedTime ? ` ${statement.usedTime.slice(0, 5)}` : ''} · ${statement.merchant} · ${yen(statement.amountYen)}${statement.paymentMethod ? ` · ${statement.paymentMethod}` : ''}` : '対応する明細を端末で見つけられませんでした。'));
        const value = receipt?.confirmedValue;
        detail.append(text('p', value ? `レシート：${value.purchasedDate}${value.purchasedTime ? ` ${value.purchasedTime}` : ''} · ${value.merchant} · ${yen(value.totalAmountYen)}` : '対応するレシートを端末で見つけられませんでした。'));
        if (receipt) detail.append(button('レシートを確認する', () => receiptEditor(receipt)));
        item.append(detail); matchedList.append(item);
      }
      history.append(matchedList); view.append(history);
    }
  }
  for (const [tab, render] of [['home', home], ['receipt', recordsPage], ['statement', statementPage], ['reconciliation', reviewPage]] as const) el(`${tab}-tab`).addEventListener('click', () => { searchOrigin = false; void render().catch(report); });
  el('home-capture').addEventListener('click', () => { void recordChooser().catch(report); });
  // A user chooses a budget explicitly when multiple local budgets are available.
  const setup = el('local-settings');
  await initializeBackupUi(repository, ledger);
  setup.append(text('h2', 'この端末の家計簿'), el('import-section'), el('budget-section'));
  const budgetEntry = button('予算設定', budgetEditor); budgetEntry.classList.add('master-entry'); budgetEntry.setAttribute('aria-label', '予算設定'); setup.append(budgetEntry);
  const recurringEntry = button('定期登録', recurringOverview); recurringEntry.classList.add('master-entry'); recurringEntry.setAttribute('aria-label', '定期登録'); setup.append(recurringEntry);
  if (!crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') { el('message').textContent = '家計簿を開くためにページを再読込してください。'; return; }
  try { await ledger.listOpenAccounts(); } catch (error) { if (!(error instanceof ActualBudgetSelectionRequiredError)) throw error; }
  const actual = await import('@actual-app/api');
  const budgets = await actual.getBudgets(); const selector = el<HTMLSelectElement>('budget'); selector.replaceChildren(...budgets.map(b => new Option(b.name, b.id))); if (!budgetId) selector.prepend(new Option('家計簿を選択してください', '')); selector.value = budgetId ?? ''; el('budget-section').hidden = false;
  selector.addEventListener('change', () => { void (async () => { if ((await receipts.list()).length || (await statements.list()).length) { selector.value = budgetId ?? ''; throw new Error('記録のある家計簿は切り替えられません。'); } budgetId = selector.value; await repository.put({ id: 'settings:budget', kind: 'app-settings', value: { budgetId, dataDir }, updatedAt: new Date().toISOString() }); location.reload(); })().catch(report); });
  const zip = el<HTMLInputElement>('import-file'); el('import-section').hidden = false;
  el('import-button').addEventListener('click', () => zip.click());
  zip.addEventListener('change', () => { const file = zip.files?.[0]; if (file) void (async () => { if ((await receipts.list()).length || (await statements.list()).length) throw new Error('記録済みの端末では別の家計簿を読み込めません。'); await restoreStandaloneBudget(file, ledger); location.reload(); })().catch(report); });
  async function protectUndoReference(id: string, field: 'account' | 'category') {
    if ((await deletions.list()).some(audit => (audit.status === 'pending' || audit.status === 'restoring' || audit.status === 'deleted' && Date.parse(audit.undoUntil) > Date.now()) && audit.nativeSnapshot.some(row => row[field] === id))) throw new Error('取り消せる削除の記録があります。取り消し時間が終わってから削除してください。');
  }
  const masterUi = initializeMasterUi(setup, ledger, { onBack: () => { el('message').textContent = ''; }, onTransaction: async row => { const displayed = row.kind === 'transfer' && row.amountYen > 0 && row.transferId ? await ledger.getTransactionById(row.transferId) : row; if (!displayed) throw new Error('取引が見つかりません。'); await transactionDetail(displayed); }, beforeDeleteAccount: id => protectUndoReference(id, 'account'), beforeDeleteCategory: id => protectUndoReference(id, 'category') });
  resetMasterUi = masterUi;
  openAccountBalances = masterUi.openAccounts;
  el('settings-tab').addEventListener('click', () => { searchOrigin = false; resetMasterUi(); const flush = flushReceiptDraft; flushReceiptDraft = () => Promise.resolve(); void flush().catch(report); });
  if (budgetId) {
    await deletions.recoverPending();
    await recurring.retry();
    await ledger.runDueSchedules();
    const latestDeletion = (await deletions.list()).filter(audit => audit.status === 'deleted' && Date.parse(audit.undoUntil) > Date.now()).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (latestDeletion) showDeletionToast(latestDeletion);
    if (!el('household-view').hidden) await home(); else el('message').textContent = ''; } else el('message').textContent = '使う家計簿を選択してください。';
}
