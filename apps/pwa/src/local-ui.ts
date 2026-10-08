import { initializeMoneyForwardUi } from './moneyforward-ui';
import { createAccountMetadataAccess } from './local-account-metadata';
import { accountOptions } from './local-account-ui';
import { renderMonthlyBudgets, showMonthlyBudgetEditor } from './local-monthly-budgets';
import { LocalMonthlyBudgetService } from './local-monthly-budget-service';
import { LocalRecurringService } from './local-recurring';
import { showRecurringSchedules } from './local-recurring-ui';
import { attachReceiptSearchItems, emptySearchFilters, type TransactionSearchFilters } from './local-transaction-search';
import { showTransactionSearch } from './local-transaction-search-ui';
import { renderCategoryBreakdown, renderMonthlyDashboard, monthEnd, shiftMonth } from './local-monthly-dashboard';
import { renderHomeAttention, type HomeAttentionCounts, type HomeAttentionItem } from './home-attention';
import { daysBetween, reviewSummaryRow, shortDay, slipPart, slipPerforation, slipSeal, updateReconciliationBadge } from './reconciliation-ui';
import { pendingReceiptRow, recordRow } from './record-row';
import { renderRecordGroups, type RecordKindFilter } from './records-list';
import { compactAddButton, dateShortcuts, entryRow, formActions, optionalFields, recurrenceRow, shortLabel } from './entry-form';
import { scheduleFromEntry } from './entry-recurrence';
import { categoryRow, lastUsedCategory, recentCategoryUsage } from './category-picker';
import { icon } from './ui-icons';
import { describeReceiptWarnings, type ReceiptWarningTarget } from './receipt-warnings';
import { createReadingProgress } from './receipt-reading-progress';
import { openReceiptImage } from './receipt-image-viewer';
import { LocalTransactionDeletionService } from './local-transaction-deletions';
import { showManualTransactionEditor } from './local-transaction-ui';
import type { ActualTransaction } from '../../../src/lib/actual-ledger';
import { initializeMasterUi, createMasterShortcut } from './local-master-ui';
import { initializeBackupUi } from './local-backup-ui';
import { initializeDeviceLinkUi } from './device-link-ui';
import { restoreStandaloneBudget, type LocalBudgetSettings } from './local-backup';
import { ActualBudgetSelectionRequiredError, createActualBrowserLedger } from '../../../src/lib/actual-browser-ledger';
import { LocalDataRepository } from '../../../src/lib/local-data';
import { LocalReceiptService, LocalReceiptServiceError, type LocalReceipt, type ReceiptItem, type ReceiptAdjustment } from './local-receipts';
import { LocalStatementService } from './local-statements';
import type { StatementProvider } from './statement-parser';
import { STATEMENT_DOWNLOAD_HELP } from './statement-download-help';
import { LocalReconciliationService } from './local-reconciliation';
import { LocalCategoryLearning } from './local-category-learning';
import { ensureBasicExpenseCategories } from './local-category-defaults';
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
  const node = document.createElement('button'); node.type = 'button'; node.textContent = label; node.className = secondary ? 'secondary' : 'primary';
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

