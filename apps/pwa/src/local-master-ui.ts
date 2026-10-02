import { accountTypeField, accountTypeLabels, accountBalanceLabel, type AccountType } from './local-account-ui';
import type { ActualTransaction } from '../../../src/lib/actual-ledger';
import type { createActualBrowserLedger } from '../../../src/lib/actual-browser-ledger';
import { CATEGORY_LABELS } from '../../../src/lib/category';

type Ledger = ReturnType<typeof createActualBrowserLedger>;
type Category = Awaited<ReturnType<Ledger['listCategories']>>[number];
type Account = Awaited<ReturnType<Ledger['listAccounts']>>[number];

const yen = (amount: number) => `¥${Math.abs(amount).toLocaleString('ja-JP')}`;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, value?: string, className = '') {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = value;
  node.className = className;
  return node;
}

function errorMessage(error: unknown) {
  if (error instanceof Error && /[ぁ-んァ-ヶ一-龠]/.test(error.message)) return error.message;
  return '保存できませんでした。入力内容を確認して、もう一度お試しください。';
}

function nameForm(labelText: string, initialValue: string, submitText: string, save: (name: string) => Promise<void>, onError: (error: unknown) => void) {
  const form = element('form');
  const id = `master-name-${crypto.randomUUID()}`;
  const label = element('label', labelText);
  label.htmlFor = id;
  const input = element('input');
  input.id = id;
  input.name = 'name';
  input.required = true;
  input.maxLength = 100;
  input.value = initialValue;
  const submit = element('button', submitText);
  submit.type = 'submit';
  form.append(label, input, submit);
  form.addEventListener('submit', event => {
    event.preventDefault();
    submit.disabled = true; input.disabled = true; form.querySelectorAll('select').forEach(select => { select.disabled = true; }); form.dataset.saving = 'true';
    void save(input.value.trim()).catch(onError).finally(() => { submit.disabled = false; input.disabled = false; form.querySelectorAll('select').forEach(select => { select.disabled = false; }); delete form.dataset.saving; });
  });
  return form;
}

type MasterCreation = { kind: 'category'; isIncome: boolean } | { kind: 'account' };

// The settings screen and in-entry shortcuts share validation and creation.
function masterCreationForm(ledger: Ledger, request: MasterCreation, onCreated: (id: string) => Promise<void>, onError: (error: unknown) => void) {
  let createdId: string | null = null;
  const typeField = request.kind === 'account' ? accountTypeField() : null;
  const form = nameForm(request.kind === 'category' ? 'カテゴリ名' : '支払元の名前', '', '追加する', async name => {
    if (!name) throw new Error(request.kind === 'category' ? 'カテゴリ名を入力してください。' : '支払元の名前を入力してください。');
    if (createdId === null) {
      createdId = request.kind === 'category' ? await ledger.addCategory(name, request.isIncome) : await ledger.addAccount(name, typeField!.select.value as AccountType);
      form.querySelector('input')!.readOnly = true;
      if (typeField) typeField.select.disabled = true;
    }
    // A failed refresh can be retried without creating a second master entry.
    await onCreated(createdId);
  }, onError);
  if (typeField) form.querySelector('button')!.before(typeField.label, typeField.select);
  return form;
}

/** Keeps the caller and its draft alive; the explicit origin handles refresh/selection. */
export function createMasterShortcut(options: {
  ledger: Ledger;
  request: MasterCreation;
  origin: { field: HTMLSelectElement; beforeOpen: () => Promise<void>; onCreated: (id: string) => Promise<void> };
}): HTMLButtonElement {
  const launch = element('button', options.request.kind === 'category' ? 'カテゴリを追加' : '支払元・口座を追加', 'secondary text-button');
  launch.type = 'button';
  launch.dataset.masterShortcutFor = options.origin.field.id;
  launch.addEventListener('click', () => {
    const itemDetails = options.origin.field.closest('details');
    const itemWasOpen = itemDetails?.open;
    launch.disabled = true;
    void (async () => {
      const dialog = element('dialog', undefined, 'master-create-dialog');
      const heading = element('h2', options.request.kind === 'category' ? options.request.isIncome ? '収入カテゴリを追加' : '支出カテゴリを追加' : '支払元・口座を追加');
      heading.id = `master-dialog-${crypto.randomUUID()}`;
      dialog.setAttribute('aria-labelledby', heading.id);
      const status = element('p', '', 'master-status'); status.setAttribute('role', 'status');
      const showError = (error: unknown) => { status.textContent = errorMessage(error); };
      const close = () => {
        dialog.close(); dialog.remove();
        if (itemDetails && itemWasOpen) itemDetails.open = true;
        if (options.origin.field.isConnected) options.origin.field.focus();
      };
      const form = masterCreationForm(options.ledger, options.request, async id => { await options.origin.onCreated(id); close(); }, showError);
      const back = element('button', '入力へ戻る', 'secondary'); back.type = 'button';
      back.addEventListener('click', () => { if (form.dataset.saving !== 'true') close(); });
      dialog.addEventListener('cancel', event => { event.preventDefault(); if (form.dataset.saving !== 'true') close(); });
      dialog.append(heading, form, status, back);
      document.body.append(dialog); dialog.showModal();
      const controls = form.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input,button,select');
      controls.forEach(control => { control.disabled = true; });
      try {
        await options.origin.beforeOpen();
        controls.forEach(control => { control.disabled = false; });
      } catch (error) { showError(error); }
    })().finally(() => { launch.disabled = false; });
  });
  return launch;
}

