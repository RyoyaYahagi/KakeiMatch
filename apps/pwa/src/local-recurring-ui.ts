import { accountOptions } from './local-account-ui';
import { categoryTone } from './category-tone';
import { backLink, detailHero, detailList, entryRow, pageActions, pageTitle, rowList } from './settings-ui';
import { icon } from './ui-icons';
import type { createActualBrowserLedger, RecurringSchedule, RecurringScheduleInput } from '../../../src/lib/actual-browser-ledger';
type Ledger = ReturnType<typeof createActualBrowserLedger>;
type Service = {
  pending(): Promise<unknown | null>;
  save(input: RecurringScheduleInput, id?: string): Promise<void>;
  remove(id: string): Promise<void>;
  retry(): Promise<void>;
};
type Account = Awaited<ReturnType<Ledger['listOpenAccounts']>>[number];
type Category = Awaited<ReturnType<Ledger['listExpenseCategories']>>[number];
const yen = (amount: number) => `¥${Math.abs(amount).toLocaleString('ja-JP')}`;
function node<K extends keyof HTMLElementTagNameMap>(tag: K, value = '') { const result = document.createElement(tag); result.textContent = value; return result; }
function button(label: string, action: () => void | Promise<void>, primary = false) {
  const result = node('button', label); result.type = 'button'; if (!primary) result.className = 'secondary';
  result.addEventListener('click', () => {
    result.disabled = true;
    void Promise.resolve().then(action).catch(error => { result.textContent = errorText(error); }).finally(() => { result.disabled = false; });
  }); return result;
}
function frequencyLabel(value: RecurringScheduleInput['frequency']) { return value === 'weekly' ? '毎週' : value === 'yearly' ? '毎年' : '毎月'; }
function errorText(error: unknown) { return error instanceof Error && /[ぁ-んァ-ヶ一-龠]/.test(error.message) ? error.message : '定期登録を保存できませんでした。入力内容を確認してください。'; }

