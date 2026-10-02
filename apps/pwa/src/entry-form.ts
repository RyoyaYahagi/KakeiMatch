/* Shared pieces of the entry forms (docs/UX.md 支出の入力). */

function shiftDay(date: string, offset: number) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + offset)).toISOString().slice(0, 10);
}

/** "今日" / "昨日" shortcuts next to a date input. The input stays the source of truth. */
export function dateShortcuts(input: HTMLInputElement, today: string) {
  const group = document.createElement('div'); group.className = 'date-shortcuts'; group.setAttribute('role', 'group'); group.setAttribute('aria-label', '日付をすぐに選ぶ');
  const [, month, day] = today.split('-').map(Number);
  const options = [[`今日 ${month}/${day}`, today], ['昨日', shiftDay(today, -1)]] as const;
  const buttons = options.map(([label, value]) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'chip'; button.textContent = label;
    button.addEventListener('click', () => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); sync(); });
    group.append(button);
    return [button, value] as const;
  });
  const sync = () => { for (const [button, value] of buttons) button.setAttribute('aria-pressed', String(input.value === value)); };
  input.addEventListener('input', sync); input.addEventListener('change', sync); sync();
  return group;
}

/** Optional fields folded away so the everyday form stays short. Opens when a value is already set. */
export function optionalFields(label: string, nodes: Node[], open: boolean) {
  const details = document.createElement('details'); details.className = 'optional-fields'; details.open = open;
  const summary = document.createElement('summary'); summary.textContent = label;
  details.append(summary, ...nodes);
  return details;
}

/** Bottom action bar that keeps the main button within thumb reach while the form scrolls. */
export function formActions(...buttons: HTMLButtonElement[]) {
  const bar = document.createElement('div'); bar.className = 'form-actions';
  bar.append(...buttons);
  return bar;
}