export function initializeMasterUi(
  container: HTMLElement,
  ledger: ReturnType<typeof createActualBrowserLedger>,
  options: { onBack: () => void; onTransaction?: (transaction: ActualTransaction) => Promise<void>; beforeDeleteAccount?: (id: string) => Promise<void>; beforeDeleteCategory?: (id: string) => Promise<void> },
): (() => void) & { openAccounts: () => Promise<void> } {
  const section = element('section');
  section.className = 'master-settings';
  section.hidden = true;
  container.after(section);
  const parent = container.parentElement;
  const originalHidden = new Map<HTMLElement, boolean>();
  let managing = false;

  function showError(error: unknown) {
    const status = section.querySelector<HTMLElement>('[data-master-status]');
    if (status) { status.textContent = errorMessage(error); status.classList.add('error'); }
  }
  function button(label: string, action: () => Promise<void> | void, primary = false) {
    const node = element('button', label, primary ? '' : 'secondary');
    node.type = 'button';
    node.addEventListener('click', () => {
      node.disabled = true;
      void Promise.resolve().then(action).catch(showError).finally(() => { node.disabled = false; });
    });
    return node;
  }
  function enterManagement() {
    if (!managing && parent) {
      originalHidden.clear();
      for (const child of Array.from(parent.children)) {
        if (child instanceof HTMLElement && child !== section) {
          originalHidden.set(child, child.hidden);
          child.hidden = true;
        }
      }
      managing = true;
    }
    section.hidden = false;
  }
  function leaveManagement() {
    section.hidden = true;
    for (const [node, hidden] of originalHidden) node.hidden = hidden;
    originalHidden.clear();
    managing = false;
  }
  function showPage(title: string, returnToList?: () => Promise<void> | void) {
    enterManagement();
    section.replaceChildren();
    const header = element('div', undefined, 'master-header');
    header.append(button('設定へ戻る', () => {
      leaveManagement();
      options.onBack();
    }));
    header.append(element('h2', title));
    section.append(header);
    const status = element('p', '', 'master-status');
    status.dataset.masterStatus = 'true';
    status.setAttribute('role', 'status');
    section.append(status);
    if (returnToList) section.append(button('一覧へ戻る', returnToList));
  }
  function showFormError(error: unknown) { showError(error); }

  const categoryEntry = button('カテゴリ', () => categoriesPage(false));
  categoryEntry.classList.add('master-entry');
  categoryEntry.setAttribute('aria-label', 'カテゴリ');
  const accountEntry = button('支払元', accountsPage);
  accountEntry.classList.add('master-entry');
  accountEntry.setAttribute('aria-label', '支払元');
  container.append(categoryEntry, accountEntry);

  async function categoriesPage(kind: boolean | null = false) {
    showPage(kind ? '収入カテゴリ' : '支出カテゴリ');
    const switcher = element('div', undefined, 'master-switcher');
    const expenses = button('支出カテゴリ', () => categoriesPage(false));
    const income = button('収入カテゴリ', () => categoriesPage(true));
    expenses.setAttribute('aria-pressed', String(kind === false));
    income.setAttribute('aria-pressed', String(kind === true));
    switcher.append(expenses, income);
    section.append(switcher);
    if (kind === false) section.append(button('基本カテゴリを用意する', async () => {
      const existing = await ledger.listCategories();
      const names = new Set(existing.filter(row => !row.isIncome).map(row => row.name));
      for (const name of Object.values(CATEGORY_LABELS)) if (!names.has(name)) await ledger.addCategory(name, false);
      await categoriesPage(false);
      const status = section.querySelector<HTMLElement>('[data-master-status]');
      if (status) status.textContent = '基本カテゴリを用意しました。';
    }));
    section.append(button('カテゴリを追加する', () => categoryCreatePage(kind), true));
    const list = element('ul', undefined, 'master-list');
    section.append(list);
    const categories = (await ledger.listCategories()).filter(row => kind === null || row.isIncome === kind);
    if (!categories.length) list.append(element('li', 'カテゴリがありません。'));
    for (const category of categories) {
      const row = element('li', undefined, 'master-row');
      row.append(button(`${category.name} · ${category.hidden ? '非表示' : '表示中'} · ${category.groupName}`, () => categoryDetailPage(category, kind)));
      list.append(row);
    }
  }

  async function categoryCreatePage(kind: boolean | null) {
    const isIncome = kind ?? false;
    showPage(isIncome ? '収入カテゴリを追加' : '支出カテゴリを追加', () => categoriesPage(kind));
    section.append(masterCreationForm(ledger, { kind: 'category', isIncome }, async () => { await categoriesPage(isIncome); }, showFormError));
  }

  async function categoryDetailPage(category: Category, listKind: boolean | null) {
    showPage(category.isIncome ? '収入カテゴリの詳細' : '支出カテゴリの詳細', () => categoriesPage(listKind));
    const usage = await ledger.getCategoryUsage(category.id);
    section.append(element('p', `カテゴリ名：${category.name}`), element('p', `グループ：${category.groupName}`), element('p', category.hidden ? '状態：非表示' : '状態：表示中'), element('p', `使われている記録：${usage}件`));
    section.append(button('編集する', () => categoryEditPage(category, listKind), true));
    section.append(button(category.hidden ? 'カテゴリを表示する' : 'カテゴリを非表示にする', async () => {
      await ledger.setCategoryHidden(category.id, !category.hidden);
      const updated = (await ledger.listCategories()).find(row => row.id === category.id) ?? { ...category, hidden: !category.hidden };
      await categoryDetailPage(updated, listKind);
      if (category.hidden && updated.hidden) {
        const status = section.querySelector<HTMLElement>('[data-master-status]');
        if (status) status.textContent = 'カテゴリのグループが非表示のため、グループ側の設定も確認してください。';
      }
    }));
    if (usage === 0) section.append(button('カテゴリを削除する', async () => {
      if (!window.confirm(`「${category.name}」を削除しますか？`)) return;
      await options.beforeDeleteCategory?.(category.id);
      await ledger.deleteCategory(category.id);
      await categoriesPage(listKind);
    }));
    else section.append(element('p', 'このカテゴリには記録があります。履歴を残すため削除できません。'));
  }

  function categoryEditPage(category: Category, listKind: boolean | null) {
    showPage(category.isIncome ? '収入カテゴリを編集' : '支出カテゴリを編集', () => categoryDetailPage(category, listKind));
    section.append(nameForm('カテゴリ名', category.name, '変更を保存', async name => {
      if (!name) throw new Error('カテゴリ名を入力してください。');
      await ledger.renameCategory(category.id, name);
      await categoryDetailPage({ ...category, name }, listKind);
    }, showFormError));
  }

  async function accountsPage() {
    showPage('支払元・口座残高');
    section.append(button('支払元を追加する', accountCreatePage, true));
    const accounts = await ledger.getAccountBalances();
    const closed = element('details'); closed.className = 'closed-accounts';
    closed.append(element('summary', `利用終了の口座 ${accounts.filter(account => account.closed).length}件`));
    const closedList = element('ul', undefined, 'master-list account-balances'); closed.append(closedList);
    for (const type of Object.keys(accountTypeLabels) as AccountType[]) {
      const group = element('section'); group.dataset.accountType = type;
      const list = element('ul', undefined, 'master-list account-balances');
      group.append(element('h3', accountTypeLabels[type]), list); section.append(group);
      if (type === 'credit_card') group.append(element('p', '差引額は登録した利用と支払いの差です。確定した請求額ではありません。'));
      const open = accounts.filter(account => !account.closed && account.accountType === type);
      if (!open.length) list.append(element('li', '利用中の支払元がありません。'));
      for (const account of accounts.filter(account => account.accountType === type)) {
        const row = element('li', undefined, 'master-row account-balance-row'); row.dataset.accountId = account.id;
        row.append(button(`${account.name} · ${account.closed ? '利用終了' : '利用中'}`, () => accountDetailPage(account)), element('span', accountBalanceLabel(type, account.balanceYen), 'account-balance'));
        (account.closed ? closedList : list).append(row);
      }
    }
    if (accounts.some(account => account.closed)) section.append(closed);
  }

  async function accountTransactionsPage(account: Account) {
    showPage(`${account.name}の記録`, () => accountDetailPage(account));
    const rows = (await ledger.getTransactions({ startDate: '0001-01-01', endDate: '9999-12-31' })).filter(row => row.accountId === account.id);
    const list = element('ul', undefined, 'master-list'); section.append(list);
    if (!rows.length) list.append(element('li', 'この口座の記録はありません。'));
    for (const row of rows) {
      const entry = element('li', undefined, 'master-row');
      const label = `${row.date} · ${row.payeeName || (row.kind === 'income' ? '収入' : row.kind === 'transfer' ? '口座間振替' : '支出')} · ${row.amountYen < 0 ? '−' : '+'}${yen(row.amountYen)}`;
      entry.append(options.onTransaction ? button(label, () => options.onTransaction!(row)) : element('span', label)); list.append(entry);
    }
  }

  function accountCreatePage() {
    showPage('支払元を追加', accountsPage);
    section.append(masterCreationForm(ledger, { kind: 'account' }, async () => { await accountsPage(); }, showFormError));
  }

  async function accountDetailPage(account: Account) {
    showPage('支払元の詳細', accountsPage);
    const usage = await ledger.getAccountUsage(account.id);
    const balance = usage.balanceYen === 0 ? yen(0) : `${usage.balanceYen < 0 ? '−' : '+'}${yen(usage.balanceYen)}`;
    section.append(element('p', `支払元：${account.name}`), element('p', `種類：${accountTypeLabels[account.accountType]}`), element('p', `状態：${account.closed ? '利用終了' : '利用中'}`), element('p', `記録：${usage.transactionCount}件`), element('p', account.accountType === 'credit_card' ? accountBalanceLabel(account.accountType, usage.balanceYen) : `残高：${balance}`));
    section.append(button('口座の記録を見る', () => accountTransactionsPage(account)));
    section.append(button('編集する', () => accountEditPage(account), true));
    if (account.closed) section.append(button('利用を再開する', async () => {
      await ledger.reopenAccount(account.id);
      await accountDetailPage({ ...account, closed: false });
    }));
    else section.append(button('利用終了', async () => {
      await ledger.closeAccount(account.id);
      await accountDetailPage({ ...account, closed: true });
    }));
    if (usage.transactionCount === 0 && usage.balanceYen === 0) {
      const confirmation = element('div', undefined, 'master-delete');
      const label = element('label', `「${account.name}」を完全に削除する場合はチェックしてください。`);
      const checkbox = element('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'master-checkbox';
      const remove = button('完全に削除する', async () => {
        if (!checkbox.checked || !window.confirm(`「${account.name}」を完全に削除します。元に戻せません。`)) return;
        await options.beforeDeleteAccount?.(account.id);
        await ledger.deleteAccount(account.id);
        await accountsPage();
      });
      label.prepend(checkbox);
      confirmation.append(label, remove);
      section.append(confirmation);
    } else section.append(element('p', '記録または残高があります。履歴を残すため完全には削除できません。利用終了にすると、今後の支払元として選ばれなくなります。'));
  }

  function accountEditPage(account: Account) {
    showPage('支払元を編集', () => accountDetailPage(account));
    const typeField = accountTypeField(account.accountType);
    const form = nameForm('支払元の名前', account.name, '変更を保存', async name => {
      if (!name) throw new Error('支払元の名前を入力してください。');
      await ledger.renameAccount(account.id, name);
      const accountType = typeField.select.value as AccountType;
      await ledger.setAccountType(account.id, accountType);
      await accountDetailPage({ ...account, name, accountType });
    }, showFormError);
    form.querySelector('button')!.before(typeField.label, typeField.select);
    section.append(form);
  }

  return Object.assign(() => leaveManagement(), { openAccounts: accountsPage });
}
