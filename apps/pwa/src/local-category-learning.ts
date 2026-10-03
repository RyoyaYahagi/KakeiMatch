import { CATEGORY_LABELS, isCategoryId } from '../../../src/lib/category';
import type { ActualCategory } from '../../../src/lib/actual-ledger';
import type { LocalDataRecord, LocalDataRepository } from '../../../src/lib/local-data';
import { categoryLearningObservationSchema, deriveCategoryRuleStats, normalizeLearningName, type CategoryLearningObservation } from '../../../src/lib/category-learning';
import type { ConfirmedReceiptValue } from './local-receipts';

const OVERRIDE_PREFIX = 'category-rule-override:';
type RuleOverride = { targetType: 'merchant' | 'item'; normalizedName: string; disabled?: boolean; deleted?: boolean; categoryId?: string };
export type LocalCategoryRule = {
  targetType: 'merchant' | 'item'; normalizedName: string; categoryId: string; receipts: number; matchingReceipts: number;
  agreementPercent: number; enabled: boolean; deleted: boolean;
};
export type AppliedCategoryRule = {
  targetType: 'merchant' | 'item'; normalizedName: string; categoryId: string; categoryName: string;
  receipts: number; matchingReceipts: number; agreementPercent: number;
};

function overrideId(targetType: RuleOverride['targetType'], normalizedName: string) {
  return `${OVERRIDE_PREFIX}${targetType}:${encodeURIComponent(normalizedName)}`;
}

export class LocalCategoryLearning {
  constructor(private readonly repository: LocalDataRepository) {}
  private async observations() {
    const observations: CategoryLearningObservation[] = [];
    for (const { value } of await this.repository.list<Record<string, unknown>>('correction-audit')) {
      if (value?.targetType !== 'category-learning') continue;
      const parsed = categoryLearningObservationSchema.safeParse(value);
      if (!parsed.success) throw new Error('保存済みの分類履歴を確認できませんでした。バックアップと端末データを確認してください。');
      observations.push(parsed.data);
    }
    return observations;
  }
  private async overrides() {
    const rows = await this.repository.list<Record<string, unknown>>('app-settings');
    return new Map(rows.filter(row => row.id.startsWith(OVERRIDE_PREFIX)).map(row => {
      const value = row.value;
      if (!value || (value.targetType !== 'merchant' && value.targetType !== 'item') || typeof value.normalizedName !== 'string'
        || normalizeLearningName(value.normalizedName) !== value.normalizedName
        || value.disabled !== undefined && typeof value.disabled !== 'boolean'
        || value.deleted !== undefined && typeof value.deleted !== 'boolean'
        || value.categoryId !== undefined && typeof value.categoryId !== 'string') {
        throw new Error('保存済みの分類ルール設定を確認できませんでした。バックアップと端末データを確認してください。');
      }
      if (row.id !== overrideId(value.targetType, value.normalizedName)) throw new Error('保存済みの分類ルール設定を確認できませんでした。バックアップと端末データを確認してください。');
      return [row.id, value as RuleOverride] as const;
    }));
  }
  async listRules(categories: ActualCategory[]): Promise<LocalCategoryRule[]> {
    const available = new Set(categories.map(category => category.id));
    const [observations, overrides] = await Promise.all([this.observations(), this.overrides()]);
    return deriveCategoryRuleStats(observations, available).map(rule => {
      const override = overrides.get(overrideId(rule.targetType, rule.normalizedName));
      return { ...rule, categoryId: override?.categoryId && available.has(override.categoryId) ? override.categoryId : rule.categoryId,
        enabled: !override?.disabled && !override?.deleted, deleted: !!override?.deleted };
    });
  }
  async setRuleOverride(rule: Pick<LocalCategoryRule, 'targetType' | 'normalizedName'>, changes: Partial<Pick<RuleOverride, 'disabled' | 'deleted' | 'categoryId'>>): Promise<void> {
    const id = overrideId(rule.targetType, rule.normalizedName);
    const existing = await this.repository.get<RuleOverride>(id);
    const value = { ...(existing?.value ?? { targetType: rule.targetType, normalizedName: rule.normalizedName }), ...changes };
    await this.repository.put({ id, kind: 'app-settings', value, updatedAt: new Date().toISOString() });
  }
  async resetRuleOverride(rule: Pick<LocalCategoryRule, 'targetType' | 'normalizedName'>): Promise<void> {
    await this.repository.delete(overrideId(rule.targetType, rule.normalizedName));
  }
  async resetAllRuleOverrides(): Promise<void> {
    const overrides = await this.overrides();
    for (const id of overrides.keys()) await this.repository.delete(id);
  }
  async suggest(input: { merchant: string | null; items: Array<{ name: string }>; categories: ActualCategory[] }): Promise<{
    merchantCategoryId: string | null; itemCategories: Array<string | null>; hasMerchantHistory: boolean;
    merchantRule: AppliedCategoryRule | null; itemRules: Array<AppliedCategoryRule | null>;
  }> {
    const observations = await this.observations();
    const available = new Set(input.categories.map(category => category.id));
    const rules = deriveCategoryRuleStats(observations, available);
    const overrides = await this.overrides();
    const activeRule = (type: RuleOverride['targetType'], name: string): AppliedCategoryRule | null => {
      const learned = rules.find(rule => rule.targetType === type && rule.normalizedName === name);
      if (!learned) return null;
      const override = overrides.get(overrideId(type, name));
      if (override?.disabled || override?.deleted) return null;
      const categoryId = override?.categoryId && available.has(override.categoryId) ? override.categoryId : learned.categoryId;
      const categoryName = input.categories.find(category => category.id === categoryId)?.name;
      if (!categoryName) return null;
      return { ...learned, categoryId, categoryName };
    };
    const merchant = normalizeLearningName(input.merchant ?? '');
    const merchantRule = activeRule('merchant', merchant);
    const itemRules = input.items.map(item => activeRule('item', normalizeLearningName(item.name)));
    return { merchantCategoryId: merchantRule?.categoryId ?? null,
      itemCategories: itemRules.map(rule => rule?.categoryId ?? null), merchantRule, itemRules,
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
