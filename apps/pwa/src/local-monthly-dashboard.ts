import type { ActualMonthlySummary as MonthlySummary } from '../../../src/lib/actual-ledger';

const yen = (value: number) => `¥${Math.abs(value).toLocaleString('ja-JP')}`;
const SLICE_COLOR_COUNT = 6;
function node(tag: string, value = '') { const result = document.createElement(tag); result.textContent = value; return result; }
export function shiftMonth(month: string, offset: number): string {
  const [year, index] = month.split('-').map(Number);
  const total = year * 12 + index - 1 + offset;
  if (total < 12 || total >= 120000) return month;
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String(total % 12 + 1).padStart(2, '0')}`;
}
export function monthEnd(month: string): string {
  const [year, index] = month.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const day = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][index - 1];
  return `${month}-${day}`;
}
export function renderMonthlyDashboard(target: HTMLElement, summary: MonthlySummary, currentMonth: string, select: (action: { type: 'shift'; offset: -1 | 1 } | { type: 'current' }) => void) {
  target.replaceChildren();
  const selector = node('div'); selector.className = 'month-selector';
  const [year, month] = summary.yearMonth.split('-');
  const label = node('strong', `${Number(year)}年${Number(month)}月`); label.id = 'selected-month';
  for (const [title, offset] of [['前月へ', -1], ['翌月へ', 1]] as const) {
    const button = node('button', offset < 0 ? '‹' : '›') as HTMLButtonElement; button.type = 'button'; button.className = 'secondary'; button.setAttribute('aria-label', title);
    button.disabled = shiftMonth(summary.yearMonth, offset) === summary.yearMonth;
    button.addEventListener('click', () => select({ type: 'shift', offset }));
    if (offset < 0) selector.append(button, label); else selector.append(button);
  }
  target.append(selector);
  if (summary.yearMonth !== currentMonth) {
    const reset = node('button', '当月へ戻る') as HTMLButtonElement; reset.type = 'button'; reset.className = 'secondary'; reset.addEventListener('click', () => select({ type: 'current' })); target.append(reset);
  }
  const totals = node('dl'); totals.className = 'monthly-totals';
  for (const [title, value, id] of [
    ['収入', yen(summary.incomeYen), 'monthly-income'],
    [summary.yearMonth === currentMonth ? '今月の支出' : '支出', yen(summary.expenseYen), 'monthly-expense'],
    ['収支', `${summary.balanceYen > 0 ? '+' : summary.balanceYen < 0 ? '−' : ''}${yen(summary.balanceYen)}`, 'monthly-balance'],
  ]) { const row = node('div'); row.id = id; row.append(node('dt', `${title} `), node('dd', value)); totals.append(row); }
  target.append(totals);
  const details = node('details'); details.className = 'monthly-category-details'; details.append(node('summary', '支出のカテゴリ内訳'));
  if (!summary.expenseYen) { details.append(node('p', 'この月の支出はありません。')); target.append(details); return; }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 120 120'); svg.classList.add('category-donut'); svg.setAttribute('aria-label', '支出カテゴリの割合'); svg.setAttribute('role', 'group');
  const selection = node('p', 'カテゴリを選ぶと金額と割合を確認できます。'); selection.id = 'category-selection'; selection.setAttribute('role', 'status');
  const list = node('ul'); list.className = 'category-legend';
  const positiveTotal = summary.categories.reduce((total, category) => total + Math.max(0, category.amountYen), 0);
  if (summary.categories.some(category => category.amountYen < 0)) details.append(node('p', '円グラフは支出が正のカテゴリの構成です。返金・調整は一覧に表示します。'));
  let offset = 0;
  summary.categories.forEach((category, index) => {
    const percentage = category.amountYen / summary.expenseYen * 100;
    const label = `${category.categoryName} · ${category.amountYen < 0 ? "−" : ""}${yen(category.amountYen)} · ${percentage.toFixed(1)}%`;
    const slicePercentage = Math.max(0, category.amountYen) / positiveTotal * 100;
    const sliceClass = `slice-${index % SLICE_COLOR_COUNT}`;
    const circle = document.createElementNS(svg.namespaceURI, 'circle');
    for (const [key, value] of Object.entries({ cx: '60', cy: '60', r: '42', fill: 'none', class: sliceClass, 'stroke-width': '22', pathLength: '100', 'stroke-dasharray': `${slicePercentage} ${100 - slicePercentage}`, 'stroke-dashoffset': String(-offset), transform: 'rotate(-90 60 60)', tabindex: '0', role: 'button', 'aria-label': label })) circle.setAttribute(key, value);
    circle.addEventListener('click', () => { selection.textContent = label; });
    circle.addEventListener('keydown', event => { const key = (event as KeyboardEvent).key; if (key === 'Enter' || key === ' ') { event.preventDefault(); selection.textContent = label; } });
    if (slicePercentage > 0) svg.append(circle); offset += slicePercentage;
    const entry = node('li'); const button = node('button', label) as HTMLButtonElement; button.type = 'button'; button.className = `category-legend-entry ${sliceClass}`; button.addEventListener('click', () => { selection.textContent = label; }); entry.append(button); list.append(entry);
  });
  details.append(svg, selection, list); target.append(details);
}
