import type { ActualTransaction } from '../../../src/lib/actual-ledger';
import { categoryTone } from './category-tone';
import { icon } from './ui-icons';

/* One-line record row (docs/DESIGN.md 1行リスト): icon, title with a short note, and a right-aligned amount. */
const yen = (value: number) => `¥${Math.abs(value).toLocaleString('ja-JP')}`;
function span(className: string, value = '') { const node = document.createElement('span'); node.className = className; node.textContent = value; return node; }
function shortDate(date: string) { const [, month, day] = date.split('-'); return `${Number(month)}/${Number(day)}`; }

export function signedAmount(row: Pick<ActualTransaction, 'kind' | 'amountYen'>) {
  const sign = row.kind === 'transfer' ? '' : row.amountYen < 0 ? '−' : '+';
  return `${sign}${yen(row.amountYen)}`;
}

export function recordRow(row: ActualTransaction, accountName: string | null, open: () => void, options: { showDate?: boolean; hasReceipt?: boolean; needsReview?: boolean; expenseMemoTitle?: boolean } = {}) {
  const kindLabel = row.kind === 'transfer' ? '振替' : row.kind === 'income' ? '収入' : null;
  const visual = row.kind === 'income' ? { tone: 'income', icon: 'income' as const }
    : row.kind === 'transfer' ? { tone: 'other', icon: 'transfer' as const }
    : categoryTone(row.categoryName ?? '', row.categoryId ?? null);
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'record-row'; button.dataset.date = row.date;
  const badge = span(`record-icon tone-${visual.tone}`); badge.append(icon(visual.icon));
  const main = span('record-main');
  const memo = row.memo?.trim();
  const expenseMemoTitle = row.kind === 'expense' && options.expenseMemoTitle;
  const title = expenseMemoTitle ? memo || row.categoryName || '支出' : row.payeeName || (row.kind === 'transfer' ? '口座間振替' : kindLabel ?? '支出');
  const contextNote = row.kind === 'transfer' ? accountName : memo || accountName;
  const noteParts = [options.showDate === false ? null : shortDate(row.date),
    ...(expenseMemoTitle ? [row.payeeName, accountName] : [kindLabel ?? row.categoryName, contextNote]),
    options.hasReceipt ? 'レシート' : null].filter(Boolean);
  const note = span('record-note', noteParts.join(' · '));
  if (options.needsReview) { const mark = span('note-warning', '△ 要確認'); note.prepend(mark, document.createTextNode(noteParts.length ? ' · ' : '')); }
  main.append(span('record-title', title), note);
  const amountText = signedAmount(row);
  const amount = span(`record-amount amount-${row.kind}`, amountText);
  button.append(badge, main, amount);
  const spokenParts = options.showDate === false ? [shortDate(row.date), ...noteParts] : noteParts;
  button.setAttribute('aria-label', [title, ...spokenParts, ...(options.needsReview ? ['要確認'] : []), amountText].join(' · '));
  button.addEventListener('click', open);
  return button;
}

/** A row for a saved receipt that still needs confirmation before it becomes a record. */
export function pendingReceiptRow(title: string, open: () => void, remove?: () => void) {
  const row = document.createElement('div'); row.className = 'record-row pending-receipt-row';
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'pending-receipt-open';
  const badge = span('record-icon tone-pending'); badge.append(icon('receipt'));
  const main = span('record-main'); main.append(span('record-title', title), span('record-note', '内容を確認して登録してください'));
  const action = span('record-amount record-action', '確認する');
  button.append(badge, main, action);
  button.setAttribute('aria-label', `${title} · 確認する`);
  button.addEventListener('click', open);
  row.append(button);
  if (remove) {
    const removeButton = document.createElement('button'); removeButton.type = 'button'; removeButton.className = 'text-button destructive-text pending-receipt-delete';
    removeButton.textContent = '削除'; removeButton.setAttribute('aria-label', `削除: ${title}`); removeButton.addEventListener('click', remove);
    row.append(removeButton);
  }
  return row;
}
