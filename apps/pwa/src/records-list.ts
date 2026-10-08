import type { ActualTransaction } from '../../../src/lib/actual-ledger';
import { recordRow } from './record-row';

/* docs/UX.md 記録一覧: records grouped by day with the day's income and expense total. */
export type RecordKindFilter = 'all' | ActualTransaction['kind'];

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const yen = (value: number) => `¥${Math.abs(value).toLocaleString('ja-JP')}`;

function dayLabel(date: string) {
  const [year, month, day] = date.split('-').map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `${month}月${day}日（${weekday}）`;
}

function dayTotal(rows: ActualTransaction[]) {
  const total = rows.filter(row => row.kind !== 'transfer').reduce((sum, row) => sum + row.amountYen, 0);
  return total === 0 ? '' : `${total < 0 ? '−' : '+'}${yen(total)}`;
}

export function renderRecordGroups(target: HTMLElement, rows: ActualTransaction[], options: {
  filter: RecordKindFilter;
  accountName: (accountId: string) => string | null;
  hasReceipt: (row: ActualTransaction) => boolean;
  needsReview: (row: ActualTransaction) => boolean;
  open: (row: ActualTransaction) => void;
}) {
  target.replaceChildren();
  const visible = rows.filter(row => options.filter === 'all' || row.kind === options.filter);
  const days = new Map<string, ActualTransaction[]>();
  for (const row of visible) days.set(row.date, [...days.get(row.date) ?? [], row]);
  for (const [date, dayRows] of days) {
    const section = document.createElement('section'); section.className = 'surface-section record-day';
    const header = document.createElement('h3'); header.className = 'record-day-header';
    const label = document.createElement('span'); label.textContent = dayLabel(date);
    const total = document.createElement('span'); total.className = 'record-day-total'; total.textContent = dayTotal(dayRows);
    header.append(label, total);
    const list = document.createElement('ul'); list.className = 'record-rows';
    for (const row of dayRows) {
      const item = document.createElement('li');
      item.append(recordRow(row, options.accountName(row.accountId), () => options.open(row), { showDate: false, hasReceipt: options.hasReceipt(row), needsReview: options.needsReview(row), expenseMemoTitle: options.filter === 'expense' }));
      list.append(item);
    }
    section.append(header, list);
    target.append(section);
  }
  return visible.length;
}
