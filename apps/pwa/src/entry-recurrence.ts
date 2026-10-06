import { recurringOccurrenceDates, type RecurringScheduleInput } from '../../../src/lib/recurring-schedule';
import type { Recurrence } from './entry-form';

/**
 * The schedule starts at the next occurrence after the record just saved,
 * so that record is never generated a second time by the schedule.
 */
export function nextOccurrence(date: string, frequency: Exclude<Recurrence, ''>) {
  const [year] = date.split('-').map(Number);
  // Nine years always include a later occurrence, even for 29 February across a skipped leap year.
  const through = `${String(year + 9).padStart(4, '0')}${date.slice(4)}`;
  return recurringOccurrenceDates({ frequency, startDate: date }, through)[1] ?? null;
}

export function scheduleFromEntry(entry: { name: string; kind: 'expense' | 'income'; amountYen: number; categoryId: string; accountId: string; date: string }, frequency: Exclude<Recurrence, ''>): RecurringScheduleInput | null {
  const startDate = nextOccurrence(entry.date, frequency);
  if (!startDate) return null;
  return { name: entry.name.trim(), kind: entry.kind, amountYen: entry.amountYen, categoryId: entry.categoryId, accountId: entry.accountId, frequency, startDate, postsTransaction: true };
}
