import type { createActualBrowserLedger } from '../../../src/lib/actual-browser-ledger';
import { monthEnd, shiftMonth } from './local-monthly-dashboard';
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
/**
 * docs/DESIGN.md 予算の進み具合（日の目盛り）: one tick per day. Ticks are filled by the share of the budget used;
 * the ones past today show spending ahead of the even pace, and every tick turns red once the budget is over.
 */
function dayTicks(summary: MonthlyBudgetSummary, today: string) {
  const days = Number(monthEnd(summary.yearMonth).slice(8));
  const month = today.slice(0, 7);
  const elapsed = summary.yearMonth < month ? days : summary.yearMonth > month ? 0 : Number(today.slice(8));
  const over = summary.remainingYen < 0;
  const filled = over ? days : Math.min(days, Math.round(summary.spentYen / summary.budgetYen * days));
  const ticks = node('span'); ticks.className = `budget-ticks${over ? ' over' : ''}`; ticks.setAttribute('aria-hidden', 'true');
  for (let day = 1; day <= days; day++) {
    const tick = node('i'); if (day <= filled) tick.className = day <= elapsed || over ? 'filled' : 'ahead';
    ticks.append(tick);
  }
  if (elapsed > 0 && elapsed < days) { const mark = node('b'); mark.className = 'budget-today'; mark.style.setProperty('--day', String(elapsed)); mark.style.setProperty('--days', String(days)); ticks.append(mark); }
  const legend = node('span'); legend.className = 'budget-pace';
  let pace = '';
  if (summary.yearMonth === month && !over) {
    // Money stays in whole yen: the even pace is rounded to the yen before comparing.
    const target = Math.round(summary.budgetYen * elapsed / days);
    const gap = summary.spentYen - target;
    pace = gap === 0 ? '目安どおり' : `目安より ${yen(Math.abs(gap))} ${gap > 0 ? '多め' : '少なめ'}`;
    legend.append(node('span', '1日'), node('span', `今日${elapsed}日 · ${pace}`), node('span', `${days}日`));
  }
  return { ticks, legend, pace };
}
export function renderMonthlyBudgets(target: HTMLElement, summary: MonthlyBudgetSummary, edit: () => void, today: string) {
  const configured = summary.categories.filter(category => category.budgetYen !== null);
  const details = node('details'); details.className = 'monthly-budget-details';
  const heading = node('summary');
  const headline = node('span', summary.budgetConfigured ? `予算 ${yen(summary.budgetYen)}` : '予算'); headline.className = 'budget-headline';
  heading.append(headline);
  // docs/DESIGN.md 予算の進み具合: the whole-month budget decides whether a budget is set (#193).
  if (summary.budgetConfigured) {
    const remaining = node('span', summary.remainingYen < 0 ? `超過 ${yen(-summary.remainingYen)}` : `残り ${yen(summary.remainingYen)}`); remaining.className = `budget-remaining${summary.remainingYen < 0 ? ' over' : ''}`;
    heading.append(remaining);
    let pace = '';
    // A 0 yen budget has no scale to draw; the amounts in words are enough.
    if (summary.budgetYen > 0) {
      const ticked = dayTicks(summary, today); pace = ticked.pace;
      heading.append(ticked.ticks);
      if (ticked.legend.childElementCount) heading.append(ticked.legend);
    }
    heading.setAttribute('aria-label', `${Number(summary.yearMonth.slice(5))}月の予算 ${yen(summary.budgetYen)}、使用額 ${yen(summary.spentYen)}、${remaining.textContent}${pace ? `、${pace}` : ''}`);
  } else {
    const setup = node('span', '予算を設定する'); setup.className = 'budget-remaining'; heading.append(setup);
  }
  details.append(heading);
  if (!summary.budgetConfigured) {
    details.append(node('p', 'この月の予算は未設定です。'));
  } else {
    const total = node('p', `${summary.overallBudgetConfigured ? '全体予算' : '予算対象カテゴリの合計'}：${amountLine(summary)}`); total.id = 'budget-total'; details.append(total);
    if (!summary.breakdownEnabled) details.append(node('p', 'カテゴリ別の内訳は設定していません。'));
  }
  if (summary.breakdownEnabled) {
    const list = node('ul'); list.className = 'budget-category-list';
    for (const category of configured) {
      const row = node('li'); row.dataset.budgetCategory = category.categoryId;
      row.append(node('p', `${category.categoryName} · ${amountLine({ ...category, budgetYen: category.budgetYen! })}`));
      if (category.budgetYen! > 0) row.append(progress(category as { budgetYen: number; spentYen: number }, `${category.categoryName}の使用額`));
      else if (category.budgetYen! < 0) row.append(node('p', 'この予算はマイナスの設定です。全体の予算合計には含めません。'));
      list.append(row);
    }
    details.append(list);
  }
  details.append(button('この月の予算を変更', edit)); target.append(details);
}

