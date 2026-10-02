import { icon, type IconName } from './ui-icons';

/* Building blocks for the screens under 設定 (docs/UX.md 設定の奥の画面). */
function node<K extends keyof HTMLElementTagNameMap>(tag: K, value?: string, className = '') {
  const element = document.createElement(tag);
  if (value !== undefined) element.textContent = value;
  if (className) element.className = className;
  return element;
}

/** Top-left back link. The spoken name can say where it goes when the visible label is short. */
export function backLink(label: string, spokenName: string, action: () => unknown) {
  const button = node('button', label, 'text-button back-link');
  button.type = 'button';
  if (spokenName !== label) button.setAttribute('aria-label', spokenName);
  button.prepend(icon('chevronLeft'));
  button.addEventListener('click', () => { void action(); });
  return button;
}

export function pageTitle(text: string) { return node('h2', text, 'page-title'); }

export function iconBadge(name: IconName, tone: string, large = false) {
  const badge = node('span', undefined, `record-icon tone-${tone}${large ? ' record-icon-large' : ''}`);
  badge.append(icon(name));
  return badge;
}

/** One tappable row: icon, title with a short note, an optional value on the right, and a chevron. */
export function entryRow(options: { icon: IconName; tone: string; title: string; note?: string; value?: string; valueClass?: string; spokenName?: string; onClick: () => unknown; dimmed?: boolean }) {
  const button = node('button', undefined, `record-row settings-row${options.dimmed ? ' dimmed' : ''}`);
  button.type = 'button';
  const main = node('span', undefined, 'record-main');
  main.append(node('span', options.title, 'record-title'));
  if (options.note) main.append(node('span', options.note, 'record-note'));
  button.append(iconBadge(options.icon, options.tone), main);
  if (options.value) button.append(node('span', options.value, `record-amount ${options.valueClass ?? ''}`.trim()));
  button.append(icon('chevronRight'));
  if (options.spokenName) button.setAttribute('aria-label', options.spokenName);
  button.addEventListener('click', () => { void options.onClick(); });
  return button;
}

/** A rounded section holding rows separated by lines. */
export function rowList(rows: HTMLElement[], className = '') {
  const section = node('section', undefined, `surface-section settings-rows ${className}`.trim());
  const list = node('ul');
  for (const row of rows) { const item = node('li'); item.append(row); list.append(item); }
  section.append(list);
  return section;
}

/** Icon, large name and a short description at the top of a detail screen. */
export function detailHero(iconName: IconName, tone: string, title: string, subtitle: string) {
  const hero = node('div', undefined, 'detail-hero');
  const text = node('div');
  text.append(node('div', title, 'detail-hero-title'), node('div', subtitle, 'detail-hero-subtitle'));
  hero.append(iconBadge(iconName, tone, true), text);
  return hero;
}

/** Label on the left, value on the right, inside a section. */
export function detailList(pairs: Array<[string, string | HTMLElement]>, className = '') {
  const list = node('dl', undefined, `transaction-detail surface-section ${className}`.trim());
  for (const [label, value] of pairs) {
    const row = node('div', undefined, 'detail-row');
    row.dataset.detail = label;
    const dd = node('dd');
    if (typeof value === 'string') dd.textContent = value; else dd.append(value);
    row.append(node('dt', label), dd);
    list.append(row);
  }
  return list;
}

export function groupTitle(text: string) { return node('h3', text, 'settings-group-title'); }

/** Actions kept above the bottom navigation; the first button is the main one. */
export function pageActions(...buttons: HTMLButtonElement[]) {
  const bar = node('div', undefined, 'page-actions');
  bar.append(...buttons);
  return bar;
}

export function mainAction(label: string, iconName: IconName | null, action: () => unknown, spokenName?: string) {
  const button = node('button', label);
  button.type = 'button';
  if (iconName) button.prepend(icon(iconName));
  if (spokenName && spokenName !== label) button.setAttribute('aria-label', spokenName);
  button.addEventListener('click', () => { void action(); });
  return button;
}