export async function initializeLocalUi(options: { openAccount: () => void }) {
  const repository = await LocalDataRepository.open();
  const saved = await repository.get<LocalBudgetSettings>('settings:budget');
  let budgetId = saved?.value.budgetId ?? null;
  const dataDir = saved?.value.dataDir ?? '/documents';
  let monthlyBudgets: LocalMonthlyBudgetService | null = null;
  const accountMetadata = createAccountMetadataAccess(repository);
  const ledger = createActualBrowserLedger({ ...accountMetadata, getBudgetId: () => budgetId, getDataDir: () => dataDir, saveBudgetId: async id => {
    budgetId = id; await repository.put({ id: 'settings:budget', kind: 'app-settings', value: { budgetId: id, dataDir }, updatedAt: new Date().toISOString() });
    monthlyBudgets = new LocalMonthlyBudgetService(repository, ledger, id);
  } });
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
    deletionToast.replaceChildren();
    if (remaining <= 0) return;
    deletionToast.append(text('span', '削除しました。'));
    const undo = button('元に戻す', async () => { await deletions.undo(audit.operationId); if (toastTimer) clearTimeout(toastTimer); await returnToRecords(); deletionToast.replaceChildren(text('span', '削除を取り消しました。')); });
    deletionToast.append(undo, text('span', '10秒以内なら元に戻せます。'));
    toastTimer = setTimeout(() => { deletionToast.replaceChildren(); toastTimer = null; }, remaining);
  }
  function deleteButton(id: string) {
    const remove = button('削除する', async () => {
      if (!window.confirm('この取引を削除しますか？レシート画像などの原本は残ります。')) return;
      const audit = await deletions.delete(id);
      if (screenTab === 'receipt') await returnToRecords();
      showDeletionToast(audit);
    });
    remove.classList.add('destructive'); remove.prepend(icon('trash')); return remove;
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
    closeMoneyForward();
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
    renderMonthlyBudgets(overview, budgetSummary, () => { void budgetEditor('monthly').catch(report); }, today());
    renderCategoryBreakdown(el('home-categories'), summary);
    const accountNames = new Map(accounts.map(account => [account.id, account.name]));
    const list = el('transactions'); list.replaceChildren();
    for (const row of rows.filter(row => row.kind !== 'transfer' || row.amountYen < 0).slice(0, HOME_RECENT_LIMIT)) {
      const item = document.createElement('li');
      item.append(recordRow(row, accountNames.get(row.accountId) ?? null, () => { void transactionDetail(row).catch(report); }));
      list.append(item);
    }
    if (!rows.length) list.append(text('li', 'まだ記録がありません。', 'empty'));

    const { run, decisions, pending, counts } = await reconciliationState();
    const allStatements = run ? await statements.list() : [];
    ensureScreen(screen);
    renderHomeAttention(el('home-attention'), counts, homeAttentionItems(run, decisions, pending, allStatements),
      decisions.filter(d => d.source === 'automatic' && d.status === 'applied').length, () => reviewPage().catch(report));
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
    const cameraText = document.createElement('span'); cameraText.className = 'choice-primary-text'; cameraText.append(text('strong', 'レシートを撮る'), text('span', '写真を残して、品目まで読み取れます'));
    camera.append(cameraBadge, cameraText, icon('chevronRight'));
    camera.addEventListener('click', () => capture.click());
    const choices = document.createElement('ul'); choices.className = 'choice-list';
    const startEntry = (kind: 'expense' | 'income' | 'transfer') => () => { closeRecordSheet(); return manualEditor(kind); };
    // docs/UX.md ＋追加: four equal tiles under the photo tile. The name stays the button's accessible name.
    for (const [label, hint, symbol, action] of [
      ['写真から', '保存したレシート', 'image', () => library.click()],
      ['支出を手入力', 'レシートなし', 'pencil', startEntry('expense')],
      ['収入', '給与・臨時収入', 'income', startEntry('income')],
      ['口座間の振替', '現金の引き出しなど', 'transfer', startEntry('transfer')],
    ] as const) {
      const item = document.createElement('li');
      const choice = button(label, action); choice.className = 'choice-row'; choice.setAttribute('aria-label', label);
      const words = document.createElement('span'); words.className = 'choice-row-text'; words.append(text('span', label), text('small', hint));
      choice.replaceChildren(icon(symbol), words);
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
      recurringNames: async () => (await ledger.listRecurringSchedules()).map(row => row.name.trim()),
      onSaved: async schedule => {
        ensureTab('receipt'); if (transaction) await transactionDetail(transaction); else await returnToRecords();
        el('message').textContent = transaction ? '変更を保存しました。' : '登録しました。';
        if (schedule) el('message').textContent = await saveScheduleAfterEntry(schedule);
      },
      onCancel: transaction ? () => transactionDetail(transaction) : newEntryReturn });
  }
  /** The record is already saved; a failed schedule is reported without hiding that. */
  async function saveScheduleAfterEntry(schedule: NonNullable<ReturnType<typeof scheduleFromEntry>>) {
    try {
      await recurring.save(schedule);
      return `登録しました。${schedule.startDate}から定期登録も作りました。`;
    } catch (error) {
      return `登録しました。定期登録は作れませんでした（${error instanceof Error ? error.message : '原因を確認できませんでした。'}）。設定の「定期登録」から作ってください。`;
    }
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
    const groups = document.createElement('div'); groups.className = 'record-groups'; groups.setAttribute('aria-busy', 'true');
    const empty = text('p', '', 'empty'); empty.hidden = true;
    view.append(header, filters, accountsLink, groups, empty);
    for (const [value, label] of [['all', 'すべて'], ['expense', '支出'], ['income', '収入'], ['transfer', '振替']] as const) {
      const option = document.createElement('button'); option.type = 'button'; option.textContent = label; option.dataset.filter = value; option.disabled = true;
      filters.append(option);
    }
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
      view.insertBefore(section, groups);
    }
    empty.textContent = 'まだ記録がありません。';
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
      groups.setAttribute('aria-busy', 'false');
      empty.hidden = shown > 0 || (recordsFilter === 'all' && pending.length > 0);
      empty.textContent = recordsFilter === 'all' ? 'まだ記録がありません。' : 'この種類の記録はありません。';
      filters.querySelectorAll('button').forEach(option => option.setAttribute('aria-pressed', String(option.dataset.filter === recordsFilter)));
    };
    filters.querySelectorAll<HTMLButtonElement>('button').forEach(option => {
      option.addEventListener('click', () => { recordsFilter = option.dataset.filter as RecordKindFilter; render(); });
      option.disabled = false;
    });
    render();
  }
  /** 記録の詳細の行（項目名を左、値を右）。先頭の行は金額として大きく出す。docs/UX.md 記録の詳細。 */
  function recordDetailRows(rows: Array<[string, string | HTMLElement]>) {
    const detail = document.createElement('dl'); detail.className = 'transaction-detail surface-section';
    for (const [index, [label, value]] of rows.entries()) {
      const group = document.createElement('div'); group.className = index === 0 ? 'detail-amount' : 'detail-row';
      const definition = text('dd', typeof value === 'string' ? value : ''); if (typeof value !== 'string') definition.append(value);
      group.append(text('dt', label), definition); detail.append(group);
    }
    return detail;
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
    const values: Array<[string, string | HTMLElement]> = current.kind === 'transfer' ? [
      ['金額', yen(current.amountYen)], ['日付', current.date],
      ['振替元口座', accounts.find(account => account.id === current.accountId)?.name || '利用不可'],
      ['振替先口座', accounts.find(account => account.id === current.transferAccountId)?.name || '利用不可'],
      ['メモ', current.memo || 'なし'],
    ] : [['金額', yen(current.amountYen)], ['日付', current.date], [current.kind === 'income' ? '入金元・内容' : '店名・支払先', current.payeeName || '未設定'], ['カテゴリ', current.categoryName || '未設定'], [current.kind === 'income' ? '入金先口座' : '支払元', accounts.find(account => account.id === current.accountId)?.name || '利用不可'], ['メモ', current.memo || 'なし']];
    view.append(recordDetailRows(values));
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
    const registered = text('span', '家計簿へ登録済みです。', 'registered-note'); registered.prepend(icon('check'));
    const summary = recordDetailRows([
      ['金額', yen(value.totalAmountYen)],
      [value.purchasedTime ? '日時' : '日付', `${value.purchasedDate}${value.purchasedTime ? ` ${value.purchasedTime}` : ''}`],
      ['店名・支払先', value.merchant],
      ['カテゴリ', categoryName(value.categoryId)],
      ['支払元', accounts.find(account => account.id === value.accountId)?.name ?? '利用不可'],
      ['メモ', value.memo || 'なし'],
      ['状態', registered],
    ]);
    view.append(back, text('h2', '支出の記録'), summary);
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
    // docs/UX.md 支出の入力: a new expense typed by hand starts with the category used last time.
    const lastUsed = !receipt.image && !editing && !initial.categoryId
      ? await lastUsedCategory(ledger, 'expense', categories.map(entry => entry.id)).catch(() => '') : '';
    if (lastUsed) initial.categoryId = lastUsed;
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
    // The frame carries the reading motion over the photo while AI reads it.
    const previewFrame = document.createElement('div'); previewFrame.className = 'receipt-preview-frame';
    if (blob) {
      imageUrl = URL.createObjectURL(blob.blob); const src = imageUrl;
      const img = document.createElement('img'); img.src = src; img.alt = '保存したレシート'; img.className = 'receipt-preview';
      // The photo opens full screen, so the printed total can be checked up close.
      const open = document.createElement('button'); open.type = 'button'; open.className = 'receipt-preview-open'; open.setAttribute('aria-label', 'レシート画像を拡大して見る');
      const badge = document.createElement('span'); badge.className = 'receipt-preview-zoom'; badge.append(icon('search'));
      open.append(img, badge); open.addEventListener('click', () => openReceiptImage(src));
      previewFrame.append(open); overviewExtras.append(previewFrame);
    }
    // Read warnings say where to compare with the image; they are drawn once the fields exist.
    const reviewedWarnings = new Set(receipt.reviewedWarnings ?? []);
    const reviewWarnings = (receipt.extraction ? describeReceiptWarnings(receipt.extraction) : [])
      .map((review, warningIndex) => ({ ...review, warningIndex })).filter(review => !reviewedWarnings.has(review.warningIndex));
    const reviewArea = document.createElement('div');
    overviewExtras.append(reviewArea);
    const entryId = (target: ReceiptWarningTarget) => target.kind === 'item' && target.index !== null ? `receipt-item:${receipt.id}:${target.index}`
      : target.kind === 'adjustment' && target.index !== null ? `receipt-adjustment:${receipt.id}:${target.index}` : null;
    const flaggedEntryIds = new Set(reviewWarnings.flatMap(({ target }) => entryId(target) ?? []));

    const form = document.createElement('form');
    const inputId = (field: string) => !receipt.image ? `manual-transaction-${field === 'merchant' ? 'payee' : field}` : `receipt-${field}`;
    const merchant = document.createElement('input'); merchant.id = inputId('merchant'); merchant.required = true; merchant.maxLength = 200; merchant.value = initial.merchant;
    const date = document.createElement('input'); date.id = inputId('date'); date.type = 'date'; date.required = true; date.value = initial.purchasedDate;
    const time = document.createElement('input'); time.id = 'receipt-time'; time.type = 'time'; time.value = initial.purchasedTime ?? '';
    const amount = document.createElement('input'); amount.id = inputId('amount'); amount.type = 'number'; amount.inputMode = 'numeric'; amount.min = receipt.image ? '0' : '1'; amount.step = '1'; amount.required = true;
    // A receipt paid entirely with points has a 0 yen total; an empty manual entry stays blank.
    const zeroTotal = Boolean(receipt.image) && initial.totalAmountYen === 0 && (extraction?.totalAmountYen === 0 || confirmed?.totalAmountYen === 0);
    amount.value = initial.totalAmountYen || zeroTotal ? String(initial.totalAmountYen) : '';
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
    // When items and adjustments add up to the total, only the total needs comparing with the photo.
    const totalCheck = text('span', '', 'receipt-total-check'); totalCheck.id = 'receipt-total-check'; totalCheck.setAttribute('aria-live', 'polite');
    const status = text('p', '', 'status'); status.id = 'receipt-save-state'; status.setAttribute('role', 'status');
    let expandItemId: string | null = null;
    let expandAdjustmentId: string | null = null;
    const addItem = button('品目を追加', () => { items = readItems(); expandItemId = crypto.randomUUID(); items.push({ id: expandItemId, name: '', amountYen: null, categoryId: null }); drawItems(); updateAdjustmentTargets(); updateDifference(); scheduleDraft(); }); addItem.prepend(icon('add'));
    const addAdjustment = button('値引きを追加', () => { adjustments = readAdjustments(); expandAdjustmentId = crypto.randomUUID(); adjustments.push({ id: expandAdjustmentId, label: '', amountYen: 0, targetItemId: null }); drawAdjustments(); updateDifference(); scheduleDraft(); }); addAdjustment.prepend(icon('add'));
    // Chooses one category in the sheet and gives it to every item.
    let applyToAllItems = false;
    const applyCategory = button('全品目を同じカテゴリにする', () => { applyToAllItems = true; categoryUi.open(); });
    const taxDetails = document.createElement('details'); taxDetails.className = 'receipt-tax';
    const taxLabel = fieldLabel('label', '税額（円・任意）', 'receipt-tax');
    const tax = document.createElement('input'); tax.id = 'receipt-tax'; tax.type = 'number'; tax.inputMode = 'numeric'; tax.min = '0'; tax.step = '1'; tax.value = initial.taxAmountYen == null ? '' : String(initial.taxAmountYen);
    taxDetails.append(text('summary', '税額（任意）'), taxLabel, tax);
    const memoLabel = fieldLabel('label', 'メモ（任意）', inputId('memo'));
    const memo = document.createElement('textarea'); memo.id = memoLabel.htmlFor; memo.maxLength = 2000; memo.value = initial.memo ?? '';
    const aiArea = document.createElement('div'); aiArea.className = 'receipt-ai-area';
    aiArea.append(text('p', '画像から店名・日付・金額・品目を読み取り、カテゴリを設定します。', 'muted'));
    // docs/UX.md 読み取り中: the steps as rows, a band moving over the photo, and a way to stop waiting.
    const readingBadge = text('span', '読み取り中', 'reading-badge'); readingBadge.hidden = true; previewFrame.append(readingBadge);
    const failure = document.createElement('div'); failure.className = 'reading-failure'; failure.hidden = true;
    // Failed reads worth trying again with the same photo; quota, sign-in and image limits are not.
    const retryable = (error: unknown) => !(error instanceof LocalReceiptServiceError) || (!error.retryAfterWait && ['offline_or_unavailable', 'invalid_ai_response', 'unavailable'].includes(error.code));
    const retake = document.createElement('input'); retake.type = 'file'; retake.accept = 'image/jpeg,image/png,image/webp'; retake.setAttribute('capture', 'environment'); retake.hidden = true;
    retake.addEventListener('change', () => {
      const file = retake.files?.[0]; if (!file) return;
      void (async () => {
        const replacement = await receipts.saveImage(file);
        // The new photo replaces this one; the old pending receipt goes away so it is not left waiting.
        await receipts.deletePending(receipt.id);
        await receiptEditor(replacement);
      })().catch(report);
    });
    const readPhoto = async () => {
      if (receipt.extraction && !window.confirm('もう一度読み取るとAIの利用枠を消費し、入力内容を読み取り結果で置き換えます。続けますか？')) return;
      if (receipt.registration.status === 'applied') return;
      recordDiagnosticAction('receipt_ai_started', 'records');
      await saveDraft();
      failure.hidden = true; failure.replaceChildren();
      // AI never fills the payment source, so it stays selectable while the read runs.
      const controls = form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement | HTMLTextAreaElement>('input,select,textarea,button');
      const waitButton = button('待たずに手で入力する', () => stopWaiting()); waitButton.className = 'text-button';
      controls.forEach(control => { control.disabled = control !== account; });
      const aiFilled = [amount, merchant, date];
      aiFilled.forEach(field => field.classList.add('ai-pending'));
      previewFrame.classList.add('is-reading'); readingBadge.hidden = false;
      aiButton.hidden = true;
      const progress = createReadingProgress();
      aiArea.append(progress.element);
      const submitLabel = submit.textContent;
      submit.textContent = '読み取り中…'; submit.hidden = false;
      submit.after(waitButton);
      let abandoned = false;
      let stage: 'reading' | 'categorizing' = 'reading';
      const finish = (keepProgress = false) => {
        if (!keepProgress) progress.stop();
        waitButton.remove();
        aiButton.hidden = false;
        previewFrame.classList.remove('is-reading'); readingBadge.hidden = true;
        aiFilled.forEach(field => field.classList.remove('ai-pending'));
        controls.forEach(control => { control.disabled = false; });
        submit.textContent = submitLabel;
      };
      const stopWaiting = async () => {
        abandoned = true; finish();
        if (stage === 'categorizing') {
          // The text is already read: show it and let the categories be chosen by hand.
          const updated = await receipts.get(receipt.id);
          if (updated && form.isConnected) await receiptEditor(updated, { useExtraction: true, preserveAccountId: account.value });
          el('message').textContent = '読み取った内容を表示しました。カテゴリは自分で選べます。';
        } else el('message').textContent = '読み取りを待たずに入力できます。読み取りが終わっても、入力した内容はそのままです。';
      };
      try {
        await receipts.analyze(receipt.id);
        if (abandoned) return;
        stage = 'categorizing'; progress.setStep('categorizing');
        submit.textContent = '分類を待っています…'; waitButton.textContent = '分類を待たずに自分で選ぶ';
        try {
          const suggested = await receipts.suggestCategory(receipt.id);
          recordLocalDiagnostic('ai');
          if (abandoned) return;
          const updated = await receipts.get(receipt.id);
          if (updated && form.isConnected) await receiptEditor(updated, { useExtraction: true, preserveAccountId: account.value });
          if (updated?.aiSuggestion.source === 'learned_rule') el('message').textContent = 'いつもの分類を適用しました。';
          if (suggested === null && updated?.extraction?.items.length === 0) el('message').textContent = 'カテゴリを選択してください。';
        } catch (error) {
          if (abandoned) return;
          report(error);
          const updated = await receipts.get(receipt.id);
          if (updated && form.isConnected) await receiptEditor(updated, { useExtraction: true, preserveAccountId: account.value });
          el('message').textContent = `${error instanceof Error ? error.message : 'カテゴリを提案できませんでした。'} 読み取った内容は編集できます。`;
        }
        if (!abandoned) finish();
      } catch (error) {
        if (abandoned) return;
        report(error);
        finish(true); progress.fail(); aiButton.hidden = true;
        // docs/UX.md 読み取り中: say what failed and what to do next; try again first when it may work.
        const retakeButton = button('撮り直す', () => retake.click()); retakeButton.prepend(icon('camera'));
        failure.append(text('p', '! 写真から読み取れませんでした', 'reading-failure-title'), text('p', 'ぼやけや反射があれば撮り直してください。'), retakeButton);
        if (error instanceof Error && /アカウント|ログイン|認証|サインイン/.test(error.message)) failure.append(button('アカウントを確認する', options.openAccount));
        failure.hidden = false;
        if (retryable(error)) {
          const retry = button('もう一度読み取る', async () => { clearFailure(); await readPhoto(); }, false);
          const manual = button('手で入力して続ける', () => clearFailure()); manual.className = 'text-button';
          const clearFailure = () => { retry.remove(); manual.remove(); submit.hidden = false; failure.hidden = true; failure.replaceChildren(); progress.stop(); aiButton.hidden = false; };
          submit.hidden = true; submit.after(retry, manual);
        } else {
          const close = () => { failure.hidden = true; failure.replaceChildren(); progress.stop(); aiButton.hidden = false; };
          const manual = button('手で入力して続ける', close); manual.className = 'text-button'; failure.append(manual);
        }
      }
    };
    const aiButton = button(receipt.extraction ? '再読み取り' : 'AIで読み取る', readPhoto);
    if (blob && !editing) { aiArea.append(aiButton, failure, retake); overviewExtras.append(aiArea); }
    if (editing) aiArea.replaceChildren();
    const merchantLabel = shortLabel(merchant.id, '店名', receipt.image ? '' : '・支払先');
    const dateLabel = shortLabel(date.id, '日付');
    const timeLabel = fieldLabel('label', '時刻（任意）', time.id);
    const amountLabel = shortLabel(amount.id, '金額', '（円）');
    const categoryLabel = shortLabel(category.id, 'カテゴリ');
    const accountLabel = shortLabel(account.id, '支払元');
    const purchaseDetails = document.createElement('details'); purchaseDetails.className = 'purchase-details';
    purchaseDetails.open = Boolean(receipt.image) || items.length > 0 || adjustments.length > 0;
    const purchaseSummary = document.createElement('summary');
    const purchaseHint = text('span', '', 'entry-row-hint');
    // docs/UX.md 支出の入力: items live only in the item list (#194); in the overview this row leads there.
    const itemsEntry = document.createElement('button'); itemsEntry.type = 'button'; itemsEntry.className = 'entry-row entry-row-link';
    const itemsEntryHint = text('span', '', 'entry-row-hint');
    itemsEntry.append(text('span', '品目', 'entry-row-key'), itemsEntryHint, icon('chevronRight'));
    itemsEntry.addEventListener('click', () => setEditorPane('items'));
    purchaseSummary.append(text('span', '品目', 'entry-row-key'), purchaseHint);
    purchaseDetails.append(purchaseSummary, applyCategory, itemsHeading, itemsList, addItem, adjustmentsHeading, adjustmentsList, addAdjustment, taxDetails);
    amount.classList.add('amount-input');
    const optional = optionalFields('時刻・メモ', [timeLabel, time, memoLabel, memo], Boolean(time.value || memo.value));
    // docs/DESIGN.md 帳簿の行で組む入力: one ruled row per field.
    const categoryUi = categoryRow({ select: category, label: categoryLabel, usageReady: recentCategoryUsage(ledger),
      hint: lastUsed ? { value: lastUsed, text: '前回と同じ' } : receipt.aiSuggestion.source === 'learned_rule' && category.value ? { value: category.value, text: 'いつもの分類' } : null });
    // With items, the category comes from them: the row shows the split and leads to the item list.
    // The category chosen in the sheet then only fills items that have none.
    const derivedValue = document.createElement('button'); derivedValue.type = 'button'; derivedValue.className = 'derived-category';
    derivedValue.addEventListener('click', () => setEditorPane('items'));
    categoryUi.row.querySelector('.entry-row-value')?.append(derivedValue);
    const overviewFields = document.createElement('div'); overviewFields.className = 'entry-overview-fields entry-rows';
    overviewFields.append(entryRow(amountLabel, amount, totalCheck), entryRow(merchantLabel, merchant), entryRow(dateLabel, date, dateShortcuts(date, today())),
      categoryUi.row, entryRow(accountLabel, account), optional, itemsEntry);
    // A new expense typed by hand can repeat (rent, subscriptions). Receipts and edits stay single records.
    const recurrence = !receipt.image && !editing ? recurrenceRow('manual-transaction-recurrence') : null;
    if (recurrence) overviewFields.append(recurrence.row);
    form.append(overviewFields, purchaseDetails, warning, status);
    const reviewFields = { merchant: [merchantLabel, merchant], purchasedDate: [dateLabel, date], purchasedTime: [timeLabel, time], totalAmountYen: [amountLabel, amount], taxAmountYen: [taxLabel, tax] } as const;
    const fieldFlags = new Map<keyof typeof reviewFields, HTMLElement>();
    for (const field of new Set(reviewWarnings.flatMap(({ target }) => target.kind === 'field' ? [target.field] : []))) {
      const [label, input] = reviewFields[field];
      // "写真と確認" (compare with the photo) is a different thing from the total's "差額あり".
      const flag = text('span', '△ 写真と確認', 'review-flag'); flag.id = `${input.id}-review`;
      // In a ledger row the mark goes to the right column, so the three columns stay aligned.
      const row = label.closest('.entry-row');
      if (row) {
        let side = row.querySelector<HTMLElement>(':scope > .entry-row-side');
        if (!side) { side = document.createElement('div'); side.className = 'entry-row-side'; row.append(side); }
        side.prepend(flag);
      } else label.after(flag);
      input.setAttribute('aria-describedby', flag.id);
      fieldFlags.set(field, flag);
      if (field === 'purchasedTime') optional.open = true;
      if (field === 'taxAmountYen') taxDetails.open = true;
      // Editing the field is itself a check against the image.
      input.addEventListener('input', () => { void resolveReviews(review => review.target.kind === 'field' && review.target.field === field).catch(report); }, { once: true });
    }
    for (const list of [itemsList, adjustmentsList]) list.addEventListener('input', event => {
      const entry = (event.target as HTMLElement).closest<HTMLElement>('[data-receipt-item],[data-receipt-adjustment]');
      const id = entry?.dataset.receiptItem ?? entry?.dataset.receiptAdjustment;
      if (id && flaggedEntryIds.has(id)) void resolveReviews(review => entryId(review.target) === id).catch(report);
    });
    const reviewBand = document.createElement('section'); reviewBand.className = 'notice notice-warning receipt-review';
    const reviewTitle = text('p', '', 'receipt-review-title'); reviewTitle.id = 'receipt-review-title';
    reviewBand.setAttribute('aria-labelledby', reviewTitle.id);
    const reviewList = document.createElement('ul'); reviewList.className = 'receipt-review-list';
    const reviewRows = new Map<number, HTMLLIElement>();
    for (const review of reviewWarnings) {
      const row = document.createElement('button'); row.type = 'button'; row.className = 'text-button receipt-review-row';
      const body = document.createElement('span'); body.className = 'receipt-review-text';
      body.append(text('strong', review.label), text('span', review.message));
      row.append(body, icon('chevronRight'));
      row.addEventListener('click', () => showReviewTarget(review.target));
      const done = button('確認した', () => resolveReviews(other => other.warningIndex === review.warningIndex));
      done.className = 'text-button receipt-review-done'; done.setAttribute('aria-label', `${review.label}を確認した`);
      const item = document.createElement('li'); item.append(row, done); reviewList.append(item);
      reviewRows.set(review.warningIndex, item);
    }
    reviewBand.append(icon('warning'), reviewTitle, reviewList);
    const refreshReviewBand = () => {
      reviewTitle.textContent = `画像と照らし合わせてほしいところが${reviewRows.size}件あります`;
      if (!reviewRows.size) reviewBand.remove();
    };
    if (reviewWarnings.length) { refreshReviewBand(); reviewArea.append(reviewBand); }
    /** Hides checked warnings now and remembers them for this read. */
    async function resolveReviews(matches: (review: typeof reviewWarnings[number]) => boolean) {
      const resolved = reviewWarnings.filter(review => reviewRows.has(review.warningIndex) && matches(review));
      if (!resolved.length) return;
      for (const review of resolved) {
        reviewRows.get(review.warningIndex)?.remove(); reviewRows.delete(review.warningIndex);
        const id = entryId(review.target);
        if (id && !reviewWarnings.some(other => reviewRows.has(other.warningIndex) && entryId(other.target) === id)) {
          flaggedEntryIds.delete(id);
          (itemsList.querySelector(`[data-receipt-item="${CSS.escape(id)}"]`) ?? adjustmentsList.querySelector(`[data-receipt-adjustment="${CSS.escape(id)}"]`))?.querySelector('.receipt-review-note')?.remove();
        }
        if (review.target.kind === 'field') {
          const field = review.target.field;
          if (!reviewWarnings.some(other => reviewRows.has(other.warningIndex) && other.target.kind === 'field' && other.target.field === field)) {
            fieldFlags.get(field)?.remove(); reviewFields[field][1].removeAttribute('aria-describedby');
          }
        }
      }
      refreshReviewBand();
      await receipts.markWarningsReviewed(receipt.id, resolved.map(review => review.warningIndex));
    }
    /** Moves to the place a read warning is about, so the user can compare it with the image. */
    function showReviewTarget(target: ReceiptWarningTarget) {
      if (target.kind === 'image') {
        setEditorPane('overview', false);
        overviewExtras.querySelector('img')?.scrollIntoView({ block: 'center' });
        return;
      }
      if (target.kind === 'field') {
        setEditorPane('overview', false);
        if (target.field === 'taxAmountYen') { purchaseDetails.open = true; taxDetails.open = true; }
        if (target.field === 'purchasedTime') optional.open = true;
        const input = reviewFields[target.field][1];
        input.scrollIntoView({ block: 'center' }); input.focus({ preventScroll: true });
        return;
      }
      setEditorPane('items', false);
      const list = target.kind === 'item' ? itemsList : adjustmentsList;
      const id = `${target.kind === 'item' ? 'receipt-item' : 'receipt-adjustment'}:${receipt.id}:${target.index}`;
      const entry = target.index === null ? null : list.querySelector<HTMLElement>(`[data-receipt-${target.kind}="${CSS.escape(id)}"]`);
      const details = entry instanceof HTMLDetailsElement ? entry : entry?.querySelector('details');
      if (!details) { (target.kind === 'item' ? itemsHeading : adjustmentsHeading).scrollIntoView({ block: 'start' }); return; }
      details.open = true;
      details.scrollIntoView({ block: 'center' });
      details.querySelector<HTMLElement>('input')?.focus({ preventScroll: true });
    }
    view.append(form);
    const setEditorPane = (pane: 'overview' | 'items', scroll = true) => {
      const itemsOnly = pane === 'items';
      overviewTab.setAttribute('aria-pressed', String(!itemsOnly));
      itemsTab.setAttribute('aria-pressed', String(itemsOnly));
      overviewExtras.hidden = itemsOnly;
      overviewFields.hidden = itemsOnly;
      // Keep the overview focused on the fields needed to confirm and register.
      // Item-level details, discounts, tax and item-total differences belong only to the items pane.
      purchaseDetails.hidden = !itemsOnly;
      warning.hidden = !itemsOnly;
      if (recurrence) recurrence.row.hidden = itemsOnly;
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
            select.replaceChildren(new Option(select === category ? '選択してください' : '未選択', ''), ...categories.map(entry => new Option(entry.name, entry.id)));
            if (previous && !categories.some(entry => entry.id === previous)) select.append(new Option('カテゴリを選び直してください（利用不可）', previous));
            select.value = previous;
          }
          field.value = id;
          field.dispatchEvent(new Event('input', { bubbles: true }));
          await saveDraft();
        },
      } });
    }
    categoryUi.sheet.querySelector('.sheet-body')?.append(addCategoryShortcut(category));
    // The item list hides the overview rows; the sheet stays outside them so "全品目を同じカテゴリにする" can still open it.
    form.append(categoryUi.sheet);
    category.addEventListener('change', () => {
      if (!applyToAllItems) return;
      applyToAllItems = false;
      items = readItems().map(item => ({ ...item, categoryId: category.value || null })); drawItems(); updateAdjustmentTargets(); updateDifference(); scheduleDraft();
    });
    categoryUi.sheet.addEventListener('close', () => { applyToAllItems = false; });
    account.after(compactAddButton(createMasterShortcut({ ledger, request: { kind: 'account' }, origin: {
      field: account, beforeOpen: saveDraft,
      onCreated: async id => {
        accounts = await ledger.listOpenAccounts();
        account.replaceChildren(new Option('選択してください', ''), ...accountOptions(accounts));
        account.value = id; await saveDraft();
      },
    } })));

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
    /** docs/UX.md 支出の入力: with items, the category row shows the split instead of asking for one category. */
    function updateCategoryMode() {
      const currentItems = readItems(); const currentAdjustments = readAdjustments();
      const split = currentItems.length > 0;
      categoryUi.row.classList.toggle('is-split', split); derivedValue.hidden = !split;
      itemsEntryHint.textContent = purchaseHint.textContent = split ? `${currentItems.length}品目${currentAdjustments.length ? ` · 値引き・調整${currentAdjustments.length}` : ''}` : '分けない（品目・値引き・税額）';
      if (!split) return;
      const totals = new Map<string, number>();
      for (const item of currentItems) { const key = item.categoryId || category.value || ''; totals.set(key, (totals.get(key) ?? 0) + (item.amountYen ?? 0)); }
      const parts = [...totals].sort((a, b) => b[1] - a[1]);
      derivedValue.replaceChildren(text('span', '品目ごと', 'derived-tag'),
        ...parts.map(([id, total]) => text('span', `${id ? categoryName(id) : '未選択'} ${yen(total)}`, `derived-part${id ? '' : ' is-empty'}`)));
      derivedValue.setAttribute('aria-label', `カテゴリは品目ごと：${parts.map(([id, total]) => `${id ? categoryName(id) : '未選択'} ${yen(total)}`).join('、')}。品目一覧で見る`);
    }
    function updateDifference() {
      updateCategoryMode();
      const currentItems = readItems(); const currentAdjustments = readAdjustments();
      if (!currentItems.length || currentItems.some(item => item.amountYen == null) || !amount.value) { warning.textContent = ''; totalCheck.textContent = ''; totalCheck.removeAttribute('aria-label'); totalCheck.className = 'receipt-total-check'; return; }
      const knownTotal = currentItems.reduce((sum, item) => sum + (item.amountYen ?? 0), 0) + currentAdjustments.reduce((sum, item) => sum + item.amountYen, 0);
      const difference = Number(amount.value) - knownTotal;
      // docs/UX.md レシートの場合: items on a tax-exclusive receipt add up to the total only with the tax.
      const taxYen = parseNullableInteger(tax.value);
      const taxMatch = difference !== 0 && taxYen != null && taxYen > 0 && difference === taxYen;
      const match = difference === 0 || taxMatch;
      // docs/UX.md レシートの場合: only a short mark beside the total; the full sentence is its accessible name.
      totalCheck.className = `receipt-total-check ${match ? 'is-match' : 'is-mismatch'}`;
      // "差額あり" keeps this apart from "写真と確認", the mark for fields AI was unsure of.
      totalCheck.textContent = match ? '✓ 一致' : '△ 差額あり';
      totalCheck.setAttribute('aria-label', taxMatch ? '品目と値引きと税額の合計と一致' : match ? '品目と値引きの合計と一致' : `品目と値引きの合計と${yen(Math.abs(difference))}違います`);
      warning.textContent = match ? '' : `購入内容との差額は${difference < 0 ? '−' : '+'}${yen(difference)}です。入力した合計金額を保ちます。値引きや税額を確認してください${taxYen ? `（税額${yen(taxYen)}を足しても合いません）` : ''}。`;
    }
    /** docs/DESIGN.md 品目の行: a line the photo should confirm shows a small note under its name. */
    function nameWithReviewNote(name: HTMLElement, flagged: boolean) {
      const wrap = text('span', '', 'receipt-compact-name'); wrap.append(name);
      if (flagged) wrap.append(text('small', '△ 写真と確認', 'receipt-review-note'));
      return wrap;
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
        summary.append(nameWithReviewNote(summaryTitle, flaggedEntryIds.has(item.id)), summaryAmount, summaryMeta);
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
        itemCategory.replaceChildren(new Option('未選択', ''), ...categories.map(entry => new Option(entry.name, entry.id)));
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
        remove.classList.add('destructive'); remove.prepend(icon('trash'));
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
        summary.append(nameWithReviewNote(summaryTitle, flaggedEntryIds.has(adjustment.id)), summaryAmount, summaryMeta);
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
        const remove = button('値引きを削除', () => { adjustments = readAdjustments().filter(entry => entry.id !== adjustment.id); drawAdjustments(); updateDifference(); scheduleDraft(); }); remove.prepend(icon('trash'));
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
    const submit = document.createElement('button'); submit.type = 'submit'; submit.className = 'primary';
    submit.textContent = editing ? pendingEdit ? '同じ内容で再試行する' : '変更を保存する' : receipt.registration.status === 'failed' ? '登録を再試行する' : '登録する';
    form.append(formActions(submit));
    form.addEventListener('submit', event => {
      event.preventDefault();
      void busy(submit, async () => {
        if (draftTimer) clearTimeout(draftTimer);
        const value = pendingEdit?.after ?? read();
        // With items, the record's category is the first item's; items without one need a choice first.
        if (!pendingEdit && value.items?.length) {
          if (!value.categoryId && value.items.some(item => !item.categoryId)) { setEditorPane('items', false); throw new Error('品目のカテゴリを選んでください。'); }
          if (!value.categoryId) { value.categoryId = value.items.find(item => item.categoryId)?.categoryId ?? ''; category.value = value.categoryId; }
        }
        // A photographed receipt paid entirely with points may total 0 yen; a typed expense needs 1 yen or more.
        const missingTotal = pendingEdit ? !receipt.image && !value.totalAmountYen : amount.value.trim() === '' || (!receipt.image && !value.totalAmountYen);
        if (!value.merchant.trim() || !value.purchasedDate || missingTotal || !value.categoryId || !value.accountId) {
          setEditorPane('overview', false);
          if (!value.categoryId) categoryUi.row.querySelector<HTMLButtonElement>('.entry-row-more')?.focus();
          throw new Error('店名、日付、金額、カテゴリ、支払元を確認してください。');
        }
        if (value.items?.some(item => !item.name.trim()) || value.adjustments?.some(item => !item.label.trim())) throw new Error('品目名と値引き・調整の内容を入力してください。');
        const frequency = recurrence?.value() ?? '';
        const schedule = frequency ? scheduleFromEntry({ name: value.merchant, kind: 'expense', amountYen: value.totalAmountYen, categoryId: value.categoryId, accountId: value.accountId, date: value.purchasedDate }, frequency) : null;
        if (schedule && (await ledger.listRecurringSchedules()).some(row => row.name.trim() === schedule.name)) throw new Error('同じ名前の定期登録があります。店名を変えるか、「くり返し」を「しない」にしてください。');
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
        if (schedule) el('message').textContent = await saveScheduleAfterEntry(schedule);
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
    provider.append(new Option('PayPayカード', 'paypay_card'), new Option('三井住友カード', 'smbc_card'), new Option('楽天カード', 'rakuten_card'), new Option('イオンカード', 'aeon_card'));
    provider.value = selectedStatementProvider;
    const downloadHelp = document.createElement('div'); downloadHelp.className = 'statement-download';
    const downloadLink = document.createElement('a'); downloadLink.id = 'statement-download-link';
    downloadLink.textContent = '公式サイトで明細CSVを取得 ↗'; downloadLink.target = '_blank';
    downloadLink.rel = 'noopener noreferrer'; downloadLink.referrerPolicy = 'no-referrer';
    const downloadNote = text('p', ''); downloadNote.id = 'statement-download-note';
    downloadHelp.append(text('p', 'CSVをお持ちでない場合'), downloadLink, downloadNote);
    const importAvailability = text('p', ''); importAvailability.id = 'statement-import-availability';
    importAvailability.setAttribute('role', 'status');
    const fileLabel = fieldLabel('label', 'CSVファイル', 'statement-file');
    const file = document.createElement('input'); file.id = 'statement-file'; file.type = 'file'; file.accept = '.csv,text/csv';
    const submit = button('取り込んで照合', async () => {
      const chosenProvider = provider.value as StatementProvider;
      if (!STATEMENT_DOWNLOAD_HELP[chosenProvider]?.importAvailable) throw new Error('この明細サービスのCSVは現在取り込めません。');
      const selectedFile = file.files?.[0];
      if (!selectedFile) throw new Error('CSVファイルを選択してください。');
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
        provider.disabled = false; updateDownloadHelp();
      }
    }, false);
    function updateDownloadHelp() {
      const help = STATEMENT_DOWNLOAD_HELP[provider.value as StatementProvider];
      downloadHelp.hidden = !help;
      if (help) { downloadLink.href = help.downloadUrl; downloadNote.textContent = help.note; }
      else downloadLink.removeAttribute('href');
      file.disabled = submit.disabled = !help?.importAvailable;
      importAvailability.hidden = help?.importAvailable === true;
      importAvailability.textContent = provider.value === 'aeon_card'
        ? 'イオンカードのCSV形式を確認中です。現在、KakeiMatchへの取り込みには対応していません。'
        : '明細サービスを選択してください。';
    }
    provider.addEventListener('change', () => { selectedStatementProvider = provider.value as StatementProvider; updateDownloadHelp(); });
    updateDownloadHelp();
    section.append(providerLabel, provider, downloadHelp, importAvailability, fileLabel, file, submit);

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
  /** docs/UX.md ホーム: failed decisions first, then statements to review, then ones without a record. */
  function homeAttentionItems(run: Awaited<ReturnType<typeof reconciliationState>>['run'], decisions: Awaited<ReturnType<typeof reconciliationState>>['decisions'],
    pending: Awaited<ReturnType<typeof reconciliationState>>['pending'], allStatements: Awaited<ReturnType<typeof statements.list>>): HomeAttentionItem[] {
    if (!run) return [];
    const byId = new Map(allStatements.map(statement => [statement.id, statement]));
    const items: HomeAttentionItem[] = [];
    for (const decision of decisions.filter(d => d.status !== 'applied')) {
      const statement = byId.get(decision.statementId);
      items.push({ merchant: statement?.merchant ?? '保存済みの照合', amountYen: statement?.amountYen ?? decision.statementAmountYen, tone: 'danger', reason: '反映できませんでした' });
    }
    for (const row of pending.filter(r => r.status === 'needs_review')) {
      const statement = byId.get(row.statementTransactionId); if (!statement) continue;
      const candidates = run.candidates.filter(c => c.statementTransactionId === row.statementTransactionId);
      const reason = candidates.length > 1 ? `候補が${candidates.length}件あります`
        : candidates[0]?.amountDeltaYen ? `金額が${yen(Math.abs(candidates[0].amountDeltaYen))}違います`
        : candidates[0]?.dateDistanceDays ? `日付が${candidates[0].dateDistanceDays}日ずれています` : '内容を確認してください';
      items.push({ merchant: statement.merchant, amountYen: statement.amountYen, tone: 'warning', reason });
    }
    for (const row of pending.filter(r => r.status !== 'needs_review')) {
      const statement = byId.get(row.statementTransactionId); if (!statement) continue;
      items.push({ merchant: statement.merchant, amountYen: statement.amountYen, tone: 'missing', reason: '記録が見つかりません' });
    }
    return items;
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
    const refresh = button('照合を更新する', rerun); refresh.className = 'secondary compact'; refresh.prepend(icon('repeat'));
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
    for (const [tone, symbol, label, count] of [['warning', 'warning', '要確認', needsReview], ['missing', 'unmatched', '記録なし', unmatched], ['success', 'check', '自動で一致', auto]] as const) {
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
      const summary = reviewSummaryRow(statement.merchant, yen(statement.amountYen), needsDecision ? 'warning' : 'missing');
      const setReason = (reason: string) => { summary.note.textContent = `${shortDay(statement.usedDate)} · ${reason}`; };
      setReason(needsDecision ? '内容を確認してください' : '記録が見つかりません');
      detail.append(summary.element);
      const body = document.createElement('div'); body.className = 'review-body'; detail.append(body);
      if (statement.kind === 'refund') { setReason('返金のため自動で処理できません'); body.append(text('p', '返金の記録です。現在は自動処理できません。')); }
      else {
        const statementSource = statementProviderLabels[statement.provider as StatementProvider] ?? '明細';
        // docs/DESIGN.md 突き合わせの伝票: the statement on top, each candidate record below a perforation.
        // Each candidate gets its own slip, so the buttons stay with the pair they decide.
        const statementHalf = () => slipPart('statement', statementSource, [
          { label: '日付', value: shortDay(statement.usedDate) }, { label: '店名', value: statement.merchant }, { label: '金額', value: yen(statement.amountYen) }]);
        const candidates = run.candidates.filter(c => c.statementTransactionId === statement.id);
        const reasons: string[] = [];
        for (const candidate of candidates) {
          const receipt = allReceipts.find(r => r.id === candidate.receiptId);
          const actualId = receipt?.registration.actualTransactionId ?? (candidate.receiptId.startsWith('actual:') ? candidate.receiptId.slice('actual:'.length) : null);
          const actual = actualId ? await ledger.getTransactionById(actualId) : null;
          if (!actual || actual.kind !== 'expense') continue;
          const block = document.createElement('div'); block.className = 'compare-candidate';
          const actualAccount = accountsById.get(actual.accountId)?.name ?? '利用できない支払元';
          const amountGap = Math.abs(statement.amountYen - Math.abs(actual.amountYen));
          const dayGap = Math.abs(daysBetween(statement.usedDate, actual.date));
          const sameDate = actual.date === statement.usedDate, sameAmount = actual.amountYen === -statement.amountYen;
          const record = slipPart('record', actualAccount, [
            { label: '日付', value: shortDay(actual.date), same: sameDate, differs: !sameDate },
            { label: '店名', value: actual.payeeName || '店名なし' },
            { label: '金額', value: yen(Math.abs(actual.amountYen)), same: sameAmount, differs: !sameAmount }]);
          const reason = !sameAmount ? `金額が${yen(amountGap)}違います` : dayGap ? `日付が${dayGap}日ずれています` : '内容を確認してください';
          reasons.push(reason);
          const seal = slipSeal();
          const slip = document.createElement('div'); slip.className = 'review-slip';
          slip.append(statementHalf(), slipPerforation(), record, seal);
          block.append(slip);
          // Why it is a candidate, in the warning color, right under the slip.
          block.append(text('p', `△ ${reason}`, 'compare-why'));
          if (!sameDate || !sameAmount) block.append(text('p', `「同じ支出」にすると、記録を明細の${[!sameDate ? `日付（${shortDay(statement.usedDate)}）` : '', !sameAmount ? `金額（${yen(statement.amountYen)}）` : ''].filter(Boolean).join('と')}に合わせます。`, 'muted'));
          const unsupportedSplitAmount = actual.isSplit === true && actual.amountYen !== -statement.amountYen;
          if (unsupportedSplitAmount) block.append(text('p', '分割された記録の金額差は反映できません。別の候補を選ぶか、明細を確認してください。'));
          const sameExpense = button('同じ支出', async () => {
            await reconciliation.sameExpense(run.runId, statement.id, candidate.receiptId);
            // The seal is pressed once the decision is saved, then the list is read again.
            slip.classList.add('is-stamped'); seal.classList.add('is-pressed');
            await new Promise(resolve => setTimeout(resolve, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 350));
            await rerun();
          }, false);
          sameExpense.disabled = unsupportedSplitAmount;
          const otherExpense = button('別の支出', async () => { await reconciliation.rejectPair(run.runId, statement.id, candidate.receiptId); await rerun(); }); otherExpense.className = 'text-button';
          block.append(sameExpense, otherExpense);
          body.append(block);
        }
        if (reasons.length > 1) setReason(`候補が${reasons.length}件あります`); else if (reasons.length === 1) setReason(reasons[0]);
        if (!candidates.length) {
          const slip = document.createElement('div'); slip.className = 'review-slip'; slip.append(statementHalf()); body.append(slip);
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
      const historySummary = document.createElement('summary'); const seal = text('span', '済', 'seal'); seal.setAttribute('aria-hidden', 'true');
      historySummary.append(seal, text('span', `自動で一致した内容を見る（${auto}件）`)); history.append(historySummary);
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
  await initializeBackupUi(repository, ledger);
  const closeMoneyForward = initializeMoneyForwardUi(repository, ledger, () => budgetId);
  const importDetails = document.createElement('details'); importDetails.className = 'settings-inner-disclosure';
  importDetails.append(text('summary', '既存の家計簿を取り込む'), el('import-section'));
  el('data-settings').append(importDetails);
  // Selection is only a recovery step when the saved budget cannot be determined.
  el('data-settings').prepend(el('budget-section'));
  const deviceLink = initializeDeviceLinkUi(repository, ledger);
  const budgetEntry = button('予算設定', budgetEditor); budgetEntry.classList.add('master-entry'); budgetEntry.setAttribute('aria-label', '予算設定'); setup.append(budgetEntry);
  const recurringEntry = button('定期登録', recurringOverview); recurringEntry.classList.add('master-entry'); recurringEntry.setAttribute('aria-label', '定期登録'); setup.append(recurringEntry);
  if (!crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') { el('message').textContent = '家計簿を開くためにページを再読込してください。'; return; }
  try { await ledger.listOpenAccounts(); } catch (error) { if (!(error instanceof ActualBudgetSelectionRequiredError)) throw error; }
  const actual = await import('@actual-app/api');
  const budgets = await actual.getBudgets(); const selector = el<HTMLSelectElement>('budget'); selector.replaceChildren(...budgets.map(b => new Option(b.name, b.id))); if (!budgetId) selector.prepend(new Option('家計簿を選択してください', '')); selector.value = budgetId ?? ''; el('budget-section').hidden = !!budgetId;
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
    await ensureBasicExpenseCategories(repository, ledger, budgetId);
    await deletions.recoverPending();
    await recurring.retry();
    await ledger.runDueSchedules();
    const latestDeletion = (await deletions.list()).filter(audit => audit.status === 'deleted' && Date.parse(audit.undoUntil) > Date.now()).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (latestDeletion) showDeletionToast(latestDeletion);
    if (!el('household-view').hidden) await home().catch((error: unknown) => { if (!(error instanceof StaleScreenError)) throw error; }); else el('message').textContent = '';
    deviceLink.announceReceived();
  } else { el('message').textContent = '使う家計簿を確認できません。設定の「バックアップと復元」から選択してください。'; }
}