function parseAmount(value: string, label: string): number {
  const amount = Number(value);
  if (value.trim() === '' || !Number.isSafeInteger(amount) || amount < 0) throw new Error(`${label}は0円以上の整数で入力してください。`);
  return amount;
}

export async function showMonthlyBudgetEditor(options: {
  view: HTMLElement; ledger: Ledger; service: LocalMonthlyBudgetService; yearMonth: string;
  mode: 'default' | 'monthly'; onBack: () => void; onMonth: (month: string) => void;
}) {
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
    const summary = { ...loaded, categories: [...loaded.categories].sort((a, b) => categoryRank(a.categoryName) - categoryRank(b.categoryName)) };
    const defaultPlan = mode === 'default' ? await options.service.getDefaultPlan() : null;
    const monthlyPlanExplicit = mode === 'monthly' ? await options.service.hasMonthlyPlan(month) : false;
    if (current !== revision || !options.view.contains(title)) return;
    if (!summary.categories.length) { status.textContent = '先に支出カテゴリを追加してください。'; return; }

    const totalCard = node('section'); totalCard.className = 'surface-section budget-total-card';
    const totalLabel = node('label', mode === 'default' ? '1か月の全体予算' : `${monthLabel(month)}の全体予算`);
    totalLabel.htmlFor = 'budget-overall-amount';
    const totalField = node('span'); totalField.className = 'budget-input';
    const totalInput = node('input'); totalInput.id = 'budget-overall-amount'; totalInput.type = 'number'; totalInput.inputMode = 'numeric'; totalInput.min = '0'; totalInput.step = '1'; totalInput.className = 'num';
    const initialTotal = mode === 'default' ? defaultPlan?.totalYen : (summary.budgetConfigured ? summary.budgetYen : null);
    totalInput.value = initialTotal === null || initialTotal === undefined ? '' : String(initialTotal);
    totalInput.setAttribute('aria-label', '全体予算');
    totalInput.placeholder = '例：50000';
    totalField.append(node('span', '¥'), totalInput);
    totalCard.append(totalLabel, totalField);

    const breakdownRow = node('label'); breakdownRow.className = 'budget-breakdown-toggle';
    const breakdown = document.createElement('input'); breakdown.type = 'checkbox'; breakdown.setAttribute('aria-label', 'カテゴリ別にも予算を設定する');
    breakdown.checked = mode === 'default' ? Boolean(defaultPlan?.breakdownEnabled) : summary.breakdownEnabled;
    breakdownRow.append(breakdown, node('span', 'カテゴリ別にも予算を設定する'));
    totalCard.append(breakdownRow);

    const categorySum = node('p'); categorySum.className = 'record-note'; totalCard.append(categorySum);
    const list = node('ul'); const section = node('section'); section.className = 'surface-section settings-rows budget-rows'; section.append(list);
    const inputs: Array<{ categoryId: string; input: HTMLInputElement }> = [];
    const defaultAllocations = defaultPlan?.allocations ?? {};
    summary.categories.forEach((row, index) => {
      const initialAmount = mode === 'default'
        ? (defaultAllocations[row.categoryId] ?? 0)
        : (row.budgetYen ?? 0);
      const item = node('li'); item.className = 'budget-row'; item.dataset.budgetEditorCategory = row.categoryId;
      const tone = categoryTone(row.categoryName, row.categoryId);
      const badge = node('span'); badge.className = `record-icon tone-${tone.tone}`; badge.append(icon(tone.icon));
      const id = `budget-amount-${index}`;
      const label = node('label'); label.htmlFor = id; label.className = 'record-main';
      label.append(Object.assign(node('span', row.categoryName), { className: 'record-title' }), Object.assign(node('span', `今月 ${yen(row.spentYen)} 使用`), { className: 'record-note' }));
      const field = node('span'); field.className = 'budget-input';
      const input = node('input'); input.id = id; input.type = 'number'; input.inputMode = 'numeric'; input.min = '0'; input.step = '1'; input.value = String(initialAmount); input.className = 'num';
      input.setAttribute('aria-label', `${row.categoryName}の予算`); input.placeholder = '0';
      field.append(node('span', '¥'), input);
      item.append(badge, label, field);
      list.append(item);
      inputs.push({ categoryId: row.categoryId, input });
    });
    const updateBreakdown = () => {
      section.hidden = !breakdown.checked;
      let sum = 0;
      for (const row of inputs) {
        const value = Number(row.input.value);
        if (row.input.value !== '' && Number.isSafeInteger(value) && value >= 0) sum += value;
      }
      categorySum.hidden = !breakdown.checked;
      categorySum.textContent = breakdown.checked ? `カテゴリ別の合計：${yen(sum)}` : '全体予算だけで管理します。';
    };
    for (const row of inputs) row.input.addEventListener('input', updateBreakdown);
    breakdown.addEventListener('change', updateBreakdown);
    updateBreakdown();

    const submit = node('button', mode === 'default' ? '基本予算を保存' : 'この月の予算を保存'); submit.type = 'button'; submit.className = 'primary';
    submit.addEventListener('click', () => { void save(); });
    const actions = node('div'); actions.className = 'page-actions'; actions.append(submit);
    let resetControl: HTMLButtonElement | null = null;
    if (mode === 'default' && defaultPlan?.totalYen !== null) {
      resetControl = button('予算を未設定に戻す', () => { void resetPlan(); });
      resetControl.className = 'text-button';
      actions.append(resetControl);
    } else if (mode === 'monthly' && monthlyPlanExplicit) {
      resetControl = button('基本予算に戻す', () => { void resetPlan(); });
      resetControl.className = 'text-button';
      actions.append(resetControl);
    }
    options.view.append(totalCard, section,
      node('p', 'カテゴリ別に設定する場合は、カテゴリ別予算の合計と全体予算が一致したときだけ保存できます。'),
      actions);
    if (!saved && totalInput.value === '') status.textContent = '全体予算を入力してください。';
    else if (!saved) status.textContent = '';

    async function resetPlan() {
      if (!resetControl) return;
      resetControl.disabled = true;
      try {
        if (mode === 'default') await options.service.clearDefaultPlan();
        else await options.service.resetMonthlyPlan(month);
        if (options.view.contains(title)) await render(true);
      } catch (error) { report(error); }
      finally { if (options.view.contains(title) && resetControl) resetControl.disabled = false; }
    }

    async function save() {
      for (const row of inputs) row.input.disabled = true;
      totalInput.disabled = true; breakdown.disabled = true; submit.disabled = true;
      try {
        const totalYen = parseAmount(totalInput.value, '全体予算');
        const allocations: Record<string, number> = {};
        let allocationTotal = 0;
        if (breakdown.checked) {
          for (const row of inputs) {
            const amount = row.input.value.trim() === '' ? 0 : parseAmount(row.input.value, 'カテゴリ別予算');
            allocations[row.categoryId] = amount;
            allocationTotal += amount;
            if (!Number.isSafeInteger(allocationTotal)) throw new Error('カテゴリ別予算の合計額を安全に計算できません。');
          }
          if (allocationTotal !== totalYen) throw new Error(`カテゴリ別予算の合計（${yen(allocationTotal)}）を全体予算（${yen(totalYen)}）と一致させてください。`);
        }
        if (mode === 'default') await options.service.setDefaultPlan(totalYen, breakdown.checked, allocations);
        else await options.service.setMonthlyPlan(month, totalYen, breakdown.checked, allocations);
        if (options.view.contains(title)) await render(true);
      } catch (error) { report(error); }
      finally {
        if (options.view.contains(title)) {
          for (const row of inputs) row.input.disabled = false;
          totalInput.disabled = false; breakdown.disabled = false; submit.disabled = false;
        }
      }
    }
    function report(error: unknown) { if (options.view.contains(title)) status.textContent = error instanceof Error ? error.message : '予算を保存できませんでした。'; }
  }
  function report(error: unknown) { const status = options.view.querySelector('[role=status]'); if (status) status.textContent = error instanceof Error ? error.message : '予算を読み込めませんでした。'; }
  await render();
}
