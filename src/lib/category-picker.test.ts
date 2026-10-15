import { describe, expect, it } from 'vitest';
import { categoryChoices, categoryUsage, sortCategoriesByUsage } from '../../apps/pwa/src/category-picker';

describe('expense category menu usage', () => {
  it('counts categories once per expense, includes split categories, and ignores transfers and income', async () => {
    const usage = await categoryUsage({ getSearchTransactions: async () => [
      { transaction: { kind: 'expense' }, categoryIds: ['food'] },
      { transaction: { kind: 'expense' }, categoryIds: ['food', 'other', 'food'] },
      { transaction: { kind: 'expense' }, categoryIds: [] },
      { transaction: { kind: 'transfer' }, categoryIds: ['other'] },
      { transaction: { kind: 'income' }, categoryIds: ['other'] },
    ] }, 'expense');
    expect([...usage]).toEqual([['food', 2], ['other', 1]]);
  });
});

describe('category choice ordering', () => {
  it('uses all records, counts income and split categories, and excludes transfers', async () => {
    const rows = Array.from({ length: 120 }, () => ({ transaction: { kind: 'expense' }, categoryIds: ['custom', 'custom', 'food'] }));
    rows.push({ transaction: { kind: 'income' }, categoryIds: ['salary'] }, { transaction: { kind: 'transfer' }, categoryIds: ['salary'] });
    const ledger = { getSearchTransactions: async () => rows };
    expect([...await categoryUsage(ledger)]).toEqual([['custom', 120], ['food', 120], ['salary', 1]]);
    const categories = [{ id: 'unused', name: '日用品' }, { id: 'salary', name: '給与' }, { id: 'custom', name: '趣味' }];
    expect((await categoryChoices(ledger, Promise.resolve(categories))).map(row => row.id)).toEqual(['custom', 'salary', 'unused']);
    expect(categories.map(row => row.id)).toEqual(['unused', 'salary', 'custom']);
  });

  it('uses the everyday order for ties and preserves the order of custom categories', () => {
    const categories = [{ id: 'custom-b', name: '独自B' }, { id: 'daily', name: '日用品' }, { id: 'custom-a', name: '独自A' }, { id: 'food', name: '食費' }];
    expect(sortCategoriesByUsage(categories, new Map()).map(row => row.id)).toEqual(['food', 'daily', 'custom-b', 'custom-a']);
    expect(sortCategoriesByUsage(categories, new Map([['custom-a', 3], ['daily', 2]])).map(row => row.id)).toEqual(['custom-a', 'daily', 'food', 'custom-b']);
  });

  it('propagates history failures to the screen error handler', async () => {
    await expect(categoryChoices({ getSearchTransactions: async () => { throw new Error('history unavailable'); } }, Promise.resolve([]))).rejects.toThrow('history unavailable');
  });
});
