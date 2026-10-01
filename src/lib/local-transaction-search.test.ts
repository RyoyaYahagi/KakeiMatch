import { describe, expect, it } from 'vitest';
import { attachReceiptSearchItems, emptySearchFilters, filterSearchTransactions, type SearchEntry } from '../../apps/pwa/src/local-transaction-search';
import type { LocalReceipt } from '../../apps/pwa/src/local-receipts';

const entries: SearchEntry[] = [
  { transaction: { id: 'expense', date: '2025-03-01', amountYen: -1200, kind: 'expense', payeeName: 'Synthetic ＣＡＦＥ', memo: 'テスト用メモ', categoryName: null, accountId: 'closed-wallet', cleared: false, isSplit: true }, categoryIds: ['food', 'home'], keywordValues: ['Synthetic Coffee'] },
  { transaction: { id: 'income', date: '2026-10-01', amountYen: 200000, kind: 'income', payeeName: 'Synthetic Salary', memo: null, categoryName: 'Salary', accountId: 'bank', cleared: false }, categoryIds: ['salary'], keywordValues: [] },
  { transaction: { id: 'transfer', date: '2026-10-01', amountYen: -5000, kind: 'transfer', payeeName: null, memo: 'Synthetic Savings', categoryName: null, accountId: 'closed-wallet', transferAccountId: 'bank', transferId: 'transfer-peer', cleared: false }, categoryIds: [], keywordValues: [] },
];
const ids = (value: SearchEntry[], filter: Partial<typeof emptySearchFilters> = {}) => filterSearchTransactions(value, { ...emptySearchFilters, ...filter }).map(row => row.id);
describe('transaction search', () => {
  it('matches payee, memo and item text with width/case normalization and stable date ordering', () => {
    expect(ids(entries)).toEqual(['income', 'transfer', 'expense']);
    expect(ids(entries, { keyword: '  cafe  ' })).toEqual(['expense']);
    expect(ids(entries, { keyword: 'メモ' })).toEqual(['expense']);
    expect(ids(entries, { keyword: 'coffee' })).toEqual(['expense']);
    expect(ids(entries, { keyword: 'salary' })).toEqual(['income']);
  });
  it('combines inclusive dates, child category, closed account and absolute whole-record amounts', () => {
    expect(ids(entries, { startDate: '2025-03-01', endDate: '2025-03-01', kind: 'expense', categoryId: 'home', accountId: 'closed-wallet', minAmountYen: 1200, maxAmountYen: 1200 })).toEqual(['expense']);
    expect(ids(entries, { categoryId: 'home', maxAmountYen: 500 })).toEqual([]);
    expect(ids(entries, { kind: 'income', accountId: 'bank', minAmountYen: 200000 })).toEqual(['income']);
    expect(ids(entries, { kind: 'transfer', accountId: 'bank' })).toEqual(['transfer']);
    expect(ids(entries, { kind: 'transfer', accountId: 'closed-wallet' })).toEqual(['transfer']);
    expect(ids(entries, { startDate: '2026-01-01' })).toEqual(['income', 'transfer']);
  });
  it('rejects reversed ranges, invalid days, fractions and unsafe integers', () => {
    for (const filter of [{ startDate: '2026-02-30' }, { startDate: '0000-01-01' }, { startDate: '2026-10-02', endDate: '2026-10-01' }, { minAmountYen: -1 }, { maxAmountYen: 1.5 }, { maxAmountYen: Number.MAX_SAFE_INTEGER + 1 }, { minAmountYen: 10, maxAmountYen: 5 }]) {
      expect(() => ids(entries, filter)).toThrow();
    }
  });
  it('uses current confirmed items, excluding removed extracted items and deleted/pending receipts', () => {
    const receipt: LocalReceipt = { id: 'synthetic-receipt', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', image: null,
      extraction: { documentKind: 'receipt', merchant: 'Synthetic', purchasedDate: '2025-03-01', purchasedTime: null, totalAmountYen: 1200, taxAmountYen: null, items: [{ name: 'Removed Synthetic Item', amountYen: 1200 }], warnings: [] },
      confirmedValue: { merchant: 'Synthetic', purchasedDate: '2025-03-01', purchasedTime: null, totalAmountYen: 1200, accountId: 'closed-wallet', categoryId: 'food', items: [{ id: 'item', name: 'Current Synthetic Item', amountYen: 1200, categoryId: 'food' }] },
      aiSuggestion: { categoryId: null, source: 'unclassified', probabilities: null, model: null, attemptedAt: null }, registration: { status: 'applied', actualTransactionId: 'expense', lastError: null } };
    expect(ids(attachReceiptSearchItems(entries, [receipt]), { keyword: 'Current Synthetic Item' })).toEqual(['expense']);
    expect(ids(attachReceiptSearchItems(entries, [receipt]), { keyword: 'Removed Synthetic Item' })).toEqual([]);
    expect(ids(attachReceiptSearchItems(entries, [{ ...receipt, registration: { ...receipt.registration, status: 'deleted' } }]), { keyword: 'Current Synthetic Item' })).toEqual([]);
    expect(ids(attachReceiptSearchItems(entries, [{ ...receipt, registration: { ...receipt.registration, status: 'pending' } }]), { keyword: 'Current Synthetic Item' })).toEqual([]);
    expect(ids(attachReceiptSearchItems(entries, [{ ...receipt, confirmedValue: { ...receipt.confirmedValue!, items: [] } }]), { keyword: 'Removed Synthetic Item' })).toEqual([]);
    expect(entries[0]!.keywordValues).toEqual(['Synthetic Coffee']);
  });
});