export async function showRecurringSchedules(options: {
  view: HTMLElement;
  ledger: Ledger;
  service: Service;
  onBack: () => void;
}) {
  const { view, ledger, service } = options;
  async function loadMasters(kind: RecurringScheduleInput['kind']): Promise<{ accounts: Account[]; categories: Category[] }> {
    const [accounts, categories] = await Promise.all([
      ledger.listOpenAccounts(), kind === 'income' ? ledger.listIncomeCategories() : ledger.listExpenseCategories(),
    ]);
    return { accounts, categories };
  }
  async function overview(message = '') {
    view.replaceChildren(backLink('設定', '設定へ戻る', options.onBack), pageTitle('定期登録'));
    const status = node('p', message); status.setAttribute('role', 'status'); status.className = 'status'; view.append(status);
    view.append(Object.assign(node('p', '決まった日に自動で記録します。'), { className: 'muted settings-footnote' }));
    const pending = await service.pending();
    if (pending) {
      const notice = node('div'); notice.className = 'notice notice-danger';
      notice.append(node('p', '前回の定期登録処理が保留中です。再試行してください。'), button('再試行する', async () => {
        status.textContent = '再試行しています。';
        try { await service.retry(); if (await service.pending()) { status.textContent = '処理がまだ保留中です。もう一度お試しください。'; return; } await overview('定期登録を復旧しました。'); }
        catch (error) { status.textContent = errorText(error); }
      }, true));
      view.append(notice);
    }
    const [schedules, accounts, categories] = await Promise.all([ledger.listRecurringSchedules(), ledger.listAccounts(), ledger.listCategories()]);
    const accountNames = new Map(accounts.map(item => [item.id, item.name]));
    const categoryNames = new Map(categories.map(item => [item.id, item.name]));
    const rows = schedules.map(schedule => {
      const categoryName = categoryNames.get(schedule.categoryId) ?? 'カテゴリなし';
      const tone = schedule.kind === 'income' ? { icon: 'income' as const, tone: 'income' } : categoryTone(categoryName, schedule.categoryId);
      const note = schedule.editable
        ? `${categoryName} · ${accountNames.get(schedule.accountId) ?? '口座なし'} · ${frequencyLabel(schedule.frequency)} · 次回 ${schedule.nextDate ?? '未定'} · 自動登録 ${schedule.postsTransaction ? 'オン' : 'オフ'}${schedule.completed ? ' · 終了済み' : ''}`
        : `未対応の予定条件を含むため編集できません · ${schedule.completed ? '終了済み' : '継続中'}`;
      return entryRow({ icon: tone.icon, tone: tone.tone, title: schedule.name, note, dimmed: schedule.completed,
        value: schedule.editable ? `${schedule.kind === 'income' ? '+' : '−'}${yen(schedule.amountYen)}` : undefined, valueClass: schedule.kind === 'income' ? 'amount-income' : '',
        spokenName: schedule.editable ? `${schedule.name} · ${schedule.kind === 'income' ? '収入' : '支出'} ${yen(schedule.amountYen)}` : `${schedule.name} · 未対応の予定条件`,
        onClick: () => detail(schedule, accountNames, categoryNames).catch(error => { status.textContent = errorText(error); }) });
    });
    if (rows.length) view.append(rowList(rows, 'recurring-list'));
    else view.append(Object.assign(node('p', '定期登録はありません。'), { className: 'muted' }));
    const create = button('定期登録を追加', () => editor(), true); create.setAttribute('aria-label', '定期登録を追加する');
    create.prepend(icon('add')); create.disabled = Boolean(pending);
    view.append(pageActions(create));
  }
  async function detail(schedule: RecurringSchedule, accountNames?: Map<string, string>, categoryNames?: Map<string, string>) {
    view.replaceChildren(backLink('定期登録', '一覧へ戻る', () => overview()));
    const status = node('p'); status.setAttribute('role', 'status'); status.className = 'status'; view.append(status);
    accountNames ??= new Map((await ledger.listAccounts()).map(item => [item.id, item.name]));
    categoryNames ??= new Map((await ledger.listCategories()).map(item => [item.id, item.name]));
    const categoryName = categoryNames.get(schedule.categoryId) ?? '利用できません';
    const tone = schedule.kind === 'income' ? { icon: 'income' as const, tone: 'income' } : categoryTone(categoryName, schedule.categoryId);
    const heading = detailHero(tone.icon, tone.tone, schedule.name, `${schedule.kind === 'income' ? '収入' : '支出'}の定期登録 · ${schedule.completed ? '終了済み' : '継続中'}`);
    heading.querySelector('.detail-hero-title')?.setAttribute('role', 'heading');
    heading.querySelector('.detail-hero-title')?.setAttribute('aria-level', '2');
    view.append(heading);
    if (schedule.editable) view.append(detailList([['金額', yen(schedule.amountYen)], ['カテゴリ', categoryName], ['口座', accountNames.get(schedule.accountId) ?? '利用できません'],
      ['頻度', frequencyLabel(schedule.frequency)], ['開始日', schedule.startDate], ['次回', schedule.nextDate ?? '未定'], ['自動登録', schedule.postsTransaction ? 'オン' : 'オフ']], 'recurring-detail'));
    else view.append(Object.assign(node('p', 'この定期登録には画面で扱えない予定条件があります。金額や頻度を正確に表示できません。金額や頻度などの条件は編集できません。削除して作り直してください。'), { className: 'muted' }));
    const remove = button('削除する', async () => {
      if (!window.confirm('この定期登録を削除しますか？すでに作成された取引は残ります。')) return;
      try { await service.remove(schedule.id); await overview('定期登録を削除しました。生成済みの取引は残っています。'); }
      catch (error) { status.textContent = errorText(error); }
    }); remove.className = 'text-button destructive-text';
    const actions = schedule.editable ? [button('編集する', () => editor(schedule), true), remove] : [remove];
    if (schedule.editable) actions[0].prepend(icon('pencil'));
    view.append(pageActions(...actions));
  }
  async function editor(existing?: RecurringSchedule) {
    let kind = existing?.kind ?? 'expense';
    const masters = await loadMasters(kind);
    view.replaceChildren(backLink(existing ? existing.name : '定期登録', '一覧へ戻る', () => existing ? detail(existing) : overview()), pageTitle(existing ? '定期登録を編集' : '定期登録を追加'));
    const status = node('p'); status.setAttribute('role', 'status'); view.append(status);
    const form = node('form');
    const nameLabel = node('label', '名前'); nameLabel.htmlFor = 'recurring-name';
    const name = node('input'); name.id = 'recurring-name'; name.required = true; name.maxLength = 200; name.value = existing?.name ?? '';
    const kindLabel = node('label', '種類'); kindLabel.htmlFor = 'recurring-kind';
    const kindSelect = node('select'); kindSelect.id = 'recurring-kind';
    kindSelect.append(new Option('支出', 'expense'), new Option('収入', 'income')); kindSelect.value = kind;
    const amountLabel = node('label', '金額（円）'); amountLabel.htmlFor = 'recurring-amount';
    const amount = node('input'); amount.id = 'recurring-amount'; amount.type = 'number'; amount.inputMode = 'numeric'; amount.min = '1'; amount.step = '1'; amount.required = true; amount.value = existing ? String(existing.amountYen) : '';
    const categoryLabel = node('label', 'カテゴリ'); categoryLabel.htmlFor = 'recurring-category';
    const category = node('select'); category.id = 'recurring-category'; category.required = true;
    const accountLabel = node('label', '口座'); accountLabel.htmlFor = 'recurring-account';
    const account = node('select'); account.id = 'recurring-account'; account.required = true;
    const frequencyLabelNode = node('label', '頻度'); frequencyLabelNode.htmlFor = 'recurring-frequency';
    const frequency = node('select'); frequency.id = 'recurring-frequency';
    frequency.append(new Option('毎月', 'monthly'), new Option('毎週', 'weekly'), new Option('毎年', 'yearly')); frequency.value = existing?.frequency ?? 'monthly';
    const startLabel = node('label', '開始日'); startLabel.htmlFor = 'recurring-start-date';
    const start = node('input'); start.id = 'recurring-start-date'; start.type = 'date'; start.required = true; start.value = existing?.startDate ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date());
    const autoLabel = node('label', '予定日に自動登録する'); autoLabel.htmlFor = 'recurring-auto';
    const auto = node('input'); auto.id = 'recurring-auto'; auto.type = 'checkbox'; auto.checked = existing?.postsTransaction ?? true;
    let categoryLoadRevision = 0;
    function updateOptions() {
      kind = kindSelect.value as RecurringScheduleInput['kind'];
      const selectedCategory = category.value; const selectedAccount = account.value;
      const revision = ++categoryLoadRevision;
      category.disabled = true;
      void loadMasters(kind).then(next => {
        if (revision !== categoryLoadRevision) return;
        category.replaceChildren(new Option('選択してください', ''), ...next.categories.map(item => new Option(item.name, item.id)));
        category.value = next.categories.some(item => item.id === selectedCategory) ? selectedCategory : '';
        account.replaceChildren(new Option('選択してください', ''), ...accountOptions(next.accounts, kind));
        account.value = next.accounts.some(item => item.id === selectedAccount) ? selectedAccount : '';
      }).catch(error => { if (revision === categoryLoadRevision) status.textContent = errorText(error); })
        .finally(() => { if (revision === categoryLoadRevision) category.disabled = false; });
    }
    kindSelect.addEventListener('change', updateOptions);
    category.replaceChildren(new Option('選択してください', ''), ...masters.categories.map(item => new Option(item.name, item.id)));
    account.replaceChildren(new Option('選択してください', ''), ...accountOptions(masters.accounts, kind));
    if (existing) { category.value = existing.categoryId; account.value = existing.accountId; }
    const submit = node('button', '保存する'); submit.type = 'submit';
    form.append(nameLabel, name, kindLabel, kindSelect, amountLabel, amount, categoryLabel, category, accountLabel, account,
      frequencyLabelNode, frequency, startLabel, start, autoLabel, auto, submit);
    const retry = button('再試行する', async () => {
      status.textContent = '再試行しています。';
      try { await service.retry(); if (await service.pending()) { status.textContent = '処理がまだ保留中です。もう一度お試しください。'; return; } await overview('定期登録を保存しました。'); }
      catch (error) { status.textContent = errorText(error); }
    }); retry.hidden = true; form.append(retry);
    form.addEventListener('submit', event => {
      event.preventDefault();
      const input: RecurringScheduleInput = { name: name.value.trim(), kind, amountYen: Number(amount.value), categoryId: category.value,
        accountId: account.value, frequency: frequency.value as RecurringScheduleInput['frequency'], startDate: start.value, postsTransaction: auto.checked };
      const controls = Array.from(form.elements).filter((control): control is HTMLInputElement | HTMLSelectElement | HTMLButtonElement => control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLButtonElement);
      for (const control of controls) control.disabled = true;
      status.textContent = '保存しています。';
      void service.save(input, existing?.id).then(() => overview('定期登録を保存しました。')).catch(async error => {
        status.textContent = errorText(error);
        if (await service.pending()) {
          retry.hidden = false; retry.disabled = false;
        } else for (const control of controls) control.disabled = control === retry;
      });
    });
    view.append(form);
  }
  await overview();
}
