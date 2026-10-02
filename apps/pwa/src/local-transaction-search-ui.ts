import type { createActualBrowserLedger } from '../../../src/lib/actual-browser-ledger';
import type { ActualTransaction } from '../../../src/lib/actual-ledger';
import { emptySearchFilters, filterSearchTransactions } from './local-transaction-search';
import type { SearchEntry, TransactionSearchFilters } from './local-transaction-search';
import { recordRow } from './record-row';
import { backLink, pageTitle } from './settings-ui';
import { icon } from './ui-icons';
type Ledger = ReturnType<typeof createActualBrowserLedger>;
const yen = (amount: number) => `¥${Math.abs(amount).toLocaleString('ja-JP')}`;
function node<K extends keyof HTMLElementTagNameMap>(tag: K, value = '') { const result = document.createElement(tag); result.textContent = value; return result; }
function kindLabel(kind: ActualTransaction['kind']) { return kind === 'income' ? '収入' : kind === 'transfer' ? '振替' : '支出'; }
function activeFilters(filters: TransactionSearchFilters, labels: { categories: Map<string, string>; accounts: Map<string, string> }) {
  const active = [filters.keyword.trim() ? `キーワード：${filters.keyword.trim()}` : ''];
  if (filters.startDate || filters.endDate) active.push(`期間：${filters.startDate || '指定なし'}〜${filters.endDate || '指定なし'}`);
  if (filters.kind) active.push(`種類：${kindLabel(filters.kind)}`);
  if (filters.categoryId) active.push(`カテゴリ：${labels.categories.get(filters.categoryId) ?? '選択したカテゴリ'}`);
  if (filters.accountId) active.push(`口座：${labels.accounts.get(filters.accountId) ?? '選択した口座'}`);
  if (filters.minAmountYen !== null || filters.maxAmountYen !== null) active.push(`金額：${filters.minAmountYen?.toLocaleString('ja-JP') ?? '下限なし'}〜${filters.maxAmountYen?.toLocaleString('ja-JP') ?? '上限なし'}円`);
  return active.filter(Boolean);
}

