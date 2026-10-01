import { z } from 'zod';
import type { ActualTransaction } from '../../../src/lib/actual-ledger';
import type { LocalReceipt } from './local-receipts';

export type SearchEntry = { transaction: ActualTransaction; categoryIds: string[]; keywordValues: string[] };
export type TransactionSearchFilters = {
  keyword: string; startDate: string; endDate: string;
  kind: '' | 'expense' | 'income' | 'transfer'; categoryId: string; accountId: string;
  minAmountYen: number | null; maxAmountYen: number | null;
};
export const emptySearchFilters: TransactionSearchFilters = {
  keyword: '', startDate: '', endDate: '', kind: '', categoryId: '', accountId: '', minAmountYen: null, maxAmountYen: null,
};
const optionalDate = z.union([z.literal(''), z.iso.date().refine(value => Number(value.slice(0, 4)) >= 1)]);
const filterSchema = z.object({
  keyword: z.string().max(200), startDate: optionalDate, endDate: optionalDate,
  kind: z.enum(['', 'expense', 'income', 'transfer']), categoryId: z.string(), accountId: z.string(),
  minAmountYen: z.number().int().safe().nonnegative().nullable(), maxAmountYen: z.number().int().safe().nonnegative().nullable(),
}).strict();
const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase('ja-JP').trim().replace(/\s+/g, ' ');

/** Items enrich only their current, registered native transaction; deleted originals never become results. */
export function attachReceiptSearchItems(entries: SearchEntry[], receipts: LocalReceipt[]): SearchEntry[] {
  const byTransaction = new Map(receipts.filter(receipt => receipt.registration.status === 'applied' && receipt.registration.actualTransactionId)
    .map(receipt => [receipt.registration.actualTransactionId!, receipt]));
  return entries.map(entry => {
    const receipt = byTransaction.get(entry.transaction.id);
    const items = receipt?.confirmedValue?.items ?? receipt?.extraction?.items ?? [];
    return { ...entry, keywordValues: [...entry.keywordValues, ...items.map(item => item.name)] };
  });
}

/** Every non-empty filter is ANDed; amounts use the whole transaction's absolute yen. */
export function filterSearchTransactions(entries: SearchEntry[], filters: TransactionSearchFilters): ActualTransaction[] {
  const parsed = filterSchema.safeParse(filters);
  if (!parsed.success) throw new Error('検索条件の日付・金額を確認してください。金額は0円以上の整数で入力してください。');
  const value = parsed.data;
  if (value.startDate && value.endDate && value.startDate > value.endDate) throw new Error('開始日は終了日以前にしてください。');
  if (value.minAmountYen !== null && value.maxAmountYen !== null && value.minAmountYen > value.maxAmountYen) throw new Error('最低金額は最高金額以下にしてください。');
  const keyword = normalize(value.keyword);
  return entries.filter(entry => {
    const row = entry.transaction;
    const amount = Math.abs(row.amountYen);
    return (!keyword || [row.payeeName ?? '', row.memo ?? '', ...entry.keywordValues].some(text => normalize(text).includes(keyword)))
      && (!value.startDate || row.date >= value.startDate) && (!value.endDate || row.date <= value.endDate)
      && (!value.kind || row.kind === value.kind)
      && (!value.categoryId || entry.categoryIds.includes(value.categoryId))
      && (!value.accountId || row.accountId === value.accountId || row.kind === 'transfer' && row.transferAccountId === value.accountId)
      && (value.minAmountYen === null || amount >= value.minAmountYen) && (value.maxAmountYen === null || amount <= value.maxAmountYen);
  }).map(entry => entry.transaction).sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}
