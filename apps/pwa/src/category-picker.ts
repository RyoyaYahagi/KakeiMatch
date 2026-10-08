import { dismissOnBackdrop } from './dialog-backdrop';
import { categoryRank, categoryTone } from './category-tone';
import { icon } from './ui-icons';

/* docs/UX.md 支出の入力: categories as buttons with icons. The native select stays the single source of the value. */
const VISIBLE_CATEGORIES = 7;
let pickerSequence = 0;

type RecentTransactions = { getRecentTransactions(options: { limit: number }): Promise<Array<{ categoryId?: string | null }>> };

// The ledger returns at most 100 recent records at a time.
const RECENT_USAGE_LIMIT = 100;

/** How often each category was used in recent records. */
export async function recentCategoryUsage(ledger: RecentTransactions) {
  const usage = new Map<string, number>();
  for (const row of await ledger.getRecentTransactions({ limit: RECENT_USAGE_LIMIT })) if (row.categoryId) usage.set(row.categoryId, (usage.get(row.categoryId) ?? 0) + 1);
  return usage;
}

/** Count each category once per expense, including categories of split items. */
export async function expenseCategoryUsage(ledger: {
  getSearchTransactions(): Promise<Array<{ transaction: { kind: string }; categoryIds: string[] }>>;
}) {
  const usage = new Map<string, number>();
  for (const row of await ledger.getSearchTransactions()) {
    if (row.transaction.kind !== 'expense') continue;
    for (const id of new Set(row.categoryIds)) usage.set(id, (usage.get(id) ?? 0) + 1);
  }
  return usage;
}

