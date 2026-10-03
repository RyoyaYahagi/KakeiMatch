import type { createActualBrowserLedger } from '../../../src/lib/actual-browser-ledger';
import { shiftMonth } from './local-monthly-dashboard';
import { categoryRank, categoryTone } from './category-tone';
import { backLink } from './settings-ui';
import { icon } from './ui-icons';
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
  // docs/UX.md 予算: every expense category on one screen, entered in place and saved together.
  let month = options.yearMonth;
  let mode = options.mode;
  let revision = 0;
  const monthLabel = (value: string) => `${Number(value.slice(0, 4))}年${Number(value.slice(5))}月`;
  async function render(saved = false) {
    const current = ++revision;
    const back = backLink('設定', '設定へ戻る', options.onBack);
    const title = node('h2', mode === 'default' ? '毎月の基本予算' : `${monthLabel(month)}の予算`); title.id = 'budget-edit-month'; title.className = 'page-title';
    const switcher = node('div'); switcher.className = 'segmented'; switcher.setAttribute('role', 'group'); switcher.setAttribute('aria-label', '予算の種類');
    for (const [value, label] of [['default', '毎月の基本予算'], ['monthly', `${Number(month.slice(5))}月だけ変更`]] as const) {
      const option = node('button', label); option.type = 'button'; option.setAttribute('aria-pressed', String(mode === value));
      option.addEventListener('click', () => { if (mode === value) return; mode = value; void render().catch(report); });
      switcher.append(option);
    }
    const status = node('p', saved ? '予算を保存しました。' : '予算を読み込んでいます。'); status.setAttribute('role', 'status'); status.className = 'status';
    options.view.replaceChildren(back, title, switcher, status);
    if (mode === 'monthly') {
      const navigation = node('div'); navigation.className = 'month-selector budget-month';
      const label = node('strong', monthLabel(month));
      for (const [ariaLabel, offset] of [['予算の前月へ', -1], ['予算の翌月へ', 1]] as const) {
        const control = node('button'); control.type = 'button'; control.className = 'icon-button'; control.append(icon(offset < 0 ? 'chevronLeft' : 'chevronRight'));
        control.setAttribute('aria-label', ariaLabel); control.disabled = shiftMonth(month, offset) === month;
        control.addEventListener('click', () => { month = shiftMonth(month, offset); options.onMonth(month); void render().catch(report); });
        if (offset < 0) navigation.append(control, label); else navigation.append(control);
      }
      options.view.append(navigation);
    }
    const loaded = await options.service.getSummary(month);
    // Everyday categories first, the same order as the category screens.
    const summary = { ...loaded, categories: [...loaded.categories].sort((a, b) => categoryRank(a.categoryName) - categoryRank(b.categoryName)) };
    const stored = await Promise.all(summary.categories.map(row => mode === 'default' ? options.service.defaultBudget(row.categoryId) : options.service.monthOverride(row.categoryId, month)));
    if (current !== revision || !options.view.contains(title)) return;
    if (!summary.categories.length) { status.textContent = '先に支出カテゴリを追加してください。'; return; }
    const totalValue = node('strong'); totalValue.className = 'num';
    const total = node('div'); total.className = 'surface-section budget-total-card';
    total.append(node('span', mode === 'default' ? '毎月の予算の合計' : `${monthLabel(month)}の予算の合計`), totalValue);
    const list = node('ul'); const section = node('section'); section.className = 'surface-section settings-rows budget-rows'; section.append(list);
    const inputs: Array<{ categoryId: string; input: HTMLInputElement; initial: string }> = [];
    summary.categories.forEach((row, index) => {
      const value = stored[index];
      const overridden = mode === 'monthly' && typeof value === 'number';
      const initial = mode === 'default' ? (typeof value === 'number' ? String(value) : '') : overridden ? String(value) : row.budgetYen === null ? '' : String(row.budgetYen);
      const item = node('li'); item.className = 'budget-row'; item.dataset.budgetEditorCategory = row.categoryId;
      const tone = categoryTone(row.categoryName, row.categoryId);
      const badge = node('span'); badge.className = `record-icon tone-${tone.tone}`; badge.append(icon(tone.icon));
      const id = `budget-amount-${index}`;
      const label = node('label'); label.htmlFor = id; label.className = 'record-main';
      const notes = [`今月 ${yen(row.spentYen)} 使用`, overridden ? 'この月だけ変更中' : ''].filter(Boolean).join(' · ');
      label.append(Object.assign(node('span', row.categoryName), { className: 'record-title' }), Object.assign(node('span', notes), { className: 'record-note' }));
      const field = node('span'); field.className = 'budget-input';
      const input = node('input'); input.id = id; input.type = 'number'; input.inputMode = 'numeric'; input.min = '0'; input.step = '1'; input.value = initial; input.className = 'num';
      input.setAttribute('aria-label', `${row.categoryName}の予算`); input.placeholder = '予算なし';
      field.append(node('span', '¥'), input);
      item.append(badge, label, field);
      if (overridden) {
        const reset = button('基本に戻す', () => { void save([{ categoryId: row.categoryId, reset: true }]); });
        reset.className = 'text-button'; reset.setAttribute('aria-label', `${row.categoryName}の変更を解除して基本予算へ戻す`);
        item.append(reset);
      }
      list.append(item);
      inputs.push({ categoryId: row.categoryId, input, initial });
    });
    const updateTotal = () => { totalValue.textContent = yen(inputs.reduce((sum, row) => sum + (row.input.value === '' ? 0 : Math.max(0, Math.trunc(Number(row.input.value)) || 0)), 0)); };
    for (const row of inputs) row.input.addEventListener('input', updateTotal);
    updateTotal();
    const submit = node('button', mode === 'default' ? '基本予算を保存' : 'この月の予算を保存'); submit.type = 'button';
    submit.addEventListener('click', () => {
      const changes = inputs.filter(row => row.input.value !== row.initial).map(row => ({ categoryId: row.categoryId, value: row.input.value }));
      if (!changes.length) { status.textContent = '変更はありません。'; return; }
      void save(changes);
    });
    const actions = node('div'); actions.className = 'page-actions'; actions.append(submit);
    options.view.append(total, section,
      node('p', mode === 'default' ? '空欄は「予算なし」、0円は「使わない予定」として区別します。基本予算は毎月に適用されます。' : '空欄にすると基本予算に戻ります。0円もこの月の予算として保存できます。'),
      actions);
    if (!saved) status.textContent = '金額を入力して保存してください。';
    async function save(changes: Array<{ categoryId: string; value?: string; reset?: boolean }>) {
      for (const row of inputs) row.input.disabled = true;
      submit.disabled = true;
      try {
        for (const change of changes) {
          const amount = change.value === undefined || change.value === '' ? null : Number(change.value);
          if (amount !== null && (!Number.isSafeInteger(amount) || amount < 0)) throw new Error('予算は0円以上の整数で入力してください。');
          if (mode === 'default') await options.service.setDefault(change.categoryId, amount);
          else if (change.reset || amount === null) await options.service.resetMonthlyOverride(month, change.categoryId);
          else await options.service.setMonthlyOverride(month, change.categoryId, amount);
        }
        if (options.view.contains(title)) await render(true);
      } catch (error) { report(error); }
      finally { if (options.view.contains(title)) { for (const row of inputs) row.input.disabled = false; submit.disabled = false; } }
    }
    function report(error: unknown) { if (options.view.contains(title)) status.textContent = error instanceof Error ? error.message : '予算を保存できませんでした。'; }
  }
  function report(error: unknown) { const status = options.view.querySelector('[role=status]'); if (status) status.textContent = error instanceof Error ? error.message : '予算を読み込めませんでした。'; }
  await render();
}
