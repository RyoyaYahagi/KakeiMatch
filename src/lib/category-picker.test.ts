import { describe, expect, it } from 'vitest';
import { expenseCategoryUsage } from '../../apps/pwa/src/category-picker';

describe('expense category menu usage', () => {
  it('counts categories once per expense, includes split categories, and ignores transfers and income', async () => {
    const usage = await expenseCategoryUsage({ getSearchTransactions: async () => [
      { transaction: { kind: 'expense' }, categoryIds: ['food'] },
      { transaction: { kind: 'expense' }, categoryIds: ['food', 'other', 'food'] },
      { transaction: { kind: 'expense' }, categoryIds: [] },
      { transaction: { kind: 'transfer' }, categoryIds: ['other'] },
      { transaction: { kind: 'income' }, categoryIds: ['other'] },
    ] });
    expect([...usage]).toEqual([['food', 2], ['other', 1]]);
  });
});
