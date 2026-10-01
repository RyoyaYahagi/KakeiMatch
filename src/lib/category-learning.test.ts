import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveCategoryRules, normalizeLearningName, type CategoryLearningObservation } from './category-learning';
import { LocalCategoryLearning } from '../../apps/pwa/src/local-category-learning';
import { LocalDataRepository } from './local-data';
import type { ConfirmedReceiptValue } from '../../apps/pwa/src/local-receipts';

const available = new Set(['food-custom', 'home-custom']);
const observation = (id: string, categoryId: string | null = 'food-custom'): CategoryLearningObservation => ({ targetType: 'category-learning', receiptId: id,
  normalizedMerchant: 'synthetic market', merchantCategoryId: categoryId,
  items: [{ normalizedName: 'synthetic milk', categoryId }], confirmedAt: '2026-10-01T00:00:00Z' });
const repositories: LocalDataRepository[] = [];
afterEach(() => { for (const repository of repositories.splice(0)) repository.close(); });
describe('confirmed category rules', () => {
  it('requires three independent receipts and at least 80% agreement', () => {
    expect(deriveCategoryRules([observation('a'), observation('b')], available).items.size).toBe(0);
    expect(deriveCategoryRules([observation('a'), observation('b'), observation('c')], available).items.get('synthetic milk')).toBe('food-custom');
    const mixed = [observation('a'), observation('b'), observation('c'), observation('d', 'home-custom')];
    expect(deriveCategoryRules(mixed, available).items.size).toBe(0);
    expect(deriveCategoryRules([...mixed, observation('e')], available).items.get('synthetic milk')).toBe('food-custom');
  });
  it('does not inflate evidence by repeated edits or duplicated receipt items', () => {
    const repeated = observation('a'); repeated.items.push({ ...repeated.items[0]! });
    expect(deriveCategoryRules([repeated, repeated, repeated], available).items.size).toBe(0);
    const newer = { ...observation('a', 'home-custom'), confirmedAt: '2026-10-02T00:00:00Z' };
    const rules = deriveCategoryRules([observation('a'), observation('b'), observation('c'), newer], available);
    expect(rules.items.size).toBe(0);
  });
  it('keeps mixed merchants unclassified even with a dominant historical category', () => {
    const history = [observation('a'), observation('b'), observation('c'), observation('d'), observation('e', null)];
    const rules = deriveCategoryRules(history, available);
    expect(rules.merchants.size).toBe(0);
    expect(rules.items.get('synthetic milk')).toBe('food-custom');
  });
  it('never selects deleted categories or inflates confidence by dropping their votes', () => {
    expect(deriveCategoryRules([observation('a'), observation('b'), observation('c')], new Set(['home-custom'])).items.size).toBe(0);
    const history = [observation('a'), observation('b'), observation('c'), observation('d', 'deleted'), observation('e', 'deleted')];
    expect(deriveCategoryRules(history, available).items.size).toBe(0);
  });
  it('normalizes conservatively and does not merge distinct long names by truncating them', () => {
    expect(normalizeLearningName('  Synthetic ＭＩＬＫ  ')).toBe('synthetic milk');
    expect(normalizeLearningName('x'.repeat(1001))).toBe('');
    expect(normalizeLearningName('Synthetic Milk 2')).not.toBe(normalizeLearningName('Synthetic Milk'));
  });
  it('stores one current confirmation per receipt and applies item rules before an ambiguous merchant', async () => {
    const repository = await LocalDataRepository.open(crypto.randomUUID()); repositories.push(repository);
    const learning = new LocalCategoryLearning(repository);
    const categories = [{ id: 'food-custom', name: 'Synthetic Food' }, { id: 'home-custom', name: 'Synthetic Home' }];
    const value: ConfirmedReceiptValue = { merchant: 'Synthetic Market', purchasedDate: '2026-10-01', purchasedTime: null,
      totalAmountYen: 200, accountId: 'synthetic-wallet', categoryId: 'food-custom', items: [
        { id: 'milk', name: 'Synthetic Milk', amountYen: 100, categoryId: 'food-custom' }, { id: 'soap', name: 'Synthetic Soap', amountYen: 100, categoryId: 'home-custom' } ] };
    for (const receiptId of ['a', 'b', 'c']) await repository.putRecords(learning.recordsForConfirmation(receiptId, value, categories, '2026-10-01T00:00:00Z'));
    await repository.putRecords(learning.recordsForConfirmation('a', value, categories, '2026-10-02T00:00:00Z'));
    expect(await repository.list('correction-audit')).toHaveLength(3);
    await expect(learning.suggest({ merchant: value.merchant, items: [{ name: 'Synthetic ＭＩＬＫ' }, { name: 'Synthetic Soap' }, { name: 'Unknown Synthetic Cable' }], categories })).resolves.toEqual({
      merchantCategoryId: null, itemCategories: ['food-custom', 'home-custom', null], hasMerchantHistory: true,
    });
    await expect(learning.suggest({ merchant: value.merchant, items: [{ name: 'Synthetic Milk' }], categories: [categories[1]!] })).resolves.toMatchObject({ itemCategories: [null] });
  });
});
