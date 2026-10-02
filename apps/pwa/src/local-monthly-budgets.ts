import type { createActualBrowserLedger } from '../../../src/lib/actual-browser-ledger';
import { shiftMonth } from './local-monthly-dashboard';
import type { LocalMonthlyBudgetService, MonthlyBudgetSummary } from './local-monthly-budget-service';
type Ledger = ReturnType<typeof createActualBrowserLedger>;
const yen = (value: number) => `${value < 0 ? '−' : ''}¥${Math.abs(value).toLocaleString('ja-JP')}`;
function node<K extends keyof HTMLElementTagNameMap>(tag: K, value = '') { const result = document.createElement(tag); result.textContent = value; return result; }
function button(label: string, action: () => void) { const result = node('button', label); result.type = 'button'; result.className = 'secondary'; result.addEventListener('click', action); return result; }
function amountLine(value: { budgetYen: number; spentYen: number; remainingYen: number; usageRatio: number | null }) {
  return `${yen(value.spentYen)} / ${yen(value.budgetYen)} · ${value.remainingYen < 0 ? `超過 ${yen(-value.remainingYen)}` : `残り ${yen(value.remainingYen)}`}${value.usageRatio === null ? '' : ` · ${(value.usageRatio * 100).toFixed(1)}%`}`;
}
function progress(value: { budgetYen: number; spentYen: number }, label: string) {
  const result = node('progress'); result.max = Math.max(1, value.budgetYen); result.value = Math.max(0, Math.min(value.spentYen, result.max)); result.setAttribute('aria-label', label); return result;
}
export function renderMonthlyBudgets(target: HTMLElement, summary: MonthlyBudgetSummary, edit: () => void) {
  const configured = summary.categories.filter(category => category.budgetYen !== null);
  const details = node('details'); details.className = 'monthly-budget-details';
  const heading = node('summary');
  const headline = node('span', `${Number(summary.yearMonth.slice(5))}月の予算 · ${yen(summary.spentYen)} / ${yen(summary.budgetYen)}`); headline.className = 'budget-headline';
  heading.append(headline);
  if (summary.budgetYen > 0) {
    const meter = progress(summary, '予算全体の使用額'); meter.classList.add('budget-meter'); meter.classList.toggle('over', summary.remainingYen < 0);
    const remaining = node('span', summary.remainingYen < 0 ? `超過 ${yen(-summary.remainingYen)}` : `残り ${yen(summary.remainingYen)}`); remaining.className = `budget-remaining${summary.remainingYen < 0 ? ' over' : ''}`;
    heading.append(meter, remaining);
  } else if (!configured.length) { const setup = node('span', '予算を設定する'); setup.className = 'budget-remaining'; heading.append(setup); }
  details.append(heading);
  if (!configured.length) details.append(node('p', 'この月の予算は未設定です。'));
  else if (configured.some(category => category.budgetYen! >= 0)) {
    const total = node('p', `予算対象カテゴリの合計：${amountLine(summary)}`); total.id = 'budget-total'; details.append(total);
  }
  const list = node('ul'); list.className = 'budget-category-list';
  for (const category of configured) {
    const row = node('li'); row.dataset.budgetCategory = category.categoryId;
    row.append(node('p', `${category.categoryName} · ${amountLine({ ...category, budgetYen: category.budgetYen! })}`));
    if (category.budgetYen! > 0) row.append(progress(category as { budgetYen: number; spentYen: number }, `${category.categoryName}の使用額`));
    else if (category.budgetYen! < 0) row.append(node('p', 'この予算はマイナスの設定です。全体の予算合計には含めません。'));
    list.append(row);
  }
  details.append(list, button('この月の予算を変更', edit)); target.append(details);
}

