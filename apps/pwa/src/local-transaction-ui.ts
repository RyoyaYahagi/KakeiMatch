import { accountOptions } from './local-account-ui';
import { createMasterShortcut } from './local-master-ui';
import { compactAddButton, dateShortcuts, entryRow, formActions, optionalFields, recurrenceRow, shortLabel } from './entry-form';
import { scheduleFromEntry } from './entry-recurrence';
import type { RecurringScheduleInput } from '../../../src/lib/recurring-schedule';
import { categoryRow, lastUsedCategory, recentCategoryUsage } from './category-picker';
import { icon } from './ui-icons';
import type { createActualBrowserLedger } from '../../../src/lib/actual-browser-ledger';
import { ActualMasterValidationError } from '../../../src/lib/actual-browser-ledger';
import type { ActualTransaction } from '../../../src/lib/actual-ledger';
import type { LocalDataRepository } from '../../../src/lib/local-data';

type TransactionKind = 'expense' | 'income' | 'transfer';
export type TransactionEditField = 'amount' | 'date' | 'payee' | 'category' | 'account' | 'memo';
type FormValue = {
  kind: TransactionKind;
  date: string;
  amountYen: number;
  payeeName: string;
  categoryId: string;
  accountId: string;
  memo: string | null;
  excludedFromSpending?: boolean;
  destinationAccountId?: string;
};
type ManualTransactionDraft = {
  merchant: string;
  purchasedDate: string;
  purchasedTime: null;
  totalAmountYen: number;
  categoryId: string;
  accountId: string;
  manualKind?: TransactionKind;
  excludedFromSpending?: boolean;
  destinationAccountId?: string;
  manualMemo?: string | null;
  manualImportedId?: string;
  manualTransactionId?: string | null;
  manualStatus?: 'draft' | 'processing' | 'failed';
};

function node<K extends keyof HTMLElementTagNameMap>(tag: K, value?: string, className = ''): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (value !== undefined) element.textContent = value;
  element.className = className;
  return element;
}

function fieldLabel<K extends keyof HTMLElementTagNameMap>(tag: K, value: string, id: string): HTMLElementTagNameMap[K] {
  const label = document.createElement(tag);
  label.textContent = value;
  if (label instanceof HTMLLabelElement) label.htmlFor = id;
  return label;
}

function localToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function messageFor(error: unknown): string {
  if (error instanceof Error && /[ぁ-んァ-ヶ一-龠]/.test(error.message)) return error.message;
  return '保存できませんでした。入力内容を確認してもう一度お試しください。';
}

