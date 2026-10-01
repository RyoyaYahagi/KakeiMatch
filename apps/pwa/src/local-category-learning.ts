import { CATEGORY_LABELS, isCategoryId } from '../../../src/lib/category';
import type { ActualCategory } from '../../../src/lib/actual-ledger';
import type { LocalDataRecord, LocalDataRepository } from '../../../src/lib/local-data';
import { categoryLearningObservationSchema, deriveCategoryRules, normalizeLearningName, type CategoryLearningObservation } from '../../../src/lib/category-learning';
import type { ConfirmedReceiptValue } from './local-receipts';

export class LocalCategoryLearning {
  constructor(private readonly repository: LocalDataRepository) {}
  async suggest(input: { merchant: string | null; items: Array<{ name: string }>; categories: ActualCategory[] }): Promise<{
    merchantCategoryId: string | null; itemCategories: Array<string | null>; hasMerchantHistory: boolean;
  }> {
    const observations: CategoryLearningObservation[] = [];
    for (const { value } of await this.repository.list<Record<string, unknown>>('correction-audit')) {
      if (value?.targetType !== 'category-learning') continue;
      const parsed = categoryLearningObservationSchema.safeParse(value);
      if (!parsed.success) throw new Error('保存済みの分類履歴を確認できませんでした。バックアップと端末データを確認してください。');
      observations.push(parsed.data);
    }
    const rules = deriveCategoryRules(observations, new Set(input.categories.map(category => category.id)));
    const merchant = normalizeLearningName(input.merchant ?? '');
    return { merchantCategoryId: rules.merchants.get(merchant) ?? null,
      itemCategories: input.items.map(item => rules.items.get(normalizeLearningName(item.name)) ?? null),
      hasMerchantHistory: observations.some(observation => observation.normalizedMerchant === merchant) };
  }
  recordsForConfirmation(receiptId: string, value: ConfirmedReceiptValue, categories: ActualCategory[], confirmedAt: string): LocalDataRecord<CategoryLearningObservation>[] {
    const normalizedMerchant = normalizeLearningName(value.merchant);
    if (!normalizedMerchant) return [];
    const resolve = (id: string) => categories.find(category => category.id === id)?.id
      ?? (isCategoryId(id) ? categories.find(category => category.name === CATEGORY_LABELS[id])?.id : undefined) ?? null;
    const items = (value.items ?? []).map(item => ({ normalizedName: normalizeLearningName(item.name), categoryId: resolve(item.categoryId ?? value.categoryId) }))
      .filter(item => item.normalizedName.length > 0);
    const effective = new Set(value.items?.length ? value.items.map(item => resolve(item.categoryId ?? value.categoryId)) : [resolve(value.categoryId)]);
    const observation: CategoryLearningObservation = { targetType: 'category-learning', receiptId, normalizedMerchant,
      merchantCategoryId: effective.size === 1 ? [...effective][0]! : null, items, confirmedAt };
    categoryLearningObservationSchema.parse(observation);
    return [{ id: `category-learning:${receiptId}`, kind: 'correction-audit', value: observation, updatedAt: confirmedAt }];
  }
}
