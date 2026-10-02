import { categoryRank, categoryTone } from './category-tone';
import { icon } from './ui-icons';

/* docs/UX.md 支出の入力: categories as buttons with icons. The native select stays the single source of the value. */
const VISIBLE_CATEGORIES = 7;
let pickerSequence = 0;

type RecentTransactions = { getRecentTransactions(options: { limit: number }): Promise<Array<{ categoryId?: string | null }>> };

/** How often each category was used in recent records. */
export async function recentCategoryUsage(ledger: RecentTransactions) {
  const usage = new Map<string, number>();
  for (const row of await ledger.getRecentTransactions({ limit: 200 })) if (row.categoryId) usage.set(row.categoryId, (usage.get(row.categoryId) ?? 0) + 1);
  return usage;
}

/** usage: recent use per category; frequently used categories come first once it resolves. */
export function enhanceCategorySelect(select: HTMLSelectElement, label: HTMLLabelElement, usageReady: Promise<ReadonlyMap<string, number>> = Promise.resolve(new Map())) {
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
    const collapsible = options.length > VISIBLE_CATEGORIES + 1;
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