/** usage: recent use per category; frequently used categories come first once it resolves. */
/** collapse: fold long lists behind "すべて表示"; the category sheet is already the full list, so it shows everything. */
export function enhanceCategorySelect(select: HTMLSelectElement, label: HTMLLabelElement, usageReady: Promise<ReadonlyMap<string, number>> = Promise.resolve(new Map()), collapse = true) {
  let usage: ReadonlyMap<string, number> = new Map();
  if (!label.id) label.id = `category-picker-label-${++pickerSequence}`;
  const picker = document.createElement('div'); picker.className = 'category-picker';
  picker.setAttribute('role', 'radiogroup'); picker.setAttribute('aria-labelledby', label.id);
  // The select keeps the value, drafts and saves; the buttons are the visible and accessible control.
  select.classList.add('visually-hidden'); select.tabIndex = -1; select.setAttribute('aria-hidden', 'true'); select.required = false;
  let expanded = false;

  function choose(value: string) {
    select.value = value;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function render() {
    const options = Array.from(select.options).filter(option => option.value)
      .map((option, index) => ({ option, index }))
      .sort((a, b) => (usage.get(b.option.value) ?? 0) - (usage.get(a.option.value) ?? 0) || categoryRank(a.option.text) - categoryRank(b.option.text) || a.index - b.index)
      .map(({ option }) => option);
    const collapsible = collapse && options.length > VISIBLE_CATEGORIES + 1;
    const visible = !collapsible || expanded ? options : options.slice(0, VISIBLE_CATEGORIES);
    const selected = options.find(option => option.value === select.value);
    if (selected && !visible.includes(selected)) visible.push(selected);
    const buttons = visible.map(option => {
      const tone = categoryTone(option.text, option.value);
      const button = document.createElement('button'); button.type = 'button'; button.className = `category-choice tone-${tone.tone}`;
      button.setAttribute('role', 'radio'); button.setAttribute('aria-checked', String(option.value === select.value));
      const badge = document.createElement('span'); badge.className = 'category-choice-icon'; badge.append(icon(tone.icon));
      const name = document.createElement('span'); name.className = 'category-choice-name'; name.textContent = option.text;
      button.append(badge, name);
      button.addEventListener('click', () => choose(option.value));
      return button;
    });
    if (collapsible) {
      const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'category-choice category-more';
      toggle.textContent = expanded ? '少なく表示' : `すべて表示（${options.length}）`;
      toggle.setAttribute('aria-expanded', String(expanded));
      toggle.addEventListener('click', () => { expanded = !expanded; render(); });
      buttons.push(toggle);
    }
    if (!options.length) { const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = 'カテゴリがありません。追加してください。'; picker.replaceChildren(empty); return; }
    picker.replaceChildren(...buttons);
  }

  select.addEventListener('input', render);
  select.addEventListener('change', render);
  // Options are replaced when a category is added from the form; the value is set right after.
  new MutationObserver(render).observe(select, { childList: true, subtree: true });
  render();
  select.after(picker);
  // Ordering is a convenience; without history the everyday order is kept.
  void usageReady.then(value => { usage = value; if (picker.isConnected) render(); }, () => undefined);
  return picker;
}

/**
 * docs/DESIGN.md 帳簿の行で組む入力: the category takes one row. It shows the chosen name, and
 * "すべて ›" opens a sheet with every category as buttons. The select keeps the value as before.
 */
export function categoryRow(options: {
  select: HTMLSelectElement; label: HTMLLabelElement; usageReady?: Promise<ReadonlyMap<string, number>>;
  /** Shown beside the name while the value is still the one filled in for the user. */
  hint?: { value: string; text: string } | null;
  extras?: HTMLElement[];
}) {
  const { select, label } = options;
  const row = document.createElement('div'); row.className = 'entry-row category-row';
  const value = document.createElement('div'); value.className = 'entry-row-value';
  const name = document.createElement('span'); name.className = 'category-row-name';
  const hint = document.createElement('span'); hint.className = 'entry-row-hint';
  const open = document.createElement('button'); open.type = 'button'; open.className = 'text-button entry-row-more';
  open.textContent = 'すべて ›'; open.setAttribute('aria-label', 'すべてのカテゴリから選ぶ'); open.setAttribute('aria-haspopup', 'dialog');
  value.append(select, name, hint);
  row.append(label, value, open);

  const sheet = document.createElement('dialog'); sheet.className = 'record-sheet category-sheet';
  const body = document.createElement('div'); body.className = 'sheet-body';
  const header = document.createElement('div'); header.className = 'page-header';
  const title = document.createElement('h2'); title.id = `category-sheet-title-${++pickerSequence}`; title.textContent = 'カテゴリを選ぶ';
  const close = document.createElement('button'); close.type = 'button'; close.className = 'icon-button'; close.setAttribute('aria-label', '閉じる'); close.append(icon('close'));
  close.addEventListener('click', () => sheet.close());
  header.append(title, close);
  sheet.setAttribute('aria-labelledby', title.id);
  const picker = enhanceCategorySelect(select, label, options.usageReady, false);
  body.append(header, picker, ...(options.extras ?? []));
  sheet.append(body);
  dismissOnBackdrop(sheet, () => sheet.close());
  open.addEventListener('click', () => sheet.showModal());
  // After a category is added from the sheet, the sheet has closed; focus returns to "すべて".
  sheet.addEventListener('return-focus', () => open.focus());
  // A modal dialog renders above everything wherever it sits, so the sheet stays with its row and leaves with the form.
  row.append(sheet);

  const render = () => {
    const option = select.selectedOptions[0];
    name.textContent = option && option.value ? option.text : '未選択';
    name.classList.toggle('is-empty', !option?.value);
    const shown = options.hint && select.value === options.hint.value ? options.hint.text : '';
    hint.textContent = shown; hint.hidden = !shown;
  };
  const chosen = () => { render(); if (sheet.open) sheet.close(); };
  select.addEventListener('input', chosen); select.addEventListener('change', chosen);
  new MutationObserver(render).observe(select, { childList: true, subtree: true });
  render();
  return { row, sheet, open: () => open.click() };
}

type RecentKinds = { getRecentTransactions(options: { limit: number }): Promise<Array<{ kind: string; categoryId?: string | null }>> };

/** docs/UX.md 支出の入力: the category of the latest record of the same kind, when it can still be chosen. */
export async function lastUsedCategory(ledger: RecentKinds, kind: 'expense' | 'income', available: ReadonlyArray<string>) {
  const rows = await ledger.getRecentTransactions({ limit: RECENT_USAGE_LIMIT });
  return rows.find(row => row.kind === kind && row.categoryId && available.includes(row.categoryId))?.categoryId ?? '';
}
