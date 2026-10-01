import type { createActualBrowserLedger } from '../../../src/lib/actual-browser-ledger';
import { shiftMonth } from './local-monthly-dashboard';
type Ledger = ReturnType<typeof createActualBrowserLedger>;
type Summary = Awaited<ReturnType<Ledger['getMonthlyBudgets']>>;
const yen = (value: number) => `${value < 0 ? '−' : ''}¥${Math.abs(value).toLocaleString('ja-JP')}`;
function node<K extends keyof HTMLElementTagNameMap>(tag: K, value = '') { const result = document.createElement(tag); result.textContent = value; return result; }
function button(label: string, action: () => void) { const result = node('button', label); result.type = 'button'; result.className = 'secondary'; result.addEventListener('click', action); return result; }
function amountLine(value: { budgetYen: number; spentYen: number; remainingYen: number; usageRatio: number | null }) {
  return `${yen(value.spentYen)} / ${yen(value.budgetYen)} · ${value.remainingYen < 0 ? `超過 ${yen(-value.remainingYen)}` : `残り ${yen(value.remainingYen)}`}${value.usageRatio === null ? '' : ` · ${(value.usageRatio * 100).toFixed(1)}%`}`;
}
function progress(value: { budgetYen: number; spentYen: number }, label: string) {
  const result = node('progress'); result.max = Math.max(1, value.budgetYen); result.value = Math.max(0, Math.min(value.spentYen, result.max)); result.setAttribute('aria-label', label); return result;
}
export function renderMonthlyBudgets(target: HTMLElement, summary: Summary, edit: () => void) {
  const details = node('details'); details.className = 'monthly-budget-details';
  details.append(node('summary', `${Number(summary.yearMonth.slice(5))}月の予算 · ${yen(summary.spentYen)} / ${yen(summary.budgetYen)}`));
  if (!summary.budgetYen) details.append(node('p', 'この月の予算は未設定です。'));
  else { const total = node('p', `予算対象カテゴリの合計：${amountLine(summary)}`); total.id = 'budget-total'; details.append(total, progress(summary, '予算全体の使用額')); }
  const list = node('ul'); list.className = 'budget-category-list';
  for (const category of summary.categories.filter(category => category.budgetYen !== 0)) {
    const row = node('li'); row.dataset.budgetCategory = category.categoryId;
    row.append(node('p', `${category.categoryName} · ${amountLine(category)}`));
    if (category.budgetYen > 0) row.append(progress(category, `${category.categoryName}の使用額`));
    else row.append(node('p', 'この予算はマイナスの設定です。全体の予算合計には含めません。'));
    list.append(row);
  }
  details.append(list, button('予算を設定', edit)); target.append(details);
}
export async function showMonthlyBudgetEditor(options: { view: HTMLElement; ledger: Ledger; yearMonth: string; onBack: () => void; onMonth: (month: string) => void }) {
  let month = options.yearMonth;
  let revision = 0;
  async function render(saved = false) {
    const current = ++revision;
    const title = node('h2', `${Number(month.slice(0, 4))}年${Number(month.slice(5))}月の予算`); title.id = 'budget-edit-month';
    const status = node('p', saved ? '予算を保存しました。' : '予算を読み込んでいます。'); status.setAttribute('role', 'status');
    options.view.replaceChildren(title, status);
    const summary = await options.ledger.getMonthlyBudgets({ yearMonth: month });
    if (current !== revision || !title.isConnected) return;
    const navigation = node('div'); navigation.className = 'month-selector';
    for (const [label, offset] of [['予算の前月へ', -1], ['予算の翌月へ', 1]] as const) {
      const control = button(offset < 0 ? '‹' : '›', () => { month = shiftMonth(month, offset); options.onMonth(month); void render().catch(report); });
      control.setAttribute('aria-label', label); control.disabled = shiftMonth(month, offset) === month; navigation.append(control);
    }
    options.view.append(navigation);
    const form = node('form');
    const categoryLabel = node('label', '予算カテゴリ'); categoryLabel.htmlFor = 'budget-category';
    const category = node('select'); category.id = categoryLabel.htmlFor; category.required = true;
    category.append(new Option('選択してください', ''), ...summary.categories.map(row => new Option(row.categoryName, row.categoryId)));
    const amountLabel = node('label', '月予算（円）'); amountLabel.htmlFor = 'budget-amount';
    const amount = node('input'); amount.id = amountLabel.htmlFor; amount.type = 'number'; amount.inputMode = 'numeric'; amount.min = '0'; amount.step = '1'; amount.required = true;
    category.addEventListener('change', () => { amount.value = String(summary.categories.find(row => row.categoryId === category.value)?.budgetYen ?? 0); });
    const submit = node('button', '予算を保存'); submit.type = 'submit';
    form.append(categoryLabel, category, amountLabel, amount, node('p', '0円を保存すると、このカテゴリの予算設定を解除します。'), submit);
    form.addEventListener('submit', event => {
      event.preventDefault(); const selectedMonth = month; const categoryId = category.value; const budgetYen = Number(amount.value);
      submit.disabled = true; category.disabled = true; amount.disabled = true;
      void options.ledger.setMonthlyBudget({ yearMonth: selectedMonth, categoryId, budgetYen }).then(() => {
        if (title.isConnected) return render(true);
      }).catch(report).finally(() => { submit.disabled = false; category.disabled = false; amount.disabled = false; });
    });
    options.view.append(form);
    const overview = node('section'); renderMonthlyBudgets(overview, summary, () => category.focus()); options.view.append(overview, button('設定へ戻る', options.onBack));
    if (!saved) status.textContent = summary.categories.length ? '変更した金額は保存してください。' : '先に支出カテゴリを追加してください。';
    function report(error: unknown) { if (title.isConnected) status.textContent = error instanceof Error ? error.message : '予算を保存できませんでした。'; }
  }
  await render();
}
