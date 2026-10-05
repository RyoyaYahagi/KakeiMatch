/* Shared pieces of the entry forms (docs/UX.md 支出の入力). */

function shiftDay(date: string, offset: number) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + offset)).toISOString().slice(0, 10);
}

/** "今日" / "昨日" shortcuts next to a date input. The input stays the source of truth. */
export function dateShortcuts(input: HTMLInputElement, today: string) {
  const group = document.createElement('div'); group.className = 'date-shortcuts'; group.setAttribute('role', 'group'); group.setAttribute('aria-label', '日付をすぐに選ぶ');
  const [, month, day] = today.split('-').map(Number);
  // Short labels keep the date itself readable in the row; the full date is in the accessible name.
  const options = [['今日', today, `今日 ${month}/${day}`], ['昨日', shiftDay(today, -1), '昨日']] as const;
  const buttons = options.map(([label, value, name]) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'chip'; button.textContent = label;
    if (name !== label) button.setAttribute('aria-label', name);
    button.addEventListener('click', () => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); sync(); });
    group.append(button);
    return [button, value] as const;
  });
  const sync = () => { for (const [button, value] of buttons) button.setAttribute('aria-pressed', String(input.value === value)); };
  input.addEventListener('input', sync); input.addEventListener('change', sync); sync();
  return group;
}

/** Optional fields folded away so the everyday form stays short. Opens when a value is already set. */
export function optionalFields(label: string, nodes: Node[], open: boolean, hint = '任意') {
  const details = document.createElement('details'); details.className = 'optional-fields'; details.open = open;
  const summary = document.createElement('summary');
  const name = document.createElement('span'); name.className = 'entry-row-key'; name.textContent = label;
  const value = document.createElement('span'); value.className = 'entry-row-hint'; value.textContent = hint;
  summary.append(name, value);
  details.append(summary, ...nodes);
  return details;
}

/** Bottom action bar that keeps the main button within thumb reach while the form scrolls. */
export function formActions(...buttons: HTMLButtonElement[]) {
  const bar = document.createElement('div'); bar.className = 'form-actions';
  bar.append(...buttons);
  return bar;
}

/** docs/DESIGN.md 帳簿の行で組む入力: label on the left, the value in the middle, a small action on the right. */
export function entryRow(label: HTMLElement, control: HTMLElement, ...accessories: Node[]) {
  const row = document.createElement('div'); row.className = 'entry-row';
  const value = document.createElement('div'); value.className = 'entry-row-value'; value.append(control);
  row.append(label, value);
  if (accessories.length) { const side = document.createElement('div'); side.className = 'entry-row-side'; side.append(...accessories); row.append(side); }
  return row;
}

/** A label whose visible words are short; the hidden part keeps the field's full name for screen readers. */
export function shortLabel(id: string, visible: string, hidden = '', hiddenBefore = '') {
  const label = document.createElement('label'); label.htmlFor = id;
  const hiddenPart = (value: string) => { const part = document.createElement('span'); part.className = 'visually-hidden'; part.textContent = value; return part; };
  if (hiddenBefore) label.append(hiddenPart(hiddenBefore));
  label.append(document.createTextNode(visible));
  if (hidden) label.append(hiddenPart(hidden));
  return label;
}

/** In a ledger row the add-account button stays short; its name still says what it adds. */
export function compactAddButton(button: HTMLButtonElement) {
  button.setAttribute('aria-label', button.textContent ?? '');
  button.textContent = '＋ 追加';
  return button;
}

export type Recurrence = '' | 'monthly' | 'weekly' | 'yearly';

/** docs/UX.md 支出の入力: "くり返し" turns a new record into a schedule as well. Off by default. */
export function recurrenceRow(id: string) {
  const label = document.createElement('label'); label.htmlFor = id; label.textContent = 'くり返し';
  const select = document.createElement('select'); select.id = id;
  select.append(new Option('しない', ''), new Option('毎月', 'monthly'), new Option('毎週', 'weekly'), new Option('毎年', 'yearly'));
  const hint = document.createElement('span'); hint.className = 'entry-row-hint';
  const sync = () => { hint.textContent = select.value ? '定期登録も作ります' : ''; };
  select.addEventListener('change', sync); sync();
  return { row: entryRow(label, select, hint), select, value: () => select.value as Recurrence };
}