export async function showMonthlyBudgetEditor(options: {
  view: HTMLElement; ledger: Ledger; service: LocalMonthlyBudgetService; yearMonth: string;
  mode: 'default' | 'monthly'; onBack: () => void; onMonth: (month: string) => void;
}) {
  let month = options.yearMonth;
  let revision = 0;
  async function render(saved = false) {
    const current = ++revision;
    const title = node('h2', options.mode === 'default' ? '毎月の基本予算' : `${Number(month.slice(0, 4))}年${Number(month.slice(5))}月の予算`); title.id = 'budget-edit-month';
    const status = node('p', saved ? '予算を保存しました。' : '予算を読み込んでいます。'); status.setAttribute('role', 'status');
    options.view.replaceChildren(title, status);
    const summary = await options.service.getSummary(month);
    if (current !== revision || !title.isConnected) return;
    const navigation = node('div'); navigation.className = 'month-selector';
    if (options.mode === 'monthly') for (const [label, offset] of [['予算の前月へ', -1], ['予算の翌月へ', 1]] as const) {
      const control = button(offset < 0 ? '‹' : '›', () => { month = shiftMonth(month, offset); options.onMonth(month); void render().catch(report); });
      control.setAttribute('aria-label', label); control.disabled = shiftMonth(month, offset) === month; navigation.append(control);
    }
    if (options.mode === 'monthly') options.view.append(navigation);
    const form = node('form');
    const categoryLabel = node('label', '予算カテゴリ'); categoryLabel.htmlFor = 'budget-category';
    const category = node('select'); category.id = categoryLabel.htmlFor; category.required = true;
    category.append(new Option('選択してください', ''), ...summary.categories.map(row => new Option(row.categoryName, row.categoryId)));
    const amountLabel = node('label', options.mode === 'default' ? '基本予算（円）' : 'この月の予算（円）'); amountLabel.htmlFor = 'budget-amount';
    const amount = node('input'); amount.id = amountLabel.htmlFor; amount.type = 'number'; amount.inputMode = 'numeric'; amount.min = '0'; amount.step = '1'; amount.required = true;
    const resetDefault = button('この月の変更を解除して基本予算へ戻す', () => {
      const selectedMonth = month;
      void save(categoryId => options.service.resetMonthlyOverride(selectedMonth, categoryId));
    });
    const clearDefault = button('基本予算を解除', () => void save(categoryId => options.service.setDefault(categoryId, null)));
    resetDefault.disabled = true; clearDefault.disabled = true;
    let selectionRevision = 0;
    category.addEventListener('change', () => {
      const selectedRevision = ++selectionRevision;
      const selectedCategoryId = category.value;
      const selectedMonth = month;
      const row = summary.categories.find(item => item.categoryId === selectedCategoryId);
      amount.value = '';
      amount.disabled = true; submit.disabled = true; resetDefault.disabled = true; clearDefault.disabled = true;
      void (options.mode === 'default' ? options.service.defaultBudget(selectedCategoryId) : options.service.monthOverride(selectedCategoryId, selectedMonth)).then(value => {
        if (!title.isConnected || selectedRevision !== selectionRevision) return;
        if (options.mode === 'default') amount.value = value === null ? '' : String(value);
        else amount.value = typeof value === 'number' ? String(value) : String(row?.budgetYen ?? '');
        amount.disabled = false; submit.disabled = false;
        resetDefault.disabled = options.mode !== 'monthly' || !category.value;
        clearDefault.disabled = options.mode !== 'default' || value === null;
      }).catch(error => {
        if (!title.isConnected || selectedRevision !== selectionRevision) return;
        report(error); amount.value = ''; amount.disabled = false; submit.disabled = true;
        resetDefault.disabled = options.mode !== 'monthly' || !category.value;
        clearDefault.disabled = options.mode !== 'default';
      });
    });
    const submit = node('button', options.mode === 'default' ? '基本予算を保存' : 'この月の予算を保存'); submit.type = 'submit';
    amount.addEventListener('input', () => { if (!amount.disabled) submit.disabled = !amount.value; });
    form.append(categoryLabel, category, amountLabel, amount,
      node('p', options.mode === 'default' ? '基本予算は各月に適用されます。月ごとの変更はホームから設定できます。' : '0円もこの月の予算として保存できます。変更を解除すると基本予算へ戻ります。'),
      submit, ...(options.mode === 'default' ? [clearDefault] : [resetDefault]));
    form.addEventListener('submit', event => {
      event.preventDefault();
      const selectedMonth = month;
      const budgetYen = Number(amount.value);
      void save(categoryId => options.mode === 'default'
        ? options.service.setDefault(categoryId, budgetYen)
        : options.service.setMonthlyOverride(selectedMonth, categoryId, budgetYen));
    });
    async function save(action: (categoryId: string) => Promise<void>) {
      const categoryId = category.value;
      if (!categoryId) { status.textContent = '予算カテゴリを選んでください。'; return; }
      submit.disabled = true; category.disabled = true; amount.disabled = true; resetDefault.disabled = true; clearDefault.disabled = true;
      try { await action(categoryId); if (title.isConnected) await render(true); }
      catch (error) { report(error); }
      finally {
        submit.disabled = false; category.disabled = false; amount.disabled = false;
        if (title.isConnected) {
          resetDefault.disabled = options.mode !== 'monthly' || !categoryId;
          clearDefault.disabled = options.mode !== 'default';
        }
      }
    }
    options.view.append(form);
    const overview = node('section'); renderMonthlyBudgets(overview, summary, () => category.focus()); options.view.append(overview, button('設定へ戻る', options.onBack));
    if (!saved) status.textContent = summary.categories.length ? '変更した金額は保存してください。' : '先に支出カテゴリを追加してください。';
    function report(error: unknown) { if (title.isConnected) status.textContent = error instanceof Error ? error.message : '予算を保存できませんでした。'; }
  }
  await render();
}
