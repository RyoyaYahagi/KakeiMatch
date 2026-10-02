import type { ActualTransaction } from '../../../src/lib/actual-ledger';
import { categoryTone } from './category-tone';
import { icon } from './ui-icons';

/* One-line record row (docs/DESIGN.md 1行リスト): icon, title with a short note, and a right-aligned amount. */
const yen = (value: number) => `¥${Math.abs(value).toLocaleString('ja-JP')}`;
function span(className: string, value = '') { const node = document.createElement('span'); node.className = className; node.textContent = value; return node; }
function shortDate(date: string) { const [, month, day] = date.split('-'); return `${Number(month)}/${Number(day)}`; }

export function recordRow(row: ActualTransaction, accountName: string | null, open: () => void) {
  const kindLabel = row.kind === 'transfer' ? '振替' : row.kind === 'income' ? '収入' : null;
  const visual = row.kind === 'income' ? { tone: 'income', icon: 'income' as const }
    : row.kind === 'transfer' ? { tone: 'other', icon: 'transfer' as const }
    : categoryTone(row.categoryName ?? '', row.categoryId ?? null);
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'record-row';
  const badge = span(`record-icon tone-${visual.tone}`); badge.append(icon(visual.icon));
  const main = span('record-main');
  const title = row.payeeName || (row.kind === 'transfer' ? '口座間振替' : kindLabel ?? '支出');
  const note = [shortDate(row.date), kindLabel ?? row.categoryName, accountName].filter(Boolean).join(' · ');
  main.append(span('record-title', title), span('record-note', note));
  const sign = row.kind === 'income' ? '+' : row.kind === 'expense' ? (row.amountYen < 0 ? '−' : '+') : '';
  const amount = span(`record-amount amount-${row.kind}`, `${sign}${yen(row.amountYen)}`);
  button.append(badge, main, amount);
  button.addEventListener('click', open);
  return button;
}
