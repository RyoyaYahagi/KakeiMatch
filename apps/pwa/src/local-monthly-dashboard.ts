import type { ActualMonthlySummary as MonthlySummary } from '../../../src/lib/actual-ledger';
import { categoryTone } from './category-tone';
import { icon } from './ui-icons';

const yen = (value: number) => `¥${Math.abs(value).toLocaleString('ja-JP')}`;
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
    const button = node('button') as HTMLButtonElement; button.type = 'button'; button.className = 'icon-button'; button.setAttribute('aria-label', title);
    button.append(icon(offset < 0 ? 'chevronLeft' : 'chevronRight'));
    button.disabled = shiftMonth(summary.yearMonth, offset) === summary.yearMonth;
    button.addEventListener('click', () => select({ type: 'shift', offset }));
    if (offset < 0) selector.append(button, label); else selector.append(button);
  }
  target.append(selector);
  if (summary.yearMonth !== currentMonth) {
    const reset = node('button', '当月へ戻る') as HTMLButtonElement; reset.type = 'button'; reset.className = 'text-button month-reset'; reset.addEventListener('click', () => select({ type: 'current' })); target.append(reset);
  }
  const overview = node('section'); overview.className = 'surface-section home-overview'; overview.setAttribute('aria-label', '月の収支');
  const totals = node('dl'); totals.className = 'monthly-totals';
  for (const [title, value, id] of [
    [summary.yearMonth === currentMonth ? '今月の支出' : '支出', yen(summary.expenseYen), 'monthly-expense'],
    ['収入', yen(summary.incomeYen), 'monthly-income'],
    ['収支', `${summary.balanceYen > 0 ? '+' : summary.balanceYen < 0 ? '−' : ''}${yen(summary.balanceYen)}`, 'monthly-balance'],
  ]) { const row = node('div'); row.id = id; row.append(node('dt', `${title} `), node('dd', value)); totals.append(row); }
  overview.append(totals);
  target.append(overview);
  return overview;
}

const BREAKDOWN_SLICES = 3;
const SLICE_TONES = ['food', 'daily', 'transport', 'fun', 'util', 'comm'] as const;

/** Home breakdown: up to three categories and "その他" in one bar, with every category listed on demand. */
export function renderCategoryBreakdown(target: HTMLElement, summary: MonthlySummary) {
  const section = node('section'); section.className = 'surface-section category-breakdown'; section.setAttribute('aria-labelledby', 'category-breakdown-title');
  const heading = node('h2', '支出の内訳'); heading.id = 'category-breakdown-title';
  section.append(heading);
  target.replaceChildren(section);
  if (!summary.expenseYen) { section.append(node('p', 'この月の支出はありません。')); return; }
  const share = (amount: number) => `${(amount / summary.expenseYen * 100).toFixed(1)}%`;
  const positive = summary.categories.filter(category => category.amountYen > 0).sort((a, b) => b.amountYen - a.amountYen);
  const positiveTotal = positive.reduce((total, category) => total + category.amountYen, 0);
  const usedTones = new Set<string>();
  const top = positive.slice(0, BREAKDOWN_SLICES).map(category => {
    const preferred = categoryTone(category.categoryName, category.categoryId).tone;
    const tone = usedTones.has(preferred) ? SLICE_TONES.find(candidate => !usedTones.has(candidate))! : preferred;
    usedTones.add(tone);
    return { name: category.categoryName, amountYen: category.amountYen, tone: tone as string };
  });
  if (!top.length) { section.append(node('p', 'この月は返金・調整だけです。')); return; }
  const restYen = positive.slice(BREAKDOWN_SLICES).reduce((total, category) => total + category.amountYen, 0);
  const slices = restYen > 0 ? [...top, { name: 'その他', amountYen: restYen, tone: 'rest' }] : top;
  // docs/DESIGN.md 支出の内訳（帯グラフ）: one bar split by share, largest first.
  const bar = node('div'); bar.className = 'breakdown-bar'; bar.setAttribute('role', 'img');
  bar.setAttribute('aria-label', `支出の内訳：${slices.map(slice => `${slice.name} ${share(slice.amountYen)}`).join('、')}`);
  for (const slice of slices) {
    const part = node('span'); part.className = `tone-${slice.tone}`;
    part.style.setProperty('--share', String(positiveTotal > 0 ? slice.amountYen / positiveTotal : 0));
    bar.append(part);
  }
  const legend = node('ul'); legend.className = 'breakdown-legend'; legend.setAttribute('aria-hidden', 'true');
  for (const slice of slices) {
    const item = node('li'); const dot = node('span'); dot.className = `legend-dot tone-${slice.tone}`;
    item.append(dot, node('span', slice.name), node('span', share(slice.amountYen)));
    legend.append(item);
  }
  section.append(bar, legend);
  const details = node('details'); details.className = 'monthly-category-details'; details.append(node('summary', 'すべてのカテゴリ'));
  if (summary.categories.some(category => category.amountYen < 0)) details.append(node('p', '帯グラフは支出が正のカテゴリの構成です。返金・調整は一覧に表示します。'));
  const list = node('ul'); list.className = 'category-list';
  for (const category of summary.categories) list.append(node('li', `${category.categoryName} · ${category.amountYen < 0 ? '−' : ''}${yen(category.amountYen)} · ${share(category.amountYen)}`));
  details.append(list);
  section.append(details);
}
