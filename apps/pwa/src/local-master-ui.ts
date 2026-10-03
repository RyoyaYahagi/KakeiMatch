import { accountTypeField, accountTypeLabels, accountBalanceLabel, type AccountType } from './local-account-ui';
import type { ActualTransaction } from '../../../src/lib/actual-ledger';
import type { createActualBrowserLedger } from '../../../src/lib/actual-browser-ledger';
import { CATEGORY_LABELS } from '../../../src/lib/category';
import type { StatementProvider } from './statement-parser';
import { categoryRank, categoryTone } from './category-tone';
import { recordRow } from './record-row';
import { backLink, detailHero, detailList, entryRow, groupTitle, pageActions, pageTitle, rowList } from './settings-ui';
import { icon, type IconName } from './ui-icons';

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
  options: {
    onBack: () => void;
    onTransaction?: (transaction: ActualTransaction) => Promise<void>;
    beforeDeleteAccount?: (id: string) => Promise<void>;
    beforeDeleteCategory?: (id: string) => Promise<void>;
    getStatementProvider?: (id: string) => Promise<StatementProvider | null>;
    setStatementProvider?: (id: string, provider: StatementProvider | null, accountType: AccountType) => Promise<void>;
  },
): (() => void) & { openAccounts: () => Promise<void> } {
  const section = element('section');
  section.className = 'master-settings';
  section.hidden = true;
  container.after(section);
  const settingsStatus = element('p', '', 'master-status');
  settingsStatus.dataset.masterSettingsStatus = 'true';
  settingsStatus.setAttribute('role', 'status');
  settingsStatus.hidden = true;
  container.prepend(settingsStatus);
  const parent = container.parentElement;
  const originalHidden = new Map<HTMLElement, boolean>();
  let managing = false;

  function showError(error: unknown) {
    const status = section.querySelector<HTMLElement>('[data-master-status]');
    if (status) { status.textContent = errorMessage(error); status.classList.add('error'); }
  }
  function clearSettingsError() {
    settingsStatus.textContent = '';
    settingsStatus.classList.remove('error');
    settingsStatus.hidden = true;
  }
  function showSettingsError(error: unknown) {
    settingsStatus.textContent = errorMessage(error);
    settingsStatus.classList.add('error');
    settingsStatus.hidden = false;
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
  // Each page render takes a number; a render that finishes after another page opened draws nothing.
  let pageRevision = 0;
  function leaveManagement() {
    pageRevision++;
    section.hidden = true;
    for (const [node, hidden] of originalHidden) node.hidden = hidden;
    originalHidden.clear();
    managing = false;
  }
  /** docs/UX.md 設定の奥の画面: back link at the top left, then the title. Lists go back to settings, other pages to their parent. */
  function beginPage() { return ++pageRevision; }
  function showPage(title: string, returnTo?: { label: string; open: () => Promise<void> | void }, revision = beginPage()) {
    if (revision !== pageRevision) return revision;
    enterManagement();
    section.replaceChildren();
    const back = returnTo
      ? backLink(returnTo.label, '一覧へ戻る', () => Promise.resolve().then(returnTo.open).catch(showError))
      : backLink('設定', '設定へ戻る', () => { leaveManagement(); options.onBack(); });
    section.append(back, pageTitle(title));
    const status = element('p', '', 'master-status');
    status.dataset.masterStatus = 'true';
    status.setAttribute('role', 'status');
    section.append(status);
    return revision;
  }
  const isCurrent = (revision: number) => revision === pageRevision && !section.hidden;
  function showFormError(error: unknown) { showError(error); }
  const run = (action: () => Promise<void> | void) => () => Promise.resolve().then(action).catch(showError);
  function primaryAction(label: string, iconName: 'add' | 'pencil' | null, action: () => Promise<void> | void, spokenName?: string) {
    const node = button(label, action, true);
    if (iconName) node.prepend(icon(iconName));
    if (spokenName && spokenName !== label) node.setAttribute('aria-label', spokenName);
    return node;
  }
  function quietAction(label: string, action: () => Promise<void> | void, danger = false) {
    const node = button(label, action); node.className = `text-button${danger ? ' destructive-text' : ''}`;
    return node;
  }

  const categoryEntry = button('カテゴリ', () => categoriesPage(false));
  categoryEntry.classList.add('master-entry');
  categoryEntry.setAttribute('aria-label', 'カテゴリ');
  const accountEntry = button('支払元', accountsPage);
  accountEntry.classList.add('master-entry');
  accountEntry.setAttribute('aria-label', '支払元');
  container.append(categoryEntry, accountEntry);

  async function categoriesPage(kind: boolean | null = false) {
    const enteringFromSettings = !managing;
    const page = enteringFromSettings ? beginPage() : showPage('カテゴリ');
    if (enteringFromSettings) clearSettingsError();
    const appendSwitcher = () => {
      const switcher = element('div', undefined, 'segmented master-switcher'); switcher.setAttribute('role', 'group'); switcher.setAttribute('aria-label', 'カテゴリの種類');
      const expenses = button('支出', () => categoriesPage(false)); expenses.className = ''; expenses.setAttribute('aria-label', '支出カテゴリ');
      const income = button('収入', () => categoriesPage(true)); income.className = ''; income.setAttribute('aria-label', '収入カテゴリ');
      expenses.setAttribute('aria-pressed', String(kind === false));
      income.setAttribute('aria-pressed', String(kind === true));
      switcher.append(expenses, income);
      section.append(switcher);
    };
    if (!enteringFromSettings) appendSwitcher();
    let categories: Category[];
    let usage: Map<string, number>;
    try {
      categories = (await ledger.listCategories()).filter(row => kind === null || row.isIncome === kind);
      usage = new Map(await Promise.all(categories.map(async category => [category.id, await ledger.getCategoryUsage(category.id)] as const)));
    } catch (error) {
      if (page !== pageRevision) return;
      if (enteringFromSettings) showSettingsError(error);
      else if (isCurrent(page)) showError(error);
      return;
    }
    if (enteringFromSettings) {
      if (page !== pageRevision) return;
      showPage('カテゴリ', undefined, page);
      appendSwitcher();
    } else if (!isCurrent(page)) return;
    // Frequently used categories first, the same order as the category buttons in the entry forms.
    const ordered = [...categories].sort((a, b) => Number(a.hidden) - Number(b.hidden) || (usage.get(b.id) ?? 0) - (usage.get(a.id) ?? 0) || categoryRank(a.name) - categoryRank(b.name));
    const rows = ordered.map(category => {
      const tone = categoryTone(category.name, category.id);
      return entryRow({ icon: tone.icon, tone: tone.tone, title: category.name, dimmed: category.hidden,
        note: `記録 ${usage.get(category.id) ?? 0}件${category.hidden ? ' · 非表示' : ''}`,
        spokenName: `${category.name} · ${category.hidden ? '非表示' : '表示中'} · ${category.groupName}`,
        onClick: run(() => categoryDetailPage(category, kind)) });
    });
    if (rows.length) section.append(rowList(rows, 'master-list'));
    else section.append(element('p', 'カテゴリがありません。', 'muted'));
    if (kind === false) {
      const starter = quietAction('基本カテゴリを用意する', async () => {
        const existing = await ledger.listCategories();
        const names = new Set(existing.filter(row => !row.isIncome).map(row => row.name));
        for (const name of Object.values(CATEGORY_LABELS)) if (!names.has(name)) await ledger.addCategory(name, false);
        await categoriesPage(false);
        const status = section.querySelector<HTMLElement>('[data-master-status]');
        if (status) status.textContent = '基本カテゴリを用意しました。';
      });
      section.append(starter);
    }
    section.append(element('p', '記録が多い順に並びます。入力画面のボタンも同じ順です。', 'muted settings-footnote'));
    section.append(pageActions(primaryAction('カテゴリを追加', 'add', () => categoryCreatePage(kind), 'カテゴリを追加する')));
  }

  async function categoryCreatePage(kind: boolean | null) {
    const isIncome = kind ?? false;
    showPage(isIncome ? '収入カテゴリを追加' : '支出カテゴリを追加', { label: 'カテゴリ', open: () => categoriesPage(kind) });
    section.append(masterCreationForm(ledger, { kind: 'category', isIncome }, async () => { await categoriesPage(isIncome); }, showFormError));
  }

  async function categoryDetailPage(category: Category, listKind: boolean | null) {
    const page = showPage(category.isIncome ? '収入カテゴリの詳細' : '支出カテゴリの詳細', { label: 'カテゴリ', open: () => categoriesPage(listKind) });
    const yearMonth = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);
    const [usage, summary] = await Promise.all([ledger.getCategoryUsage(category.id), ledger.getMonthlySummary({ yearMonth })]);
    if (!isCurrent(page)) return;
    const monthAmount = summary.categories.find(row => row.categoryId === category.id)?.amountYen ?? 0;
    const tone = categoryTone(category.name, category.id);
    section.append(detailHero(tone.icon, tone.tone, category.name, `${category.isIncome ? '収入' : '支出'}のカテゴリ · ${category.hidden ? '非表示' : '入力の候補に表示中'}`));
    const details = detailList([['種類', category.isIncome ? '収入' : '支出'], ['グループ', category.groupName], ['状態', category.hidden ? '非表示' : '表示中'],
      [category.isIncome ? '今月の収入' : '今月の支出', yen(monthAmount)], ['使われている記録', `${usage}件`]]);
    section.append(details);
    const visibilityLabel = category.hidden ? 'カテゴリを表示する' : 'カテゴリを非表示にする';
    section.append(rowList([entryRow({ icon: 'eyeOff', tone: 'other', title: visibilityLabel, spokenName: visibilityLabel,
      note: category.hidden ? '入力の候補にもう一度表示します' : '入力の候補から隠します。過去の記録はそのまま残ります',
      onClick: run(async () => {
        await ledger.setCategoryHidden(category.id, !category.hidden);
        const updated = (await ledger.listCategories()).find(row => row.id === category.id) ?? { ...category, hidden: !category.hidden };
        await categoryDetailPage(updated, listKind);
        if (category.hidden && updated.hidden) {
          const status = section.querySelector<HTMLElement>('[data-master-status]');
          if (status) status.textContent = 'カテゴリのグループが非表示のため、グループ側の設定も確認してください。';
        }
      }) })]));
    const actions = [primaryAction('編集する', 'pencil', () => categoryEditPage(category, listKind))];
    if (usage === 0) actions.push(quietAction('カテゴリを削除する', async () => {
      if (!window.confirm(`「${category.name}」を削除しますか？`)) return;
      await options.beforeDeleteCategory?.(category.id);
      await ledger.deleteCategory(category.id);
      await categoriesPage(listKind);
    }, true));
    else section.append(element('p', 'このカテゴリには記録があります。履歴を残すため削除できません。', 'muted settings-footnote'));
    section.append(pageActions(...actions));
  }

  function categoryEditPage(category: Category, listKind: boolean | null) {
    showPage(category.isIncome ? '収入カテゴリを編集' : '支出カテゴリを編集', { label: category.name, open: () => categoryDetailPage(category, listKind) });
    section.append(nameForm('カテゴリ名', category.name, '変更を保存', async name => {
      if (!name) throw new Error('カテゴリ名を入力してください。');
      await ledger.renameCategory(category.id, name);
      await categoryDetailPage({ ...category, name }, listKind);
    }, showFormError));
  }

  const accountIcons: Record<AccountType, IconName> = { credit_card: 'card', bank: 'bank', cash: 'wallet', other: 'tag' };
  const accountTones: Record<AccountType, string> = { credit_card: 'transport', bank: 'daily', cash: 'util', other: 'other' };

  async function accountsPage() {
    const enteringFromSettings = !managing;
    const page = enteringFromSettings ? beginPage() : showPage('支払元・口座');
    if (enteringFromSettings) clearSettingsError();
    let accounts: Awaited<ReturnType<Ledger['getAccountBalances']>>;
    let providers: Map<string, StatementProvider | null>;
    try {
      accounts = await ledger.getAccountBalances();
      providers = new Map(await Promise.all(accounts.map(async account => [account.id, await options.getStatementProvider?.(account.id) ?? null] as const)));
    } catch (error) {
      if (page !== pageRevision) return;
      if (enteringFromSettings) showSettingsError(error);
      else if (isCurrent(page)) showError(error);
      return;
    }
    if (enteringFromSettings) {
      if (page !== pageRevision) return;
      showPage('支払元・口座', undefined, page);
    } else if (!isCurrent(page)) return;
    const open = accounts.filter(account => !account.closed);
    const total = open.reduce((sum, account) => sum + account.balanceYen, 0);
    const totalCard = element('div', undefined, 'surface-section account-total');
    totalCard.append(element('span', '利用中の口座の合計', 'muted'), element('strong', `${total < 0 ? '−' : ''}${yen(total)}`));
    section.append(totalCard);
    const rowFor = (account: (typeof accounts)[number]) => {
      const provider = providers.get(account.id);
      const row = entryRow({ icon: accountIcons[account.accountType], tone: accountTones[account.accountType], title: account.name, dimmed: account.closed,
        note: [provider ? `明細：${statementProviderLabels[provider]}` : accountTypeLabels[account.accountType], account.closed ? '利用終了' : ''].filter(Boolean).join(' · '),
        value: accountBalanceLabel(account.accountType, account.balanceYen), valueClass: 'account-balance',
        spokenName: `${account.name} · ${account.closed ? '利用終了' : '利用中'}`, onClick: run(() => accountDetailPage(account)) });
      row.dataset.accountId = account.id;
      row.classList.add('account-balance-row');
      return row;
    };
    for (const type of Object.keys(accountTypeLabels) as AccountType[]) {
      const rows = open.filter(account => account.accountType === type);
      if (!rows.length) continue;
      const group = element('div', undefined, 'account-group'); group.dataset.accountType = type;
      group.append(groupTitle(accountTypeLabels[type]), rowList(rows.map(rowFor), 'master-list account-balances'));
      if (type === 'credit_card') group.append(element('p', '差引額は登録した利用と支払いの差です。確定した請求額ではありません。', 'muted settings-footnote'));
      section.append(group);
    }
    if (!open.length) section.append(element('p', '利用中の支払元がありません。', 'muted'));
    const closedAccounts = accounts.filter(account => account.closed);
    if (closedAccounts.length) {
      const closed = element('details', undefined, 'closed-accounts surface-section settings-disclosure');
      closed.append(element('summary', `利用終了の口座 ${closedAccounts.length}件`), rowList(closedAccounts.map(rowFor), 'master-list account-balances'));
      section.append(closed);
    }
    section.append(pageActions(primaryAction('支払元を追加する', 'add', accountCreatePage)));
  }

  async function accountTransactionsPage(account: Account) {
    const page = showPage(`${account.name}の記録`, { label: account.name, open: () => accountDetailPage(account) });
    const rows = (await ledger.getTransactions({ startDate: '0001-01-01', endDate: '9999-12-31' })).filter(row => row.accountId === account.id);
    if (!isCurrent(page)) return;
    if (!rows.length) { section.append(element('p', 'この口座の記録はありません。', 'muted')); return; }
    const list = rows.map(row => recordRow(row, null, () => { void options.onTransaction?.(row).catch(showError); }));
    section.append(rowList(list, 'master-list'));
  }

  function accountCreatePage() {
    showPage('支払元を追加', { label: '支払元・口座', open: accountsPage });
    section.append(masterCreationForm(ledger, { kind: 'account' }, async () => { await accountsPage(); }, showFormError));
  }

  async function accountDetailPage(account: Account) {
    const page = showPage('支払元の詳細', { label: '支払元・口座', open: accountsPage });
    const [usage, statementProvider, recent] = await Promise.all([ledger.getAccountUsage(account.id), options.getStatementProvider?.(account.id) ?? Promise.resolve(null), ledger.getRecentTransactions({ limit: 100 })]);
    if (!isCurrent(page)) return;
    const balance = account.accountType === 'credit_card' ? accountBalanceLabel(account.accountType, usage.balanceYen)
      : usage.balanceYen === 0 ? yen(0) : `${usage.balanceYen < 0 ? '−' : '+'}${yen(usage.balanceYen)}`;
    section.append(detailHero(accountIcons[account.accountType], accountTones[account.accountType], account.name, `${accountTypeLabels[account.accountType]} · ${account.closed ? '利用終了' : '利用中'}`));
    const balanceValue = element('span', balance, 'detail-amount-value');
    section.append(detailList([[account.accountType === 'credit_card' ? '差引額' : '残高', balanceValue], ['種類', accountTypeLabels[account.accountType]],
      ['明細サービス', statementProvider ? statementProviderLabels[statementProvider] : '未設定'], ['状態', account.closed ? '利用終了' : '利用中'], ['記録', `${usage.transactionCount}件`]]));
    const latest = recent.filter(row => row.accountId === account.id).slice(0, 2);
    section.append(groupTitle('最近の記録'));
    const rows = latest.map(row => recordRow(row, null, () => { void options.onTransaction?.(row).catch(showError); }));
    const all = button('口座の記録を見る', () => accountTransactionsPage(account)); all.className = 'text-button link-row-center';
    section.append(rowList([...rows, all], 'master-list'));
    if (!latest.length) section.querySelector('.settings-rows ul')?.prepend(Object.assign(element('li', 'この口座の記録はありません。', 'muted empty')));
    const actions = [primaryAction('編集する', 'pencil', () => accountEditPage(account))];
    if (account.closed) actions.push(quietAction('利用を再開する', async () => {
      await ledger.reopenAccount(account.id);
      await accountDetailPage({ ...account, closed: false });
    }));
    else actions.push(quietAction('利用終了', async () => {
      await ledger.closeAccount(account.id);
      await accountDetailPage({ ...account, closed: true });
    }));
    if (usage.transactionCount === 0 && usage.balanceYen === 0) {
      const confirmation = element('details', undefined, 'master-delete surface-section settings-disclosure danger-zone');
      const label = element('label', `「${account.name}」を完全に削除する場合はチェックしてください。`);
      const checkbox = element('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'master-checkbox';
      const remove = quietAction('完全に削除する', async () => {
        if (!checkbox.checked || !window.confirm(`「${account.name}」を完全に削除します。元に戻せません。`)) return;
        await options.beforeDeleteAccount?.(account.id);
        await ledger.deleteAccount(account.id);
        await accountsPage();
      }, true);
      label.prepend(checkbox);
      confirmation.append(element('summary', 'この支払元を削除する'), label, remove);
      confirmation.open = true;
      section.append(confirmation);
    } else section.append(element('p', '記録または残高があります。履歴を残すため完全には削除できません。利用終了にすると、今後の支払元として選ばれなくなります。', 'muted settings-footnote'));
    section.append(pageActions(...actions));
  }

  const statementProviderLabels: Record<StatementProvider, string> = {
    smbc_card: '三井住友カード', rakuten_card: '楽天カード', aeon_card: 'イオンカード', paypay: 'PayPay取引履歴（旧形式）', paypay_card: 'PayPayカード',
  };

  async function accountEditPage(account: Account) {
    const page = showPage('支払元を編集', { label: account.name, open: () => accountDetailPage(account) });
    const typeField = accountTypeField(account.accountType);
    const providerLabel = element('label', '明細サービス');
    const provider = element('select'); provider.name = 'statementProvider'; provider.id = `account-provider-${crypto.randomUUID()}`; providerLabel.htmlFor = provider.id;
    const currentProvider = await options.getStatementProvider?.(account.id) ?? '';
    if (!isCurrent(page)) return;
    const legacyPaypay = currentProvider === 'paypay' ? new Option('PayPay取引履歴（旧形式・再取込不可）', 'paypay') : null;
    if (legacyPaypay) legacyPaypay.disabled = true;
    provider.append(new Option('設定しない', ''), ...(legacyPaypay ? [legacyPaypay] : []), ...(['smbc_card', 'rakuten_card', 'paypay_card'] as const).map(value => new Option(statementProviderLabels[value], value)));
    provider.value = currentProvider;
    const providerField = element('div'); providerField.append(providerLabel, provider);
    const updateProviderVisibility = () => { providerField.hidden = typeField.select.value === 'cash'; if (providerField.hidden) provider.value = ''; };
    typeField.select.addEventListener('change', updateProviderVisibility);
    const form = nameForm('支払元の名前', account.name, '変更を保存', async name => {
      if (!name) throw new Error('支払元の名前を入力してください。');
      await ledger.renameAccount(account.id, name);
      const accountType = typeField.select.value as AccountType;
      await ledger.setAccountType(account.id, accountType);
      await options.setStatementProvider?.(account.id, accountType === 'cash' || !provider.value ? null : provider.value as StatementProvider, accountType);
      await accountDetailPage({ ...account, name, accountType });
    }, showFormError);
    form.querySelector('button')!.before(typeField.label, typeField.select, providerField);
    updateProviderVisibility();
    section.append(form);
  }

  return Object.assign(() => leaveManagement(), { openAccounts: accountsPage });
}