export async function showTransactionSearch(options: {
  view: HTMLElement;
  loadEntries: () => Promise<SearchEntry[]>;
  ledger: Ledger;
  onTransaction: (row: ActualTransaction) => Promise<void>;
  onBack: () => void;
  initialFilters?: TransactionSearchFilters;
  onFiltersChange: (filters: TransactionSearchFilters) => void;
}) {
  const { view, ledger } = options;
  let filters = { ...(options.initialFilters ?? emptySearchFilters) };
  let entries: SearchEntry[] = [];
  const title = pageTitle('記録を検索'); view.replaceChildren(backLink('記録', '検索を閉じる', options.onBack), title);
  const [accounts, categories] = await Promise.all([ledger.listAccounts(), ledger.listCategories()]);
  if (!title.isConnected) return;
  const accountNames = new Map(accounts.map(account => [account.id, account.name]));
  const categoryNames = new Map(categories.map(category => [category.id, category.name]));
  const form = node('form');
  const keywordLabel = node('label', 'キーワード'); keywordLabel.htmlFor = 'transaction-search-keyword'; keywordLabel.className = 'visually-hidden';
  const keyword = node('input'); keyword.id = keywordLabel.htmlFor; keyword.type = 'search'; keyword.autocomplete = 'off'; keyword.maxLength = 200; keyword.value = filters.keyword;
  keyword.placeholder = '店名・メモ・品目で検索';
  const searchField = node('div'); searchField.className = 'search-field'; searchField.append(icon('search'), keyword);
  // docs/UX.md 記録を検索: the conditions show as small buttons that open the detailed fields.
  const chips = node('div'); chips.className = 'search-chips';
  form.append(keywordLabel, searchField, chips);
  const details = node('details'); details.className = 'transaction-search-advanced';
  const advancedSummary = node('summary', '詳細条件'); details.append(advancedSummary);
  const fields = node('div'); fields.className = 'transaction-search-fields';
  fields.append(node('p', '金額は分割品目の金額ではなく、記録全体の金額です。'));
  const dateField = (id: string, labelText: string, value: string) => {
    const label = node('label', labelText); label.htmlFor = id;
    const input = node('input'); input.id = id; input.type = 'date'; input.value = value; fields.append(label, input); return input;
  };
  const start = dateField('transaction-search-start-date', '開始日', filters.startDate);
  const end = dateField('transaction-search-end-date', '終了日', filters.endDate);
  const kindLabelNode = node('label', '種類'); kindLabelNode.htmlFor = 'transaction-search-kind';
  const kind = node('select'); kind.id = kindLabelNode.htmlFor;
  kind.append(new Option('すべて', ''), new Option('支出', 'expense'), new Option('収入', 'income'), new Option('振替', 'transfer')); kind.value = filters.kind;
  const categoryLabel = node('label', 'カテゴリ（非表示を含む）'); categoryLabel.htmlFor = 'transaction-search-category';
  const category = node('select'); category.id = categoryLabel.htmlFor;
  category.append(new Option('すべて', ''), ...categories.map(item => new Option(`${item.name}${item.hidden ? ' · 非表示' : ''}`, item.id)));
  category.value = filters.categoryId;
  const accountLabel = node('label', '口座（利用終了を含む）'); accountLabel.htmlFor = 'transaction-search-account';
  const account = node('select'); account.id = accountLabel.htmlFor;
  account.append(new Option('すべて', ''), ...accounts.map(item => new Option(`${item.name}${item.closed ? ' · 利用終了' : ''}`, item.id)));
  account.value = filters.accountId;
  const minLabel = node('label', '金額の下限（円）'); minLabel.htmlFor = 'transaction-search-min-amount';
  const min = node('input'); min.id = minLabel.htmlFor; min.type = 'number'; min.inputMode = 'numeric'; min.min = '0'; min.step = '1'; min.value = filters.minAmountYen === null ? '' : String(filters.minAmountYen);
  const maxLabel = node('label', '金額の上限（円）'); maxLabel.htmlFor = 'transaction-search-max-amount';
  const max = node('input'); max.id = maxLabel.htmlFor; max.type = 'number'; max.inputMode = 'numeric'; max.min = '0'; max.step = '1'; max.value = filters.maxAmountYen === null ? '' : String(filters.maxAmountYen);
  fields.append(kindLabelNode, kind, categoryLabel, category, accountLabel, account, minLabel, min, maxLabel, max);
  details.append(fields); details.open = false;
  form.append(details);
  const submit = node('button', '検索する'); submit.type = 'submit'; form.append(submit);
  const clear = node('button', '条件をすべて解除'); clear.type = 'button'; clear.className = 'secondary'; form.append(clear);
  const active = node('p'); active.className = 'transaction-search-active visually-hidden'; active.setAttribute('aria-live', 'polite'); form.append(active);
  submit.className = 'search-submit'; clear.className = 'text-button';
  view.append(form);
  const resultsCount = node('span'); resultsCount.id = 'transaction-search-count'; resultsCount.setAttribute('role', 'status');
  const resultsTotal = node('span'); resultsTotal.className = 'num search-total';
  const resultsSummary = node('div'); resultsSummary.className = 'search-summary'; resultsSummary.append(resultsCount, resultsTotal);
  const results = node('ul'); results.id = 'transaction-search-results';
  const resultsSection = node('section'); resultsSection.className = 'surface-section settings-rows'; resultsSection.append(results);
  view.append(resultsSummary, resultsSection);
  function values(): TransactionSearchFilters {
    return { keyword: keyword.value, startDate: start.value, endDate: end.value, kind: kind.value as TransactionSearchFilters['kind'],
      categoryId: category.value, accountId: account.value,
      minAmountYen: min.value.trim() ? Number(min.value) : null, maxAmountYen: max.value.trim() ? Number(max.value) : null };
  }
  function updateActive(next: TransactionSearchFilters) {
    active.textContent = activeFilters(next, { categories: categoryNames, accounts: accountNames }).join(' · ');
    const amount = next.minAmountYen !== null || next.maxAmountYen !== null ? `${next.minAmountYen?.toLocaleString('ja-JP') ?? ''}〜${next.maxAmountYen?.toLocaleString('ja-JP') ?? ''}円` : '';
    const period = next.startDate || next.endDate ? `${next.startDate.slice(5).replace('-', '/') || ''}〜${next.endDate.slice(5).replace('-', '/') || ''}` : '';
    const chipItems: Array<[string, string, HTMLElement]> = [
      ['期間', period, start], ['種類', next.kind ? kindLabel(next.kind) : '', kind], ['カテゴリ', next.categoryId ? categoryNames.get(next.categoryId) ?? '' : '', category],
      ['口座', next.accountId ? accountNames.get(next.accountId) ?? '' : '', account], ['金額', amount, min],
    ];
    chips.replaceChildren(...chipItems.map(([label, value, field]) => {
      const chip = node('button', value ? `${label}：${value}` : label); chip.type = 'button'; chip.className = 'chip';
      chip.setAttribute('aria-pressed', String(Boolean(value)));
      chip.append(icon('chevronDown'));
      chip.addEventListener('click', () => { details.open = true; field.focus(); });
      return chip;
    }));
  }
  function render(next: TransactionSearchFilters) {
    const rows = filterSearchTransactions(entries, next);
    filters = { ...next }; options.onFiltersChange({ ...filters }); updateActive(filters);
    details.open = false;
    results.replaceChildren(); resultsCount.textContent = `${rows.length}件`;
    const total = rows.filter(row => row.kind !== 'transfer').reduce((sum, row) => sum + row.amountYen, 0);
    resultsTotal.textContent = rows.length && total ? `${total < 0 ? '−' : '+'}${yen(total)}` : '';
    if (!rows.length) results.append(Object.assign(node('li', entries.length ? '条件に一致する記録はありません。' : '記録がありません。'), { className: 'empty muted' }));
    for (const row of rows) {
      const where = row.kind === 'transfer' && row.transferAccountId ? `振替先 ${accountNames.get(row.transferAccountId) ?? '利用不可'}` : accountNames.get(row.accountId) ?? null;
      const item = node('li');
      const control = recordRow(row, where, () => {
        void options.onTransaction(row).catch(error => { resultsCount.textContent = error instanceof Error ? error.message : '記録を開けませんでした。'; });
      });
      control.classList.add('transaction-search-result');
      item.append(control); results.append(item);
    }
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    submit.disabled = true; resultsCount.textContent = '検索しています。';
    try { render(values()); }
    catch (error) { resultsCount.textContent = error instanceof Error ? error.message : '検索条件を確認してください。'; results.replaceChildren(); }
    finally { submit.disabled = false; }
  });
  clear.addEventListener('click', () => {
    keyword.value = ''; start.value = ''; end.value = ''; kind.value = ''; category.value = ''; account.value = ''; min.value = ''; max.value = '';
    details.open = false; render({ ...emptySearchFilters });
  });
  submit.disabled = true; resultsCount.textContent = '検索結果を読み込んでいます。';
  entries = await options.loadEntries();
  if (!title.isConnected) return;
  submit.disabled = false;
  render(filters);
}
