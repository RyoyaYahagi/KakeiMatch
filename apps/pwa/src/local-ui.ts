import { createAccountMetadataAccess } from './local-account-metadata';
import { accountOptions } from './local-account-ui';
import { renderMonthlyBudgets, showMonthlyBudgetEditor } from './local-monthly-budgets';
import { LocalMonthlyBudgetService } from './local-monthly-budget-service';
import { LocalRecurringService } from './local-recurring';
import { showRecurringSchedules } from './local-recurring-ui';
import { attachReceiptSearchItems, emptySearchFilters, type TransactionSearchFilters } from './local-transaction-search';
import { showTransactionSearch } from './local-transaction-search-ui';
import { renderCategoryBreakdown, renderMonthlyDashboard, monthEnd, shiftMonth } from './local-monthly-dashboard';
import { renderHomeAttention, type HomeAttentionCounts } from './home-attention';
import { daysBetween, reviewSummaryRow, shortDay, updateReconciliationBadge } from './reconciliation-ui';
import { pendingReceiptRow, recordRow } from './record-row';
import { renderRecordGroups, type RecordKindFilter } from './records-list';
import { dateShortcuts, formActions, optionalFields } from './entry-form';
import { enhanceCategorySelect, recentCategoryUsage } from './category-picker';
import { icon } from './ui-icons';
import { LocalTransactionDeletionService } from './local-transaction-deletions';
import { showManualTransactionEditor } from './local-transaction-ui';
import type { ActualTransaction } from '../../../src/lib/actual-ledger';
import { initializeMasterUi, createMasterShortcut } from './local-master-ui';
import { initializeBackupUi } from './local-backup-ui';
import { recoverHouseholdSwitch, restoreStandaloneBudget, type LocalBudgetSettings } from './local-backup';
import { guardLedger, HouseholdWriteGuard } from './household-write-guard';
import { DeviceSyncApi } from './device-sync-api';
import { DeviceSyncEngine } from './device-sync-engine';
import { DeviceSyncSecretStore } from './device-sync-secrets';
import { initializeDeviceSyncUi } from './device-sync-ui';
import { ActualBudgetSelectionRequiredError, createActualBrowserLedger } from '../../../src/lib/actual-browser-ledger';
import { getOrCreateLocalProfileId, LOCAL_PROFILE_KEY, LocalDataRepository } from '../../../src/lib/local-data';
import { LocalReceiptService, type LocalReceipt, type ReceiptItem, type ReceiptAdjustment } from './local-receipts';
import { LocalStatementService } from './local-statements';
import type { StatementProvider } from './statement-parser';
import { LocalReconciliationService } from './local-reconciliation';
import { LocalCategoryLearning } from './local-category-learning';
import { initializeCategoryRulesUi } from './local-category-rules-ui';
import { CATEGORY_LABELS, isCategoryId } from '../../../src/lib/category';
import { setNavActive } from './app-nav';
import { recordDiagnosticAction, recordDiagnosticFailure, recordDiagnosticScreen, type DiagnosticAction, type DiagnosticScreen } from './contact-diagnostics';
import { recordLocalDiagnostic } from './local-diagnostics';

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const HOME_RECENT_LIMIT = 3;
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
// A newer screen switch replaced the screen this render or action belonged to.
class StaleScreenError extends Error {}
function report(error: unknown) {
  if (error instanceof StaleScreenError) return;
  recordDiagnosticFailure(error);
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

/** Another tab switched the household. Ask for a reload; never reload while someone may be typing. */
function watchHouseholdSwitch(profileId: string) {
  window.addEventListener('storage', event => {
    if (event.key !== LOCAL_PROFILE_KEY || event.newValue === profileId || document.getElementById('household-switch-notice')) return;
    const notice = text('p', '別の画面で家計データが切り替わりました。最新の内容を表示するには再読み込みしてください。', 'network-status');
    notice.id = 'household-switch-notice';
    notice.setAttribute('role', 'status');
    notice.append(button('再読み込み', () => { location.reload(); }));
    el('network').after(notice);
  });
}

export async function initializeLocalUi(options: { openAccount: () => void; reauthenticate: () => Promise<boolean> }) {
  // Every household write in this tab goes through one guard for device sync bookkeeping.
  const guard = new HouseholdWriteGuard(getOrCreateLocalProfileId());
  const repository = await LocalDataRepository.open(guard.profileId, indexedDB, { writeGate: guard.repositoryGate });
  watchHouseholdSwitch(guard.profileId);
  const saved = await repository.get<LocalBudgetSettings>('settings:budget');
  let budgetId = saved?.value.budgetId ?? null;
  const dataDir = saved?.value.dataDir ?? '/documents';
  let monthlyBudgets: LocalMonthlyBudgetService | null = null;
  const accountMetadata = createAccountMetadataAccess(repository);
  const ledger = guardLedger(createActualBrowserLedger({ ...accountMetadata, getBudgetId: () => budgetId, getDataDir: () => dataDir, saveBudgetId: async id => {
    budgetId = id; await repository.put({ id: 'settings:budget', kind: 'app-settings', value: { budgetId: id, dataDir }, updatedAt: new Date().toISOString() });
    monthlyBudgets = new LocalMonthlyBudgetService(repository, ledger, id);
  } }), guard);
  await recoverHouseholdSwitch(repository, ledger);
  if (budgetId) monthlyBudgets = new LocalMonthlyBudgetService(repository, ledger, budgetId);
  const receipts = new LocalReceiptService(repository, ledger);
  const categoryLearning = new LocalCategoryLearning(repository);
  const statements = new LocalStatementService(repository);
  const reconciliation = new LocalReconciliationService(repository, ledger,
    accountId => budgetId ? accountMetadata.getStatementProvider(budgetId, accountId) : Promise.resolve(null));
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
      if (screenTab === 'receipt') await returnToRecords();
      showDeletionToast(audit);
    });
    remove.classList.add('destructive'); return remove;
  }
  let imageUrl: string | null = null;
  let resetMasterUi = () => {};
  let openAccountBalances: () => Promise<void> = () => Promise.resolve();
  let flushReceiptDraft: () => Promise<void> = () => Promise.resolve();
  // Every screen switch takes a new number. Renders check theirs after each await, so only the latest switch is drawn.
  let screenRevision = 0;
  let screenTab: 'home' | 'receipt' | 'statement' | 'reconciliation' | 'settings' = 'home';
  function ensureScreen(revision: number) { if (revision !== screenRevision) throw new StaleScreenError(); }
  // An action redraws its screen only while the person stays on that tab.
  function ensureTab(tab: typeof screenTab) { if (tab !== screenTab) throw new StaleScreenError(); }
  async function open(tab: 'home' | 'receipt' | 'statement' | 'reconciliation', prepared?: HTMLElement) {
    const diagnosticScreen: DiagnosticScreen = tab === 'receipt' ? 'records' : tab === 'statement' ? 'statements' : tab;
    const diagnosticAction: DiagnosticAction = tab === 'receipt' ? 'navigate_records' : tab === 'statement' ? 'navigate_statements' : tab === 'reconciliation' ? 'navigate_reconciliation' : 'navigate_home';
    recordDiagnosticAction(diagnosticAction, diagnosticScreen);
    recordDiagnosticScreen(diagnosticScreen);
    const revision = ++screenRevision; screenTab = tab;
    await flushReceiptDraft(); flushReceiptDraft = () => Promise.resolve();
    ensureScreen(revision);
    resetMasterUi(); if (imageUrl) { URL.revokeObjectURL(imageUrl); imageUrl = null; }
    el('household-view').hidden = tab !== 'home'; el('settings-view').hidden = true; view.hidden = tab === 'home';
    for (const id of ['home', 'receipt', 'reconciliation', 'settings']) {
      setNavActive(el(`${id}-tab`), id === tab || (tab === 'statement' && id === 'settings'));
    }
    el('message').textContent = '';
    if (prepared) view.replaceChildren(prepared); else view.replaceChildren();
    return revision;
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
    // A newer home render owns the busy flag; otherwise clear it even when this render stops early.
    try { await renderHome(); } finally { if (revision === homeRevision) el('home-summary').setAttribute('aria-busy', 'false'); }
  }
  async function renderHome() {
    const screen = await open('home');
    const month = selectedMonth;
    if (!monthlyBudgets) throw new Error('家計簿を選択してください。');
    const [rows, summary, budgetSummary, accounts] = await Promise.all([ledger.getTransactions({ startDate: `${month}-01`, endDate: monthEnd(month) }), ledger.getMonthlySummary({ yearMonth: month }), monthlyBudgets.getSummary(month), ledger.listAccounts()]);
    ensureScreen(screen);
    const overview = renderMonthlyDashboard(el('home-summary'), summary, today().slice(0, 7), action => {
      selectedMonth = action.type === 'current' ? today().slice(0, 7) : shiftMonth(selectedMonth, action.offset);
      void home().catch(report);
    });
    renderMonthlyBudgets(overview, budgetSummary, () => { void budgetEditor('monthly').catch(report); });
    renderCategoryBreakdown(el('home-categories'), summary);
    const accountNames = new Map(accounts.map(account => [account.id, account.name]));
    const list = el('transactions'); list.replaceChildren();
    for (const row of rows.filter(row => row.kind !== 'transfer' || row.amountYen < 0).slice(0, HOME_RECENT_LIMIT)) {
      const item = document.createElement('li');
      item.append(recordRow(row, accountNames.get(row.accountId) ?? null, () => { void transactionDetail(row).catch(report); }));
      list.append(item);
    }
    if (!rows.length) list.append(text('li', 'まだ記録がありません。', 'empty'));

    const { counts } = await reconciliationState();
    ensureScreen(screen);
    renderHomeAttention(el('home-attention'), counts, () => reviewPage().catch(report));
  }
  async function budgetEditor(mode: 'default' | 'monthly' = 'default') {
    if (!monthlyBudgets) throw new Error('家計簿を選択してください。');
    const originRevision = screenRevision;
    const originTab = screenTab;
    const prepared = document.createElement('div');
    await showMonthlyBudgetEditor({ view: prepared, ledger, service: monthlyBudgets, mode, yearMonth: selectedMonth, onBack: () => el('settings-tab').click(), onMonth: month => { selectedMonth = month; } });
    if (screenTab !== originTab || screenRevision !== originRevision) return;
    await open('statement', prepared);
  }
  async function recurringOverview() {
    const originRevision = screenRevision;
    const prepared = document.createElement('div');
    await showRecurringSchedules({ view: prepared, ledger, service: recurring, onBack: () => el('settings-tab').click() });
    if (screenTab !== 'settings' || screenRevision !== originRevision) return;
    await open('statement', prepared);
  }
  let chooserOrigin: () => Promise<void> = () => recordsPage();
  // docs/UX.md ＋追加: a bottom sheet over the current screen chooses the kind of record.
  const recordSheet = document.createElement('dialog'); recordSheet.id = 'record-sheet'; recordSheet.className = 'record-sheet'; recordSheet.setAttribute('aria-labelledby', 'record-sheet-title');
  document.body.append(recordSheet);
  recordSheet.addEventListener('click', event => { if (event.target === recordSheet) recordSheet.close(); });
  function closeRecordSheet() { if (recordSheet.open) recordSheet.close(); }
  /** Entry screens return here: the screen the sheet was opened from, with the sheet on top again. */
  async function returnToChooser() { await chooserOrigin(); await recordChooser(); }
  async function recordChooser() {
    newEntryReturn = returnToChooser;
    const body = document.createElement('div'); body.className = 'sheet-body';
    const grabber = document.createElement('div'); grabber.className = 'sheet-grabber'; grabber.setAttribute('aria-hidden', 'true');
    const header = document.createElement('div'); header.className = 'page-header';
    const close = button('閉じる', closeRecordSheet); close.className = 'icon-button'; close.setAttribute('aria-label', '閉じる'); close.replaceChildren(icon('close'));
    const title = text('h2', '何を記録しますか？'); title.id = 'record-sheet-title';
    header.append(title, close);
    const capture = document.createElement('input'); capture.type = 'file'; capture.accept = 'image/jpeg,image/png,image/webp'; capture.setAttribute('capture', 'environment'); capture.hidden = true;
    const library = document.createElement('input'); library.type = 'file'; library.accept = capture.accept; library.hidden = true;
    const saveFile = (input: HTMLInputElement) => { input.addEventListener('change', () => { const file = input.files?.[0]; if (!file) return; closeRecordSheet(); void receipts.saveImage(file).then(receipt => receiptEditor(receipt)).catch(report); }); };
    saveFile(capture); saveFile(library);
    const camera = document.createElement('button'); camera.type = 'button'; camera.className = 'choice-primary'; camera.setAttribute('aria-label', 'レシートを撮る');
    const cameraBadge = document.createElement('span'); cameraBadge.className = 'choice-primary-icon'; cameraBadge.append(icon('camera'));
    const cameraText = document.createElement('span'); cameraText.className = 'choice-primary-text'; cameraText.append(text('strong', 'レシートを撮る'), text('span', '写真を残して、内容を読み取れます'));
    camera.append(cameraBadge, cameraText, icon('chevronRight'));
    camera.addEventListener('click', () => capture.click());
    const choices = document.createElement('ul'); choices.className = 'choice-list surface-section';
    const startEntry = (kind: 'expense' | 'income' | 'transfer') => () => { closeRecordSheet(); return manualEditor(kind); };
    for (const [label, symbol, tone, action] of [
      ['保存した写真から', 'image', 'food', () => library.click()],
      ['支出を手入力', 'pencil', 'other', startEntry('expense')],
      ['収入', 'income', 'income', startEntry('income')],
      ['口座間振替', 'transfer', 'other', startEntry('transfer')],
    ] as const) {
      const item = document.createElement('li');
      const choice = button(label, action); choice.className = 'choice-row';
      const badge = document.createElement('span'); badge.className = `record-icon tone-${tone}`; badge.append(icon(symbol));
      choice.prepend(badge); choice.append(icon('chevronRight'));
      item.append(choice); choices.append(item);
    }
    body.append(grabber, header, capture, library, camera, choices, text('p', '写真と入力内容はこの端末に保存します。読み取りは「AIで読み取る」を選んだ時だけ行います。', 'muted'));
    recordSheet.replaceChildren(body);
    // Swiping the sheet down by more than 80px closes it, like other bottom sheets on the phone.
    let dragStart: number | null = null;
    // A mouse on a PC drags nothing: there the sheet is a centered dialog (docs/DESIGN.md PC).
    const startDrag = (event: PointerEvent) => { if (event.pointerType !== 'mouse') dragStart = event.clientY; };
    header.addEventListener('pointerdown', startDrag);
    grabber.addEventListener('pointerdown', startDrag);
    body.addEventListener('pointermove', event => { if (dragStart === null) return; const distance = Math.max(0, event.clientY - dragStart); recordSheet.style.setProperty('--sheet-drag', `${distance}px`); });
    const endDrag = (event: PointerEvent) => { if (dragStart === null) return; const distance = event.clientY - dragStart; dragStart = null; recordSheet.style.removeProperty('--sheet-drag'); if (distance > 80) closeRecordSheet(); };
    body.addEventListener('pointerup', endDrag); body.addEventListener('pointercancel', () => { dragStart = null; recordSheet.style.removeProperty('--sheet-drag'); });
    if (!recordSheet.open) recordSheet.showModal();
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
      onSaved: async () => { ensureTab('receipt'); if (transaction) await transactionDetail(transaction); else await returnToRecords(); el('message').textContent = transaction ? '変更を保存しました。' : '登録しました。'; },
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
  let recordsFilter: RecordKindFilter = 'all';
  async function recordsPage() {
    searchOrigin = false;
    newEntryReturn = recordsPage;
    const screen = await open('receipt');
    const header = document.createElement('div'); header.className = 'page-header';
    const search = document.createElement('button'); search.type = 'button'; search.className = 'icon-button'; search.setAttribute('aria-label', '検索・絞り込み'); search.append(icon('search'));
    search.addEventListener('click', () => { void busy(search, searchPage); });
    header.append(text('h2', '記録'), search);
    const filters = document.createElement('div'); filters.className = 'segmented'; filters.setAttribute('role', 'group'); filters.setAttribute('aria-label', '種類で絞り込む');
    const accountsLink = button('口座・残高を見る', accountBalancesPage); accountsLink.className = 'text-button link-row'; accountsLink.prepend(icon('wallet')); accountsLink.append(icon('chevronRight'));
    view.append(header, filters, accountsLink);
    const [localReceipts, rows, accounts, reconciliationView] = await Promise.all([receipts.list(), ledger.getRecentTransactions({ limit: 100 }), ledger.listAccounts(), reconciliationState()]);
    // docs/UX.md 記録一覧: records that are candidates of a statement still waiting for a decision.
    const reviewTransactionIds = new Set((reconciliationView.run?.candidates ?? [])
      .filter(candidate => reconciliationView.pending.some(row => row.status === 'needs_review' && row.statementTransactionId === candidate.statementTransactionId))
      .map(candidate => localReceipts.find(receipt => receipt.id === candidate.receiptId)?.registration.actualTransactionId ?? (candidate.receiptId.startsWith('actual:') ? candidate.receiptId.slice('actual:'.length) : null))
      .filter((id): id is string => Boolean(id)));
    ensureScreen(screen);
    const pending = localReceipts.filter(receipt => receipt.registration.status !== 'applied' && receipt.registration.status !== 'deleted');
    if (pending.length) {
      const section = document.createElement('section'); section.className = 'surface-section record-day';
      const list = document.createElement('ul'); list.className = 'record-rows';
      for (const receipt of pending) {
        const item = document.createElement('li');
        const title = receipt.confirmedValue?.merchant || receipt.extraction?.merchant || (receipt.image ? '未入力のレシート' : '未入力の支出');
        const canDeletePending = receipt.registration.status === 'pending' && receipt.registration.actualTransactionId === null;
        item.append(pendingReceiptRow(title, () => { void receiptEditor(receipt).catch(report); }, canDeletePending ? () => {
          if (!window.confirm(`「${title}」を削除しますか？このレシート画像と確認待ちの内容も削除されます。`)) return;
          const removeButton = item.querySelector<HTMLButtonElement>('.pending-receipt-delete');
          if (!removeButton || removeButton.disabled) return;
          removeButton.disabled = true;
          removeButton.textContent = '削除中…';
          removeButton.setAttribute('aria-label', `削除中: ${title}`);
          void receipts.deletePending(receipt.id).then(async () => {
            if (screenTab === 'receipt') await recordsPage();
          }).catch(error => {
            report(error);
            removeButton.textContent = '削除';
            removeButton.setAttribute('aria-label', `削除: ${title}`);
            removeButton.disabled = false;
          });
        } : undefined));
        list.append(item);
      }
      section.append(text('h3', `確認待ち ${pending.length}件`, 'record-day-header'), list);
      view.append(section);
    }
    const groups = document.createElement('div'); groups.className = 'record-groups';
    const empty = text('p', 'まだ記録がありません。', 'empty');
    view.append(groups, empty);
    const records = rows.filter(row => row.kind !== 'transfer' || row.amountYen < 0);
    const accountNames = new Map(accounts.map(account => [account.id, account.name]));
    const receiptFor = (row: ActualTransaction) => localReceipts.find(receipt => receipt.registration.actualTransactionId === row.id);
    const render = () => {
      const shown = renderRecordGroups(groups, records, {
        filter: recordsFilter,
        accountName: id => accountNames.get(id) ?? null,
        hasReceipt: row => Boolean(receiptFor(row)?.image),
        needsReview: row => reviewTransactionIds.has(row.id),
        open: row => { const receipt = receiptFor(row); void (receipt ? receiptEditor(receipt) : transactionDetail(row)).catch(report); },
      });
      empty.hidden = shown > 0 || (recordsFilter === 'all' && pending.length > 0);
      empty.textContent = recordsFilter === 'all' ? 'まだ記録がありません。' : 'この種類の記録はありません。';
      filters.querySelectorAll('button').forEach(option => option.setAttribute('aria-pressed', String(option.dataset.filter === recordsFilter)));
    };
    for (const [value, label] of [['all', 'すべて'], ['expense', '支出'], ['income', '収入'], ['transfer', '振替']] as const) {
      const option = document.createElement('button'); option.type = 'button'; option.textContent = label; option.dataset.filter = value;
      option.addEventListener('click', () => { recordsFilter = value; render(); });
      filters.append(option);
    }
    render();
  }
  async function transactionDetail(transaction: ActualTransaction) {
    const linked = (await receipts.list()).find(receipt => receipt.registration.actualTransactionId === transaction.id);
    if (linked) { await receiptEditor(linked); return; }
    const screen = await open('receipt');
    const [accounts, current] = await Promise.all([ledger.listAccounts(), ledger.getTransactionById(transaction.id)]);
    ensureScreen(screen);
    if (!current) throw new Error('記録が見つかりません。記録一覧を読み込み直してください。');
    const back = button(searchOrigin ? '検索結果へ戻る' : '記録一覧へ戻る', returnToRecords); back.className = 'text-button back-link'; back.prepend(icon('chevronLeft'));
    view.append(back, text('h2', current.kind === 'income' ? '収入の記録' : current.kind === 'transfer' ? '振替の記録' : '支出の記録'));
    const detail = document.createElement('dl'); detail.className = 'transaction-detail surface-section';
    const values = current.kind === 'transfer' ? [
      ['金額', yen(current.amountYen)], ['日付', current.date],
      ['振替元口座', accounts.find(account => account.id === current.accountId)?.name || '利用不可'],
      ['振替先口座', accounts.find(account => account.id === current.transferAccountId)?.name || '利用不可'],
      ['メモ', current.memo || 'なし'],
    ] : [['金額', yen(current.amountYen)], ['日付', current.date], [current.kind === 'income' ? '入金元・内容' : '店名・支払先', current.payeeName || '未設定'], ['カテゴリ', current.categoryName || '未設定'], [current.kind === 'income' ? '入金先口座' : '支払元', accounts.find(account => account.id === current.accountId)?.name || '利用不可'], ['メモ', current.memo || 'なし']];
    for (const [index, [label, value]] of values.entries()) {
      const group = document.createElement('div'); group.className = index === 0 ? 'detail-amount' : 'detail-row';
      group.append(text('dt', label), text('dd', value)); detail.append(group);
    }
    view.append(detail);
    const actions = document.createElement('div'); actions.className = 'detail-actions';
    if (current.kind === 'transfer') actions.append(button('編集する', () => manualEditor('transfer', current), false));
    if (current.kind !== 'transfer' && !current.isSplit) actions.append(button('編集する', () => manualEditor(current.kind === 'income' ? 'income' : 'expense', current), false));
    const remove = deleteButton(current.id); remove.className = 'text-button destructive-text';
    actions.append(remove); view.append(actions);
  }
  async function receiptDetail(receipt: LocalReceipt) {
    const screen = await open('receipt');
    const value = receipt.confirmedValue;
    if (!value) throw new Error('登録したレシートを確認できません。');
    const pending = await receipts.getPendingEdit(receipt.id);
    const accounts = await ledger.listAccounts();
    const categories = await ledger.listCategories();
    ensureScreen(screen);
    const categoryName = (id: string | null) => categories.find(category => category.id === id)?.name ?? (isCategoryId(id) ? CATEGORY_LABELS[id] : '未分類');
    // docs/UX.md 記録の詳細: same layout as other records; the receipt image and items open step by step.
    const back = button(searchOrigin ? '検索結果へ戻る' : '記録一覧へ戻る', returnToRecords); back.className = 'text-button back-link'; back.prepend(icon('chevronLeft'));
    const summary = document.createElement('section'); summary.className = 'surface-section receipt-summary';
    const registered = text('p', '家計簿へ登録済みです。', 'registered-note'); registered.prepend(icon('check'));
    summary.append(text('p', `支出 ${yen(value.totalAmountYen)}`, 'receipt-summary-amount'), text('p', `${value.purchasedDate}${value.purchasedTime ? ` ${value.purchasedTime}` : ''}`, 'muted'),
      text('p', `${categoryName(value.categoryId)} · ${accounts.find(account => account.id === value.accountId)?.name ?? '利用不可'}`), registered);
    view.append(back, text('h2', value.merchant), summary);
    if (pending) view.append(text('p', '前回の変更は保存結果を確認中です。編集画面で同じ内容を再試行してください。', 'notice notice-warning'));
    if (receipt.aiSuggestion.categoryRules?.length) {
      const reasons = document.createElement('details'); reasons.className = 'surface-section detail-disclosure';
      reasons.append(text('summary', '分類の理由'));
      reasons.append(text('p', 'レシートを読み取った時に適用した、いつもの分類です。'));
      for (const rule of receipt.aiSuggestion.categoryRules) {
        const kind = rule.targetType === 'item' ? '品目' : '店舗';
        reasons.append(text('p', `${kind}「${rule.normalizedName}」→「${rule.categoryName}」で分類しました。`));
        reasons.append(text('p', `適用時は過去${rule.receipts}件中${rule.matchingReceipts}件が「${rule.categoryName}」でした（一致率 ${rule.agreementPercent}%）。`, 'muted'));
      }
      view.append(reasons);
    }
    if (receipt.image) {
      const image = document.createElement('details'); image.className = 'surface-section detail-disclosure'; image.append(text('summary', 'レシート画像'));
      image.addEventListener('toggle', () => { if (!image.open || image.childElementCount > 1) return; void repository.getBlob(receipt.image!.blobId).then(blob => { if (!image.isConnected) return; if (!blob) { image.append(text('p', 'レシート画像の原本はありません。')); return; } imageUrl = URL.createObjectURL(blob.blob); const img = document.createElement('img'); img.src = imageUrl; img.alt = '保存したレシート'; img.className = 'receipt-preview'; image.append(img); }).catch(report); });
      view.append(image);
    }
    if (value.memo) summary.append(text('p', `メモ：${value.memo}`));
    if (value.items?.length) {
      const items = document.createElement('details'); items.className = 'surface-section detail-disclosure'; items.append(text('summary', '購入内容'));
      const list = document.createElement('ul'); list.className = 'record-list';
      for (const item of value.items) list.append(text('li', `${item.name} · ${item.amountYen == null ? '金額未入力' : yen(item.amountYen)} · ${categoryName(item.categoryId ?? value.categoryId)}`));
      items.append(list); view.append(items);
    }
    if (value.adjustments?.length) {
      const adjustments = document.createElement('details'); adjustments.className = 'surface-section detail-disclosure'; adjustments.append(text('summary', '値引き・調整'));
      for (const adjustment of value.adjustments) adjustments.append(text('p', `${adjustment.label} · ${adjustment.amountYen < 0 ? '−' : '+'}${yen(adjustment.amountYen)}`));
      view.append(adjustments);
    }
    const actions = document.createElement('div'); actions.className = 'detail-actions';
    actions.append(button('編集する', () => receiptEditor(receipt, { edit: true }), false));
    if (receipt.registration.actualTransactionId) { const remove = deleteButton(receipt.registration.actualTransactionId); remove.className = 'text-button destructive-text'; actions.append(remove); }
    view.append(actions);
  }
  async function receiptEditor(receipt: LocalReceipt, editorOptions: { useExtraction?: boolean; preserveAccountId?: string; edit?: boolean } = {}) {
    if (receipt.registration.status === 'deleted') throw new Error('この取引は削除済みです。記録一覧を開き直してください。');
    if (receipt.registration.status === 'applied' && !editorOptions.edit) { await receiptDetail(receipt); return; }
    const editing = receipt.registration.status === 'applied';
    const screen = await open('receipt'); view.append(text('h2', editing ? '支出の記録を編集' : receipt.image ? 'レシートを登録する' : '支出を入力'));
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
    ensureScreen(screen);
    const editorTabs = document.createElement('div'); editorTabs.className = 'segmented entry-editor-tabs';
    editorTabs.setAttribute('role', 'group'); editorTabs.setAttribute('aria-label', '入力内容の表示');
    const overviewTab = document.createElement('button'); overviewTab.type = 'button'; overviewTab.textContent = '全体';
    const itemsTab = document.createElement('button'); itemsTab.type = 'button'; itemsTab.textContent = '品目一覧';
    editorTabs.append(overviewTab, itemsTab);
    const overviewExtras = document.createElement('div'); overviewExtras.className = 'entry-overview-extras';
    view.append(editorTabs, overviewExtras);
    if (!blob && receipt.image) overviewExtras.append(text('p', 'レシート画像の原本はありません。原本の確認・再解析はできません。保存済みの内容は利用できます。'));
    if (blob) { imageUrl = URL.createObjectURL(blob.blob); const img = document.createElement('img'); img.src = imageUrl; img.alt = '保存したレシート'; img.className = 'receipt-preview'; overviewExtras.append(img); }
    if (receipt.extraction?.warnings.length) overviewExtras.append(text('p', '読み取り結果に確認が必要な項目があります。画像と照らし合わせてください。'));

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
    account.replaceChildren(new Option('選択してください', ''), ...accountOptions(accounts));
    account.value = initial.accountId;
    if (initial.accountId && !account.value) overviewExtras.append(text('p', '以前の支払元は利用できません。支払元を選び直してください。'));
    if (base?.categoryId && !category.value) overviewExtras.append(text('p', '以前のカテゴリは利用できません。カテゴリを選び直してください。'));
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
      recordDiagnosticAction('receipt_ai_started', 'records');
      await saveDraft();
      const accountId = account.value;
      form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement | HTMLTextAreaElement>('input,select,textarea,button').forEach(control => { control.disabled = true; });
      try {
        await receipts.analyze(receipt.id);
        try {
          const suggested = await receipts.suggestCategory(receipt.id);
          recordLocalDiagnostic('ai');
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
    if (blob && !editing) { aiArea.append(aiButton); overviewExtras.append(aiArea); }
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
    amount.classList.add('amount-input');
    const optional = optionalFields('時刻・メモを追加（任意）', [timeLabel, time, memoLabel, memo], Boolean(time.value || memo.value));
    const overviewFields = document.createElement('div'); overviewFields.className = 'entry-overview-fields';
    overviewFields.append(amountLabel, amount, merchantLabel, merchant, dateLabel, date, dateShortcuts(date, today()),
      categoryLabel, category, accountLabel, account, optional);
    form.append(overviewFields, purchaseDetails, warning, status);
    view.append(form);
    const setEditorPane = (pane: 'overview' | 'items', scroll = true) => {
      const itemsOnly = pane === 'items';
      overviewTab.setAttribute('aria-pressed', String(!itemsOnly));
      itemsTab.setAttribute('aria-pressed', String(itemsOnly));
      overviewExtras.hidden = itemsOnly;
      overviewFields.hidden = itemsOnly;
      purchaseDetails.classList.toggle('items-only', itemsOnly);
      if (itemsOnly) purchaseDetails.open = true;
      if (scroll) editorTabs.scrollIntoView({ block: 'start' });
    };
    overviewTab.addEventListener('click', () => setEditorPane('overview'));
    itemsTab.addEventListener('click', () => setEditorPane('items'));
    setEditorPane('overview', false);
    // Native validation runs before submit. Reveal hidden basic fields before
    // the browser focuses the invalid control and displays its message.
    form.addEventListener('invalid', event => {
      if (event.target instanceof HTMLElement && overviewFields.contains(event.target)) setEditorPane('overview', false);
    }, true);
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
    enhanceCategorySelect(category, categoryLabel, recentCategoryUsage(ledger));
    account.after(createMasterShortcut({ ledger, request: { kind: 'account' }, origin: {
      field: account, beforeOpen: saveDraft,
      onCreated: async id => {
        accounts = await ledger.listOpenAccounts();
        account.replaceChildren(new Option('選択してください', ''), ...accountOptions(accounts));
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
        const saved = await repository.putIfRecordExists({ id: draftId, kind: 'category-state', value, updatedAt: new Date().toISOString() }, receipt.id);
        status.textContent = saved ? '入力内容を端末に保存しました。' : 'この確認待ちレシートは削除されています。画面を開き直してください。';
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
        const summary = document.createElement('summary'); summary.className = 'receipt-compact-summary';
        const summaryTitle = text('span', '', 'receipt-compact-title');
        const summaryAmount = text('span', '', 'receipt-compact-amount');
        const summaryMeta = text('span', '', 'receipt-compact-meta');
        const refreshSummary = () => {
          summaryTitle.textContent = item.name.trim() || '品目を入力';
          summaryAmount.textContent = item.amountYen == null ? '金額未入力' : yen(item.amountYen);
          summaryMeta.textContent = categoryName(item.categoryId);
        };
        refreshSummary();
        summary.append(summaryTitle, summaryAmount, summaryMeta);
        details.open = expandItemId === item.id;
        details.addEventListener('toggle', () => {
          if (!details.open) {
            if (expandItemId === item.id) expandItemId = null;
            return;
          }
          expandItemId = item.id;
          itemsList.querySelectorAll<HTMLDetailsElement>('details.receipt-item').forEach(other => {
            if (other !== details) other.open = false;
          });
        });
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
          item.name = name.value;
          item.amountYen = parseNullableInteger(itemAmount.value);
          item.categoryId = itemCategory.value || null;
          refreshSummary();
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
        const details = document.createElement('details'); details.className = 'receipt-adjustment-details';
        const summary = document.createElement('summary'); summary.className = 'receipt-compact-summary';
        const summaryTitle = text('span', '', 'receipt-compact-title');
        const summaryAmount = text('span', '', 'receipt-compact-amount');
        const summaryMeta = text('span', '', 'receipt-compact-meta');
        const refreshSummary = () => {
          summaryTitle.textContent = adjustment.label || (adjustment.amountYen > 0 ? '調整' : '値引き');
          summaryAmount.textContent = `${adjustment.amountYen < 0 ? '−' : '+'}${yen(adjustment.amountYen)}`;
          summaryMeta.textContent = adjustment.amountYen > 0 ? 'その他の調整' : '値引き';
        };
        refreshSummary();
        summary.append(summaryTitle, summaryAmount, summaryMeta);
        details.open = expandAdjustmentId === adjustment.id;
        details.addEventListener('toggle', () => {
          if (!details.open) {
            if (expandAdjustmentId === adjustment.id) expandAdjustmentId = null;
            return;
          }
          expandAdjustmentId = adjustment.id;
          adjustmentsList.querySelectorAll<HTMLDetailsElement>('details.receipt-adjustment-details').forEach(other => {
            if (other !== details) other.open = false;
          });
        });
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
          adjustment.label = name.value;
          adjustment.amountYen = (kind.value === 'discount' ? -1 : 1) * Number(value.value);
          refreshSummary();
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
    form.append(formActions(submit));
    form.addEventListener('submit', event => {
      event.preventDefault();
      void busy(submit, async () => {
        if (draftTimer) clearTimeout(draftTimer);
        const value = pendingEdit?.after ?? read();
        if (!value.merchant.trim() || !value.purchasedDate || !value.totalAmountYen || !value.categoryId || !value.accountId) {
          setEditorPane('overview', false);
          // The category picker uses visible buttons instead of native validation.
          if (!value.categoryId) overviewFields.querySelector<HTMLButtonElement>('.category-choice')?.focus();
          throw new Error('店名、日付、合計金額、全体カテゴリ、支払元を確認してください。');
        }
        if (value.items?.some(item => !item.name.trim()) || value.adjustments?.some(item => !item.label.trim())) throw new Error('品目名と値引き・調整の内容を入力してください。');
        recordDiagnosticAction('receipt_save_started', 'records');
        await saveDraft();
        form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement | HTMLTextAreaElement>('input,select,textarea,button').forEach(control => { control.disabled = true; });
        let saved: LocalReceipt;
        try {
          if (editing) saved = await receipts.edit(receipt.id, value, receipt.updatedAt);
          else {
            if (receipt.registration.status === 'pending') await receipts.confirm(receipt.id, value);
            saved = await receipts.register(receipt.id);
          }
          recordLocalDiagnostic('save');
        } catch (error) {
          const current = await receipts.get(receipt.id);
          if (current && screenTab === 'receipt') await receiptEditor(current, { edit: editing });
          throw error;
        }
        await saveTail;
        flushReceiptDraft = () => Promise.resolve();
        await repository.delete(draftId);
        ensureTab('receipt');
        if (editing) await receiptDetail(saved); else await recordsPage();
        el('message').textContent = editing ? '変更を保存しました。' : '登録しました。';
      });
    });
    const cancelEntry = button('キャンセル', editing ? () => receiptDetail(receipt) : newEntryReturn); cancelEntry.className = 'text-button back-link'; cancelEntry.prepend(icon('chevronLeft')); view.prepend(cancelEntry);
    if (!accounts.length || !categories.length) view.append(text('p', 'カテゴリと支払元は、それぞれの選択欄から追加できます。'));
  }
  let selectedStatementProvider: StatementProvider = 'paypay_card';
  const statementProviderLabels: Record<StatementProvider, string> = { paypay: 'PayPay取引履歴（旧形式）', paypay_card: 'PayPayカード', smbc_card: '三井住友カード', rakuten_card: '楽天カード', aeon_card: 'イオンカード' };
  async function renderStatementImporter(collapsed: boolean) {
    const section = document.createElement('section'); section.className = 'statement-importer';
    section.append(text('p', 'PayPayカード、三井住友カード、楽天カードのCSVに対応しています。ファイルはこの端末で処理します。'));
    const providerLabel = fieldLabel('label', '明細サービス', 'statement-provider');
    const provider = document.createElement('select'); provider.id = 'statement-provider';
    provider.append(new Option('PayPayカード', 'paypay_card'), new Option('三井住友カード', 'smbc_card'), new Option('楽天カード', 'rakuten_card'));
    provider.value = selectedStatementProvider;
    provider.addEventListener('change', () => { selectedStatementProvider = provider.value as StatementProvider; });
    const fileLabel = fieldLabel('label', 'CSVファイル', 'statement-file');
    const file = document.createElement('input'); file.id = 'statement-file'; file.type = 'file'; file.accept = '.csv,text/csv';
    const submit = button('取り込んで照合', async () => {
      const selectedFile = file.files?.[0];
      if (!selectedFile) throw new Error('CSVファイルを選択してください。');
      const chosenProvider = provider.value as StatementProvider;
      selectedStatementProvider = chosenProvider;
      recordDiagnosticAction('statement_import_started', 'statements');
      provider.disabled = true; file.disabled = true;
      try {
        const result = await statements.importFile(selectedFile, chosenProvider);
        recordDiagnosticAction('reconciliation_run_started', 'reconciliation');
        await reconciliation.run();
        ensureTab('reconciliation'); await reviewPage();
        const reasons = result.needsReviewRows.map(({ rowNumber, reason }) => `${rowNumber}行目: ${reason}`).join(' / ');
        el('message').textContent = `${result.added}件を取り込み、照合しました。重複 ${result.duplicates}件。対象外 ${result.excluded}件、要確認 ${result.needsReviewRows.length}件。${reasons}`;
      } finally {
        provider.disabled = false; file.disabled = false;
      }
    }, false);
    section.append(providerLabel, provider, fileLabel, file, submit);

    const imports = await statements.imports();
    const rows = await statements.list();
    if (rows.length) section.append(text('p', `取り込み済み ${rows.length}件`));
    for (const record of imports) {
      if (record.value.needsReviewRows?.length) {
        const review = document.createElement('details');
        review.append(text('summary', `${statementProviderLabels[record.value.provider]} CSVの要確認 ${record.value.needsReviewRows.length}件`));
        for (const row of record.value.needsReviewRows) review.append(text('p', `${row.rowNumber}行目: ${row.reason}`));
        section.append(review);
      }
      if (!await repository.getBlob(`statement-source:${record.id}`)) section.append(text('p', '取込元CSVの原本はありません。原本を確認できませんが、明細行と照合結果は利用できます。'));
    }
    if (!collapsed) return section;
    const disclosure = document.createElement('details'); disclosure.className = 'statement-import-disclosure surface-section';
    const disclosureSummary = text('summary', '明細CSVを取り込む'); disclosureSummary.prepend(icon('upload'));
    disclosure.append(disclosureSummary, section);
    return disclosure;
  }
  async function reconciliationState() {
    const [run, decisions] = await Promise.all([reconciliation.latest(), reconciliation.resolutions()]);
    const pending = run?.statementResults.filter(row => row.status !== 'matched' && !decisions.some(d => d.statementId === row.statementTransactionId)) ?? [];
    const counts: HomeAttentionCounts | null = run ? { needsReview: pending.filter(row => row.status === 'needs_review').length, unmatched: pending.filter(row => row.status !== 'needs_review').length, failed: decisions.filter(d => d.status !== 'applied').length } : null;
    updateReconciliationBadge(counts);
    return { run, decisions, pending, counts };
  }
  async function reviewPage() {
    const screen = await open('reconciliation');
    // The result is saved even after leaving; only the redraw is skipped.
    const rerun = async () => { recordDiagnosticAction('reconciliation_run_started', 'reconciliation'); await reconciliation.run(); ensureTab('reconciliation'); await reviewPage(); };
    const header = document.createElement('div'); header.className = 'page-header';
    const refresh = button('照合を更新する', rerun); refresh.className = 'secondary compact';
    header.append(text('h2', '照合'), refresh); view.append(header);
    const { run, decisions, pending } = await reconciliationState();
    ensureScreen(screen);
    for (const decision of decisions.filter(d => d.status !== 'applied')) {
      const failure = document.createElement('div'); failure.className = 'notice notice-danger';
      failure.append(icon('warning'), text('p', '家計簿への反映が完了していません。判断内容は保存されています。'), button('反映を再試行する', async () => { await reconciliation.retry(decision.id); await rerun(); }, false));
      view.append(failure);
    }
    if (!run) { const importer = await renderStatementImporter(false); ensureScreen(screen); view.append(text('p', '明細を取り込んでから照合してください。', 'muted'), importer); return; }
    const automatic = decisions.filter(d => d.source === 'automatic' && d.status === 'applied');
    const auto = automatic.length;
    const needsReview = pending.filter(r => r.status === 'needs_review').length, unmatched = pending.filter(r => r.status === 'unmatched_statement').length;
    const waiting = run.receiptResults.filter(r => r.status === 'unmatched_receipt').length;
    const tiles = document.createElement('div'); tiles.className = 'review-tiles'; tiles.setAttribute('aria-hidden', 'true');
    for (const [tone, symbol, label, count] of [['warning', 'warning', '要確認', needsReview], ['danger', 'unmatched', '記録なし', unmatched], ['success', 'check', '自動で一致', auto]] as const) {
      const tile = document.createElement('div'); tile.className = `review-tile tile-${tone}`;
      const name = document.createElement('span'); name.className = 'review-tile-label'; name.append(icon(symbol), document.createTextNode(label));
      const value = document.createElement('span'); value.className = 'review-tile-count'; value.append(document.createTextNode(String(count)), text('small', '件'));
      tile.append(name, value); tiles.append(tile);
    }
    const resultSummary = text('p', `照合の結果：自動で一致 ${auto}件 · 要確認 ${needsReview}件 · 記録なし ${unmatched}件 · 明細待ち ${waiting}件`, 'visually-hidden'); resultSummary.setAttribute('role', 'status');
    view.append(tiles, resultSummary);
    if (waiting) view.append(text('p', `明細待ちの支出 ${waiting}件（明細を取り込むと照合します）`, 'muted review-waiting'));
    const importer = await renderStatementImporter(true);
    ensureScreen(screen);
    view.append(importer);
    const [allStatements, allReceipts, imports, allAccounts, expenseCategories] = await Promise.all([
      statements.list(), receipts.list(), statements.imports(), ledger.listAccounts(), ledger.listExpenseCategories(),
    ]);
    const importsById = new Map(imports.map(item => [item.id, item.value]));
    const accountsById = new Map(allAccounts.map(account => [account.id, account]));
    const registrationAccounts = (await ledger.listOpenAccounts()).filter(account => account.accountType !== 'cash');
    const mappedProviders = new Map(await Promise.all(registrationAccounts.map(async account =>
      [account.id, budgetId ? await accountMetadata.getStatementProvider(budgetId, account.id) : null] as const)));
    const defaultRegistrationAccount = (statement: Awaited<ReturnType<typeof statements.list>>[number]) => {
      const legacyAccountId = importsById.get(statement.importId)?.accountId;
      if (legacyAccountId && registrationAccounts.some(account => account.id === legacyAccountId)) return legacyAccountId;
      const mapped = registrationAccounts.filter(account => mappedProviders.get(account.id) === statement.provider);
      if (mapped.length === 1) return mapped[0].id;
      return registrationAccounts.length === 1 ? registrationAccounts[0].id : '';
    };
    const list = document.createElement('ul'); list.className = 'review-list';
    const reviewOrder = (status: string) => status === 'needs_review' ? 0 : 1;
    for (const row of pending.filter(r => r.status !== 'matched').sort((a, b) => reviewOrder(a.status) - reviewOrder(b.status) || a.statementTransactionId.localeCompare(b.statementTransactionId))) {
      const statement = allStatements.find(s => s.id === row.statementTransactionId); if (!statement) continue;
      const item = document.createElement('li'); const detail = document.createElement('details'); detail.className = 'review-item';
      const needsDecision = row.status === 'needs_review';
      const summary = reviewSummaryRow(statement.merchant, yen(statement.amountYen), needsDecision ? 'warning' : 'danger');
      const setReason = (reason: string) => { summary.note.textContent = `${shortDay(statement.usedDate)} · ${reason}`; };
      setReason(needsDecision ? '内容を確認してください' : '記録が見つかりません');
      detail.append(summary.element);
      const body = document.createElement('div'); body.className = 'review-body'; detail.append(body);
      if (statement.kind === 'refund') { setReason('返金のため自動で処理できません'); body.append(text('p', '返金の記録です。現在は自動処理できません。')); }
      else {
        const statementSource = statementProviderLabels[statement.provider as StatementProvider] ?? '明細';
        body.append(text('p', `明細：${statement.usedDate} · ${statement.merchant} · ${yen(statement.amountYen)} · ${statementSource}`, 'compare-statement'));
        const candidates = run.candidates.filter(c => c.statementTransactionId === statement.id);
        const reasons: string[] = [];
        for (const candidate of candidates) {
          const receipt = allReceipts.find(r => r.id === candidate.receiptId);
          const actualId = receipt?.registration.actualTransactionId ?? (candidate.receiptId.startsWith('actual:') ? candidate.receiptId.slice('actual:'.length) : null);
          const actual = actualId ? await ledger.getTransactionById(actualId) : null;
          if (!actual || actual.kind !== 'expense') continue;
          const block = document.createElement('div'); block.className = 'compare-candidate';
          const actualAccount = accountsById.get(actual.accountId)?.name ?? '利用できない支払元';
          block.append(text('p', `家計簿：${actual.date} · ${actual.payeeName || '店名なし'} · ${yen(Math.abs(actual.amountYen))} · ${actualAccount}`));
          const amountGap = Math.abs(statement.amountYen - Math.abs(actual.amountYen));
          const dayGap = Math.abs(daysBetween(statement.usedDate, actual.date));
          const differences = [
            ...(actual.date !== statement.usedDate ? [`日付差 ${statement.usedDate} / ${actual.date}`] : []),
            ...(actual.amountYen !== -statement.amountYen ? [`金額差 ${yen(amountGap)}（明細 ${yen(Math.abs(statement.amountYen))} / 家計簿 ${yen(Math.abs(actual.amountYen))}）`] : []),
          ];
          reasons.push(actual.amountYen !== -statement.amountYen ? `金額が${yen(amountGap)}違います` : dayGap ? `日付が${dayGap}日ずれています` : '内容を確認してください');
          if (differences.length) block.append(text('p', `差分：${differences.join(' · ')}`, 'compare-diff'));
          const unsupportedSplitAmount = actual.isSplit === true && actual.amountYen !== -statement.amountYen;
          if (unsupportedSplitAmount) block.append(text('p', '分割された記録の金額差は反映できません。別の候補を選ぶか、明細を確認してください。'));
          const sameExpense = button('同じ支出', async () => { await reconciliation.sameExpense(run.runId, statement.id, candidate.receiptId); await rerun(); }, false);
          sameExpense.disabled = unsupportedSplitAmount;
          const otherExpense = button('別の支出', async () => { await reconciliation.rejectPair(run.runId, statement.id, candidate.receiptId); await rerun(); }); otherExpense.className = 'text-button';
          block.append(sameExpense, otherExpense);
          body.append(block);
        }
        if (reasons.length > 1) setReason(`候補が${reasons.length}件あります`); else if (reasons.length === 1) setReason(reasons[0]);
        if (!candidates.length) {
          const category = document.createElement('select'); category.id = `category-${statement.id}`; category.required = true;
          const categoryLabel = fieldLabel('label', 'カテゴリ', category.id);
          category.append(new Option('カテゴリを選択してください', ''), ...expenseCategories.map(c => new Option(c.name, c.id)));
          const suggestion = await categoryLearning.suggest({ merchant: statement.merchant, items: [], categories: expenseCategories });
          if (suggestion.merchantCategoryId) category.value = suggestion.merchantCategoryId;
          // The payment source is asked for only here, because a new ledger transaction needs an account.
          const account = document.createElement('select'); account.id = `account-${statement.id}`; account.required = true;
          const accountLabel = fieldLabel('label', '支払元', account.id);
          const fillAccounts = (rows: typeof registrationAccounts, selected: string) => {
            account.replaceChildren(new Option(rows.length ? '支払元を選択してください' : '支払元がありません', ''), ...accountOptions(rows));
            account.value = rows.some(row => row.id === selected) ? selected : '';
          };
          fillAccounts(registrationAccounts, defaultRegistrationAccount(statement));
          body.append(text('p', `記録が見つかりません。${statement.usedDate} · ${statement.merchant} · ${yen(statement.amountYen)} を支出として登録できます。`), categoryLabel, category, accountLabel, account);
          const noAccountNote = text('p', '支払元がありません。登録するには支払元を追加してください。');
          if (!registrationAccounts.length) account.before(noAccountNote);
          account.after(createMasterShortcut({ ledger, request: { kind: 'account' }, origin: {
            field: account, beforeOpen: async () => {}, onCreated: async id => {
              const refreshed = (await ledger.listOpenAccounts()).filter(row => row.accountType !== 'cash');
              fillAccounts(refreshed, refreshed.some(row => row.id === id) ? id : account.value);
              if (refreshed.length) noAccountNote.remove();
            },
          } }));
          category.after(createMasterShortcut({ ledger, request: { kind: 'category', isIncome: false }, origin: {
            field: category, beforeOpen: async () => {}, onCreated: async id => {
              const previous = category.value;
              const refreshed = await ledger.listExpenseCategories();
              category.replaceChildren(new Option('カテゴリを選択してください', ''), ...refreshed.map(c => new Option(c.name, c.id)));
              category.value = refreshed.some(c => c.id === previous) ? previous : id;
            },
          } }));
          body.append(button('支出として登録', async () => {
            if (!category.value) throw new Error('カテゴリを選択してください。');
            if (!account.value) throw new Error('支払元を選択してください。');
            await reconciliation.noReceipt(run.runId, statement.id, { categoryId: category.value, accountId: account.value });
            await rerun();
          }, false));
        }
      }
      item.append(detail); list.append(item);
    }
    ensureScreen(screen);
    if (list.children.length) {
      const section = document.createElement('section'); section.className = 'surface-section review-section';
      section.append(text('h3', '確認してください'), list); view.append(section);
    } else if (!decisions.some(d => d.status !== 'applied')) {
      const clear = document.createElement('p'); clear.className = 'review-clear'; clear.append(icon('check'), document.createTextNode('確認が必要な明細はありません')); view.append(clear);
    }
    if (automatic.length) {
      const history = document.createElement('details'); history.className = 'surface-section review-history';
      history.append(text('summary', `自動で一致した内容を見る（${auto}件）`));
      const matchedList = document.createElement('ul');
      const statementById = new Map(allStatements.map(statement => [statement.id, statement]));
      const receiptById = new Map(allReceipts.map(receipt => [receipt.id, receipt]));
      automatic.sort((a, b) => (statementById.get(b.statementId)?.usedDate ?? b.createdAt).localeCompare(statementById.get(a.statementId)?.usedDate ?? a.createdAt));
      for (const decision of automatic) {
        const statement = statementById.get(decision.statementId), receipt = receiptById.get(decision.receiptId ?? '');
        const item = document.createElement('li'), detail = document.createElement('details');
        detail.append(text('summary', statement ? `${statement.usedDate} · ${statement.merchant} · ${yen(statement.amountYen)}` : `保存済みの照合 · ${yen(decision.statementAmountYen)}`));
        detail.append(text('p', '同じ支出として自動で一致しました。'));
        detail.append(text('p', statement ? `明細：${statement.usedDate}${statement.usedTime ? ` ${statement.usedTime.slice(0, 5)}` : ''} · ${statement.merchant} · ${yen(statement.amountYen)}${statement.paymentMethod ? ` · ${statement.paymentMethod}` : ''}` : '対応する明細を端末で見つけられませんでした。'));
        const value = receipt?.confirmedValue;
        const savedExpense = decision.actualSnapshot;
        detail.append(text('p', value ? `レシート：${value.purchasedDate}${value.purchasedTime ? ` ${value.purchasedTime}` : ''} · ${value.merchant} · ${yen(value.totalAmountYen)}`
          : savedExpense ? `家計簿：${savedExpense.date} · ${savedExpense.payeeName || '店名なし'} · ${yen(Math.abs(savedExpense.amountYen))} · ${accountsById.get(savedExpense.accountId)?.name ?? '保存済みの支払元'}`
          : '対応する支出の詳細を端末で見つけられませんでした。'));
        if (receipt) detail.append(button('レシートを確認する', () => receiptEditor(receipt)));
        item.append(detail); matchedList.append(item);
      }
      history.append(matchedList); view.append(history);
    }
  }
  for (const [tab, render] of [['home', home], ['receipt', recordsPage], ['reconciliation', reviewPage]] as const) el(`${tab}-tab`).addEventListener('click', () => { searchOrigin = false; void render().catch(report); });
  // Settings is shown without open(), so leaving for it ends in-flight renders here.
  el('settings-tab').addEventListener('click', () => { screenRevision++; screenTab = 'settings'; });
  el('add-record').addEventListener('click', () => {
    const active = ['home', 'receipt', 'reconciliation', 'settings'].find(id => el(`${id}-tab`).classList.contains('active'));
    chooserOrigin = active === 'home' ? home : active === 'reconciliation' ? reviewPage : active === 'settings' ? async () => { el('settings-tab').click(); } : recordsPage;
    void recordChooser().catch(report);
  });
  el('home-all-records').addEventListener('click', () => el('receipt-tab').click());
  // A user chooses a budget explicitly when multiple local budgets are available.
  const setup = el('local-settings');
  const closeCategoryRules = initializeCategoryRulesUi({ entryContainer: setup, settingsContent: el('settings-content'), ledger, learning: categoryLearning });
  const sync = new DeviceSyncEngine({ api: new DeviceSyncApi(), secrets: new DeviceSyncSecretStore(), repository, ledger, guard });
  await initializeBackupUi(repository, ledger, () => sync.stopOnThisDevice());
  const syncUi = initializeDeviceSyncUi(el('data-settings'), { engine: sync, guard, reauthenticate: options.reauthenticate,
    // Imports switch households, so they wait while a work screen or a field is in use.
    isEditing: () => !view.hidden || document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement || document.activeElement instanceof HTMLSelectElement });
  el('backup-settings').after(el('device-sync-settings'));
  const ledgerTools = document.createElement('details'); ledgerTools.className = 'surface-section settings-disclosure';
  ledgerTools.append(text('summary', '家計簿の読み込み・切り替え'), el('import-section'), el('budget-section'));
  el('data-settings').append(ledgerTools);
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
  const masterUi = initializeMasterUi(setup, ledger, { onBack: () => { el('message').textContent = ''; }, onTransaction: async row => { const displayed = row.kind === 'transfer' && row.amountYen > 0 && row.transferId ? await ledger.getTransactionById(row.transferId) : row; if (!displayed) throw new Error('取引が見つかりません。'); await transactionDetail(displayed); }, beforeDeleteAccount: id => protectUndoReference(id, 'account'), beforeDeleteCategory: id => protectUndoReference(id, 'category'),
    getStatementProvider: accountId => budgetId ? accountMetadata.getStatementProvider(budgetId, accountId) : Promise.resolve(null),
    setStatementProvider: (accountId, provider, accountType) => budgetId ? accountMetadata.saveStatementProvider(budgetId, accountId, provider, accountType) : Promise.reject(new Error('家計簿を選択してください。')) });
  resetMasterUi = masterUi;
  setup.append(budgetEntry, recurringEntry); // docs/UX.md 設定: カテゴリ, 支払元, 予算, 定期登録
  openAccountBalances = masterUi.openAccounts;
  el('settings-tab').addEventListener('click', () => { searchOrigin = false; closeCategoryRules(); el('message').textContent = ''; resetMasterUi(); const flush = flushReceiptDraft; flushReceiptDraft = () => Promise.resolve(); void flush().catch(report); });
  if (budgetId) {
    await deletions.recoverPending();
    await recurring.retry();
    await ledger.runDueSchedules();
    const latestDeletion = (await deletions.list()).filter(audit => audit.status === 'deleted' && Date.parse(audit.undoUntil) > Date.now()).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (latestDeletion) showDeletionToast(latestDeletion);
    if (!el('household-view').hidden) await home().catch((error: unknown) => { if (!(error instanceof StaleScreenError)) throw error; }); else el('message').textContent = ''; } else el('message').textContent = '使う家計簿を選択してください。';
  // Sync starts after startup work, so its first snapshot includes due schedules.
  await syncUi.refresh();
}