export function showManualTransactionEditor(options: {
  view: HTMLElement;
  ledger: ReturnType<typeof createActualBrowserLedger>;
  repository: LocalDataRepository;
  kind: TransactionKind;
  transaction?: ActualTransaction;
  focusField?: TransactionEditField;
  /** Called with the schedule to create when "くり返し" was chosen. */
  onSaved: (schedule?: RecurringScheduleInput) => Promise<void>;
  recurringNames?: () => Promise<string[]>;
  onCancel: () => Promise<void>;
}): void {
  const ledger = options.ledger;
  const transaction = options.transaction;
  const editing = transaction !== undefined;
  const kind = options.kind;
  const transfer = kind === 'transfer';
  const form = node('form', undefined, 'manual-transaction-form');
  const status = node('p', '', 'status');
  status.setAttribute('role', 'status');
  const heading = node('h2', editing ? '取引を編集' : transfer ? '口座間振替' : kind === 'expense' ? '支出を入力' : '収入を入力');
  status.textContent = 'カテゴリと口座を読み込んでいます。';
  const loadingCancel = node('button', 'キャンセル', 'secondary');
  loadingCancel.type = 'button';
  loadingCancel.addEventListener('click', () => { void options.onCancel().catch(error => { status.textContent = messageFor(error); }); });
  options.view.replaceChildren(heading, status, loadingCancel);
  if (transaction && transaction.kind !== kind) {
    status.textContent = 'この取引の種類は、この画面から編集できません。';
    return;
  }

  const draftId = `manual-draft:${kind}:${transaction?.id ?? 'new'}`;
  let releaseEditorLock: (() => void) | null = null;
  let pendingDraftWrites: Promise<void> = Promise.resolve();
  const observer = new MutationObserver(() => {
    if (heading.isConnected && !options.view.hidden) return;
    observer.disconnect();
    void Promise.all([pendingDraftWrites, inFlightOperation]).catch(() => undefined).finally(() => { releaseEditorLock?.(); releaseEditorLock = null; });
  });
  let inFlightOperation: Promise<void> = Promise.resolve();
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  if (!navigator.locks) {
    status.textContent = 'この端末では安全に記録できません。対応ブラウザーで開き直してください。';
    observer.disconnect();
    return;
  }
  const editorLockReady = new Promise<boolean>((resolve, reject) => {
    void navigator.locks.request(`kakeimatch-manual-editor:${draftId}`, { mode: 'exclusive', ifAvailable: true }, async lock => {
      if (!lock) { resolve(false); return; }
      resolve(true);
      await new Promise<void>(release => { releaseEditorLock = release; });
    }).catch(reject);
  });
  void editorLockReady.then(locked => {
    if (!locked) throw new Error('別の画面でこの記録を編集中です。閉じてから開き直してください。');
    if (!heading.isConnected || options.view.hidden) { releaseEditorLock?.(); return null; }
    const categoriesPromise = transfer ? Promise.resolve([]) : kind === 'expense' ? ledger.listExpenseCategories() : ledger.listIncomeCategories();
    // docs/UX.md 収入・振替の入力: a new income starts with the category used last time.
    const lastUsedPromise = !transfer && !transaction ? categoriesPromise.then(rows => lastUsedCategory(ledger, kind as 'expense' | 'income', rows.map(row => row.id))).catch(() => '') : Promise.resolve('');
    return Promise.all([categoriesPromise, ledger.listOpenAccounts(), options.repository.get<ManualTransactionDraft>(draftId), lastUsedPromise] as const);
  }).then(result => {
    if (!result || !heading.isConnected || options.view.hidden) return;
    const [categories, accounts, draftRecord, lastUsed] = result;
    const draft = draftRecord?.kind === 'category-state' && draftRecord.value.manualKind === kind &&
      (draftRecord.value.manualTransactionId ?? null) === (transaction?.id ?? null) ? draftRecord.value : null;
    const draftSnapshot: FormValue | null = draft ? {
      kind, date: draft.purchasedDate, amountYen: draft.totalAmountYen,
      payeeName: draft.merchant, categoryId: draft.categoryId, accountId: draft.accountId,
      memo: draft.manualMemo ?? null, destinationAccountId: draft.destinationAccountId, excludedFromSpending: draft.excludedFromSpending ?? false,
    } : null;
    const dateLabel = shortLabel('manual-transaction-date', '日付');
    const date = node('input'); date.id = dateLabel.htmlFor; date.type = 'date'; date.required = true;
    date.value = draftSnapshot?.date ?? transaction?.date ?? localToday();

    const amountLabel = shortLabel('manual-transaction-amount', '金額', '（円）');
    const amount = node('input'); amount.id = amountLabel.htmlFor; amount.type = 'number'; amount.inputMode = 'numeric';
    amount.min = '1'; amount.step = '1'; amount.required = true;
    amount.value = draftSnapshot ? String(draftSnapshot.amountYen) : transaction ? String(Math.abs(transaction.amountYen)) : '';

    const payeeText = kind === 'expense' ? '店名・支払先' : '入金元・内容';
    const payeeLabel = kind === 'expense' ? shortLabel('manual-transaction-payee', '店名', '・支払先') : shortLabel('manual-transaction-payee', '内容', '', '入金元・');
    const payee = node('input'); payee.id = payeeLabel.htmlFor; payee.maxLength = 200; payee.required = !transfer;
    payee.value = draftSnapshot?.payeeName ?? transaction?.payeeName ?? '';

    const categoryText = kind === 'expense' ? '支出カテゴリ' : '収入カテゴリ';
    const categoryLabel = shortLabel('manual-transaction-category', 'カテゴリ');
    const category = node('select'); category.id = categoryLabel.htmlFor; category.required = !transfer;
    category.replaceChildren(new Option('選択してください', ''), ...categories.map(value => new Option(value.name, value.id)));
    const currentCategoryId = transaction?.categoryId ?? categories.find(value => value.name === transaction?.categoryName)?.id ?? '';
    const selectedCategoryId = draftSnapshot?.categoryId ?? (currentCategoryId || lastUsed);
    if (selectedCategoryId && !categories.some(value => value.id === selectedCategoryId)) {
      category.append(new Option(`現在のカテゴリ：${transaction?.categoryName ?? '利用できません'}`, selectedCategoryId));
    }
    category.value = selectedCategoryId;

    const accountLabel = transfer ? fieldLabel('label', '振替元口座', 'manual-transaction-account') : kind === 'expense' ? shortLabel('manual-transaction-account', '支払元') : shortLabel('manual-transaction-account', '入金先', '口座');
    const account = node('select'); account.id = accountLabel.htmlFor; account.required = true;
    account.replaceChildren(new Option('選択してください', ''), ...accountOptions(accounts, kind));
    const selectedAccountId = draftSnapshot?.accountId ?? transaction?.accountId;
    if (selectedAccountId && !accounts.some(value => value.id === selectedAccountId)) {
      account.append(new Option('現在の口座（利用終了）', selectedAccountId));
    }
    account.value = selectedAccountId ?? (accounts.length === 1 ? accounts[0].id : '');

    const destinationLabel = fieldLabel('label', '振替先口座', 'manual-transaction-destination');
    const destination = node('select'); destination.id = destinationLabel.htmlFor; destination.required = transfer;
    destination.replaceChildren(new Option('選択してください', ''), ...accountOptions(accounts, kind));
    const destinationId = draftSnapshot?.destinationAccountId ?? transaction?.transferAccountId ?? '';
    if (destinationId && !accounts.some(value => value.id === destinationId)) destination.append(new Option('現在の口座（利用終了）', destinationId));
    destination.value = destinationId;

    const memoLabel = fieldLabel('label', 'メモ（任意）', 'manual-transaction-memo');
    const memo = node('textarea'); memo.id = memoLabel.htmlFor; memo.maxLength = 2000; memo.value = draftSnapshot?.memo ?? transaction?.memo ?? '';

    const submit = node('button', editing ? '変更を保存する' : '登録する', 'primary');
    submit.type = 'submit';
    const cancel = node('button', 'キャンセル', 'secondary');
    cancel.type = 'button';
    cancel.addEventListener('click', () => { void options.onCancel().catch(error => { status.textContent = messageFor(error); }); });

    amount.classList.add('amount-input');
    const optional = optionalFields('メモ', [memoLabel, memo], Boolean(memo.value));
    // docs/DESIGN.md 帳簿の行で組む入力: one ruled row per field.
    const categoryUi = transfer ? null : categoryRow({ select: category, label: categoryLabel, usageReady: recentCategoryUsage(ledger),
      hint: lastUsed && !draftSnapshot ? { value: lastUsed, text: '前回と同じ' } : null });
    const rows = document.createElement('div'); rows.className = 'entry-rows';
    rows.append(entryRow(amountLabel, amount), ...(transfer ? [] : [entryRow(payeeLabel, payee)]), entryRow(dateLabel, date, dateShortcuts(date, localToday())),
      ...(categoryUi ? [categoryUi.row] : []), entryRow(accountLabel, account), ...(transfer ? [entryRow(destinationLabel, destination)] : []), optional);
    const excluded = node('input'); excluded.type = 'checkbox'; excluded.id = 'manual-transaction-excluded';
    excluded.checked = draftSnapshot?.excludedFromSpending ?? transaction?.excludedFromSpending ?? false;
    if (kind === 'expense') {
      const exclusion = node('div'); exclusion.className = 'entry-row'; exclusion.append(excluded, fieldLabel('label', '支出の計算に含めない', excluded.id)); rows.append(exclusion);
    }
    // Schedules hold expenses and incomes only; a transfer or an edit stays one record.
    const recurrence = kind === 'income' && !editing ? recurrenceRow('manual-transaction-recurrence') : null;
    if (recurrence) rows.append(recurrence.row);
    const savedResultPanel = node('div');
    savedResultPanel.dataset.savedResult = '';
    savedResultPanel.hidden = true;
    form.append(rows, savedResultPanel, status, formActions(submit));
    const shortcuts: HTMLButtonElement[] = [];
    function addShortcut(field: HTMLSelectElement, request: { kind: 'category'; isIncome: boolean } | { kind: 'account' }) {
      const shortcut = createMasterShortcut({ ledger, request, origin: {
        field, beforeOpen: () => persistDraft(readValue()),
        onCreated: async id => {
          if (request.kind === 'category') {
            const updated = await (kind === 'income' ? ledger.listIncomeCategories() : ledger.listExpenseCategories());
            categories.splice(0, categories.length, ...updated);
            category.replaceChildren(new Option('選択してください', ''), ...categories.map(value => new Option(value.name, value.id)));
          } else {
            const updated = await ledger.listOpenAccounts(); accounts.splice(0, accounts.length, ...updated);
            for (const select of transfer ? [account, destination] : [account]) {
              const previous = select.value;
              select.replaceChildren(new Option('選択してください', ''), ...accountOptions(accounts, kind));
              if (previous && !accounts.some(value => value.id === previous)) select.append(new Option('現在の口座（利用終了）', previous));
              select.value = previous;
            }
          }
          field.value = id;
          // Lets the category row show the new name and close its sheet.
          field.dispatchEvent(new Event('change', { bubbles: true }));
          await persistDraft(readValue());
        },
      } });
      if (field === category && categoryUi) categoryUi.sheet.querySelector('.sheet-body')?.append(shortcut); else field.after(compactAddButton(shortcut));
      shortcuts.push(shortcut);
    }
    if (!transfer) addShortcut(category, { kind: 'category', isIncome: kind === 'income' });
    addShortcut(account, { kind: 'account' });
    if (transfer) addShortcut(destination, { kind: 'account' });
    cancel.className = 'text-button back-link'; cancel.prepend(icon('chevronLeft'));
    options.view.replaceChildren(cancel, heading, form);
    status.textContent = '';

    const readValue = (): FormValue => ({
      kind,
      date: date.value,
      amountYen: Number(amount.value),
      payeeName: payee.value.trim(),
      categoryId: category.value,
      accountId: account.value,
      memo: memo.value.trim() || null,
      ...(kind === "expense" ? { excludedFromSpending: excluded.checked } : {}),
      ...(transfer ? { destinationAccountId: destination.value } : {}),
    });
    const fields: Array<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement> = transfer ? [date, amount, account, destination, memo] : [date, amount, payee, category, account, memo, excluded];
    let submittedSnapshot: FormValue | null = draft?.manualStatus === 'processing' || draft?.manualStatus === 'failed' ? draftSnapshot : null;
    let frozenAfterUnknownFailure = submittedSnapshot !== null;
    let savedResult: ActualTransaction | null = null;
    const importedId = draft?.manualImportedId ?? `kakeimatch:${transfer ? 'transfer' : 'manual'}:${crypto.randomUUID()}`;
    let draftTail = pendingDraftWrites;

    function persistDraft(value: FormValue, manualStatus: ManualTransactionDraft['manualStatus'] = 'draft') {
      const record: ManualTransactionDraft = {
        merchant: value.payeeName, purchasedDate: value.date, purchasedTime: null,
        totalAmountYen: value.amountYen, categoryId: value.categoryId, accountId: value.accountId,
        manualKind: kind, manualMemo: value.memo, manualImportedId: importedId,
        ...(kind === "expense" ? { excludedFromSpending: value.excludedFromSpending ?? false } : {}),
        manualTransactionId: transaction?.id ?? null, manualStatus,
        ...(transfer ? { destinationAccountId: value.destinationAccountId } : {}),
      };
      draftTail = draftTail.catch(() => undefined).then(() => options.repository.put({
        id: draftId, kind: 'category-state', value: record, updatedAt: new Date().toISOString(),
      }));
      pendingDraftWrites = draftTail;
      return draftTail;
    }

    let draftSequence = 0;
    for (const field of fields) field.addEventListener('input', () => {
      if (frozenAfterUnknownFailure) return;
      const sequence = ++draftSequence;
      status.textContent = '入力内容を保存しています…';
      void persistDraft(readValue()).then(() => { if (heading.isConnected && sequence === draftSequence && !frozenAfterUnknownFailure && !submit.disabled) status.textContent = '入力内容を端末に保存しました。'; }).catch(error => { if (heading.isConnected && sequence === draftSequence) status.textContent = messageFor(error); });
    });

    function setBusy(busy: boolean) {
      for (const shortcut of shortcuts) shortcut.disabled = busy || frozenAfterUnknownFailure;
      for (const field of fields) field.disabled = busy || frozenAfterUnknownFailure;
      // Leaving the editor keeps the fixed draft and its imported ID intact.
      // Only an in-flight save needs to block cancellation.
      cancel.disabled = busy;
      submit.disabled = busy;
      form.setAttribute('aria-busy', String(busy));
      submit.textContent = busy ? '保存結果を確認しています…' : savedResult ? '登録済みの内容で完了する' : frozenAfterUnknownFailure ? '同じ内容で再試行する' : editing ? '変更を保存する' : '登録する';
    }

    function showSavedResult(saved: ActualTransaction) {
      savedResult = saved;
      savedResultPanel.replaceChildren(node('h3', '登録済みの内容'),
        node('p', `${saved.date} · ${saved.payeeName ?? '内容なし'} · ¥${Math.abs(saved.amountYen).toLocaleString('ja-JP')}`),
        node('p', `${saved.categoryName ?? 'カテゴリなし'} · ${accounts.find(row => row.id === saved.accountId)?.name ?? '利用終了の口座'}`),
        ...(saved.memo ? [node('p', saved.memo)] : []));
      savedResultPanel.hidden = false;
      submit.type = 'button';
      status.textContent = 'この取引は登録済みです。下書きと内容が異なるため、登録済みの内容を確認して完了してください。';
    }

    // Resolve a failed retry by reading the same identity, never by generating
    // a replacement ID or overwriting a transaction whose result differs.
    async function recoverCreate(value: FormValue) {
      if (editing || transfer) return;
      try {
        const result = await ledger.getImportedTransaction(importedId);
        if (!heading.isConnected) return;
        if (result) {
          const saved = result.transaction;
          if (saved.kind !== kind || saved.isSplit || saved.importedId !== importedId) throw new Error('Unexpected registered transaction');
          showSavedResult(saved);
        } else {
          await persistDraft(value, 'draft');
          if (!heading.isConnected) return;
          submittedSnapshot = null;
          frozenAfterUnknownFailure = false;
          status.textContent = '未登録であることを確認しました。入力内容を修正して登録できます。';
        }
      } catch {
        if (heading.isConnected) status.textContent = '保存結果をまだ確認できません。下書きを保持しています。もう一度再試行してください。';
      }
    }

    submit.addEventListener('click', () => {
      if (!savedResult || submit.disabled) return;
      const confirmed = savedResult;
      status.textContent = '登録済みの内容を確認しています…';
      setBusy(true);
      inFlightOperation = navigator.locks.request(`kakeimatch-manual-transaction:${confirmed.id}`, { mode: 'exclusive', ifAvailable: true }, async lock => {
        if (!lock) throw new Error('別の画面で記録を保存中です。終わってからもう一度お試しください。');
        const current = await ledger.getImportedTransaction(importedId);
        if (!heading.isConnected) return;
        const fields = ['id', 'date', 'amountYen', 'kind', 'payeeName', 'categoryId', 'categoryName', 'accountId', 'memo', 'isSplit', 'transferAccountId'] as const;
        if (!current || current.transaction.importedId !== importedId) throw new Error('登録済みの取引を確認できませんでした。下書きは残しています。');
        if (fields.some(field => (current.transaction[field] ?? null) !== (confirmed[field] ?? null))) {
          if (current.transaction.kind !== kind || current.transaction.isSplit) throw new Error('登録済みの取引が変更されました。下書きは残しています。');
          showSavedResult(current.transaction);
          status.textContent = '登録済みの内容が変わりました。表示された内容を確認してください。';
          return;
        }
        await pendingDraftWrites;
        await options.repository.delete(draftId);
        await options.onSaved();
      }).then(() => undefined).catch(error => { if (heading.isConnected) status.textContent = messageFor(error); }).finally(() => { if (heading.isConnected) setBusy(false); });
    });
    function validate(value: FormValue): string | null {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value.date) || Number.isNaN(new Date(`${value.date}T00:00:00Z`).valueOf()) || new Date(`${value.date}T00:00:00Z`).toISOString().slice(0, 10) !== value.date) return '日付を選んでください。';
      if (!Number.isSafeInteger(value.amountYen) || value.amountYen <= 0) return '金額は1円以上の整数で入力してください。';
      if (transfer) {
        if (!value.accountId || !value.destinationAccountId) return '振替元と振替先の口座を選んでください。';
        if (value.accountId === value.destinationAccountId) return '異なる口座を選んでください。';
        return null;
      }
      if (!value.payeeName) return `${payeeText}を入力してください。`;
      if (!value.categoryId) return `${categoryText}を選んでください。`;
      if (!value.accountId) return `${kind === 'expense' ? '支払元' : '入金先口座'}を選んでください。`;
      return null;
    }

    form.addEventListener('submit', event => {
      event.preventDefault();
      if (submit.disabled || savedResult) return;
      const value = frozenAfterUnknownFailure && submittedSnapshot ? submittedSnapshot : readValue();
      const validationError = validate(value);
      if (validationError) { status.textContent = validationError; return; }
      const frequency = recurrence?.value() ?? '';
      const schedule = frequency ? scheduleFromEntry({ name: value.payeeName, kind: 'income', amountYen: value.amountYen, categoryId: value.categoryId, accountId: value.accountId, date: value.date }, frequency) ?? undefined : undefined;
      if (!navigator.locks) { status.textContent = 'この端末では安全に保存できません。対応ブラウザーで開き直してください。入力内容は残っています。'; return; }
      submittedSnapshot = { ...value };
      const wasFrozen = frozenAfterUnknownFailure;
      status.textContent = '保存結果を確認しています…';
      setBusy(true);
      inFlightOperation = (async () => {
      // A schedule name must be unique; check before the record is saved so nothing is half done.
      if (schedule && options.recurringNames && (await options.recurringNames()).includes(schedule.name)) {
        submittedSnapshot = null;
        if (heading.isConnected) status.textContent = '同じ名前の定期登録があります。内容を変えるか、「くり返し」を「しない」にしてください。';
        setBusy(false);
        return;
      }
      const lockIds = editing && transfer ? (await ledger.getTransactionTree(transaction!.id)).map(row => row.id).sort() : [transaction?.id ?? 'create'];
      const withLocks = async (operation: () => Promise<void>, index = 0): Promise<void> => index >= lockIds.length ? operation() : navigator.locks.request(`kakeimatch-manual-transaction:${lockIds[index]}`, { mode: 'exclusive', ifAvailable: true }, async lock => {
        if (!lock) throw new ActualMasterValidationError('別の画面で記録を保存中です。終わってからもう一度お試しください。');
        await withLocks(operation, index + 1);
      });
        let editAudit: { targetType: 'transaction'; transactionId: string; operationId: string; before: ActualTransaction; after: ActualTransaction; status: 'pending' | 'applied'; createdAt: string; appliedAt: string | null } | null = null;
        try { await persistDraft(value, 'processing'); }
        catch (error) {
          submittedSnapshot = null;
          if (heading.isConnected) status.textContent = messageFor(error);
          setBusy(false);
          return;
        }
        try {
          await withLocks(async () => {
            if (editing) {
              const correctionId = `transaction-correction:${transaction!.id}`;
              const prior = await options.repository.get<NonNullable<typeof editAudit>>(correctionId);
              if (prior?.value.status !== 'pending') {
                const latest = await ledger.getTransactionById(transaction!.id);
                const fields = ['date', 'amountYen', 'accountId', 'categoryId', 'payeeName', 'memo', 'transferAccountId'] as const;
                if (!latest || fields.some(field => (latest[field] ?? null) !== (transaction![field] ?? null))) throw new ActualMasterValidationError('別の画面で記録が変更されました。開き直してから編集してください。');
              }
              const timestamp = new Date().toISOString();
              editAudit = prior?.value.status === 'pending' ? prior.value : {
                targetType: 'transaction', transactionId: transaction!.id, operationId: importedId,
                before: transaction!,
                after: { ...transaction!, date: value.date, amountYen: kind === 'income' ? value.amountYen : -value.amountYen,
                  accountId: value.accountId, memo: value.memo,
                  ...(transfer ? { transferAccountId: value.destinationAccountId } : { categoryId: value.categoryId, payeeName: value.payeeName }) },
                status: 'pending', createdAt: timestamp, appliedAt: null,
              };
              await options.repository.put({ id: correctionId, kind: 'correction-audit', value: editAudit, updatedAt: timestamp });
            }
            let saved: ActualTransaction;
            if (transfer) {
              const transferValue = { date: value.date, amountYen: value.amountYen, sourceAccountId: value.accountId, destinationAccountId: value.destinationAccountId!, memo: value.memo };
              if (editing) saved = await ledger.updateTransfer(transaction!.id, transferValue);
              else saved = await ledger.createTransfer({ ...transferValue, importedId });
            } else {
              // Restored drafts also carry transfer fields. Pass only the
              // income/expense fields accepted by the ledger's strict schema.
              const manualValue = {
                kind: kind as 'expense' | 'income', date: value.date, amountYen: value.amountYen,
                payeeName: value.payeeName, categoryId: value.categoryId,
                accountId: value.accountId, memo: value.memo,
              };
              if (editing) saved = await ledger.updateTransaction(transaction!.id, manualValue);
              else saved = await ledger.createTransaction({ ...manualValue, importedId });
            }
            if (kind === "expense") await ledger.setSpendingExclusion(saved.id, value.excludedFromSpending ?? false);
            if (editAudit) {
              const timestamp = new Date().toISOString();
              const audit = { ...editAudit, after: saved, status: 'applied' as const, appliedAt: timestamp };
              await options.repository.putRecords([
                { id: `transaction-correction:${transaction!.id}`, kind: 'correction-audit', value: audit, updatedAt: timestamp },
                { id: `transaction-correction:${transaction!.id}:${editAudit.operationId}`, kind: 'correction-audit', value: audit, updatedAt: timestamp },
              ]);
            }
          });
        } catch (error) {
          if (!heading.isConnected) return;
          status.textContent = messageFor(error);
          if (error instanceof ActualMasterValidationError) {
            if (editing && !wasFrozen && editAudit) await options.repository.delete(`transaction-correction:${transaction!.id}`);
            if (wasFrozen) {
              await persistDraft(value, 'failed').catch(() => undefined);
              if (!heading.isConnected) return;
              frozenAfterUnknownFailure = true;
              submit.textContent = '同じ内容で再試行する';
              status.textContent = `${messageFor(error)} 保存結果を確認するため、入力を固定して同じ内容で再試行してください。`;
            } else {
              await persistDraft(value, 'draft').catch(persistError => { if (heading.isConnected) status.textContent = messageFor(persistError); });
              if (!heading.isConnected) return;
              submittedSnapshot = null;
              frozenAfterUnknownFailure = false;
            }
          } else {
            frozenAfterUnknownFailure = true;
            await persistDraft(value, 'failed').catch(() => undefined);
            if (!heading.isConnected) return;
            submit.textContent = '同じ内容で再試行する';
            status.textContent = '保存結果を確認できませんでした。入力内容を固定し、同じ内容で再試行してください。';
          }
          if (wasFrozen) await recoverCreate(value);
          setBusy(false);
          return;
        }
        if (!heading.isConnected) {
          await options.repository.delete(draftId).catch(() => undefined);
          return;
        }
        try {
          await options.repository.delete(draftId);
          if (!heading.isConnected) return;
        } catch (error) {
          if (!heading.isConnected) return;
          frozenAfterUnknownFailure = true;
          await persistDraft(value, 'failed').catch(() => undefined);
          submit.textContent = '同じ内容で再試行する';
          status.textContent = `取引を保存しましたが、下書きを整理できませんでした。${messageFor(error)} 同じ内容で再試行してください。`;
          setBusy(false);
          return;
        }
        frozenAfterUnknownFailure = false;
        try {
          await options.onSaved(schedule);
        } catch (error) {
          if (heading.isConnected) {
            frozenAfterUnknownFailure = true;
            await persistDraft(value, 'failed').catch(() => undefined);
            submit.textContent = '同じ内容で再試行する';
            status.textContent = `取引は保存しました。画面を更新できませんでした。${messageFor(error)}`;
            setBusy(false);
          }
        }
      })();
      void inFlightOperation;
    });

    if (transaction?.isSplit) {
      fields.forEach(field => { field.disabled = true; });
      submit.disabled = true;
      status.textContent = 'カテゴリ別に分けた取引です。この画面からは編集できません。';
    }
    if (frozenAfterUnknownFailure) {
      shortcuts.forEach(shortcut => { shortcut.disabled = true; });
      fields.forEach(field => { field.disabled = true; });
      submit.textContent = '同じ内容で再試行する';
      status.textContent = '前回の保存結果を確認できませんでした。入力内容を固定し、同じ内容で再試行してください。';
    }
    if (options.focusField === 'category') {
      categoryUi?.row.querySelector<HTMLButtonElement>('.entry-row-more')?.click();
    } else if (options.focusField) {
      if (options.focusField === 'memo') optional.open = true;
      const control = ({ amount, date, payee, account, memo })[options.focusField];
      control?.focus();
    }
  }).catch(error => {
    if (!heading.isConnected) return;
    status.textContent = messageFor(error);
    options.view.replaceChildren(heading, status, loadingCancel);
  });
}
