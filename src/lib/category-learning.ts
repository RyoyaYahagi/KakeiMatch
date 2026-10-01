import { z } from 'zod';
import { normalizeMerchant } from './category';

export const CATEGORY_LEARNING_MIN_RECEIPTS = 3;
export const CATEGORY_LEARNING_MIN_AGREEMENT_PERCENT = 80;
export function normalizeLearningName(value: string): string {
  const normalized = normalizeMerchant(value);
  return normalized.length <= 1000 ? normalized : '';
}
const name = z.string().min(1).max(1000).refine(value => normalizeLearningName(value) === value);
const category = z.string().min(1).max(128).nullable();
export const categoryLearningObservationSchema = z.object({
  targetType: z.literal('category-learning'), receiptId: z.string().min(1),
  normalizedMerchant: name, merchantCategoryId: category,
  items: z.array(z.object({ normalizedName: name, categoryId: category }).strict()).max(100),
  confirmedAt: z.string().datetime({ offset: true }),
}).strict();
export type CategoryLearningObservation = z.infer<typeof categoryLearningObservationSchema>;
export type LearnedCategoryRules = { merchants: Map<string, string>; items: Map<string, string> };

/** One current confirmation per receipt; ambiguity remains in the agreement denominator. */
export function deriveCategoryRules(observations: CategoryLearningObservation[], availableIds: Set<string>): LearnedCategoryRules {
  const current = new Map<string, CategoryLearningObservation>();
  for (const observation of observations) {
    const existing = current.get(observation.receiptId);
    if (!existing || existing.confirmedAt <= observation.confirmedAt) current.set(observation.receiptId, observation);
  }
  const merchants = new Map<string, Array<string | null>>();
  const items = new Map<string, Array<string | null>>();
  const add = (groups: Map<string, Array<string | null>>, key: string, categoryId: string | null) => {
    const votes = groups.get(key) ?? []; votes.push(categoryId); groups.set(key, votes);
  };
  for (const observation of current.values()) {
    add(merchants, observation.normalizedMerchant, observation.merchantCategoryId);
    const receiptItems = new Map<string, string | null>();
    for (const item of observation.items) {
      if (receiptItems.has(item.normalizedName) && receiptItems.get(item.normalizedName) !== item.categoryId) receiptItems.set(item.normalizedName, null);
      else if (!receiptItems.has(item.normalizedName)) receiptItems.set(item.normalizedName, item.categoryId);
    }
    for (const [key, categoryId] of receiptItems) add(items, key, categoryId);
  }
  const stable = (groups: Map<string, Array<string | null>>, rejectMixed = false) => {
    const rules = new Map<string, string>();
    for (const [key, votes] of groups) {
      if (votes.length < CATEGORY_LEARNING_MIN_RECEIPTS) continue;
      if (rejectMixed && votes.includes(null)) continue;
      const counts = new Map<string, number>();
      for (const vote of votes) if (vote && availableIds.has(vote)) counts.set(vote, (counts.get(vote) ?? 0) + 1);
      const winner = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
      if (winner && winner[1] >= CATEGORY_LEARNING_MIN_RECEIPTS && winner[1] * 100 >= votes.length * CATEGORY_LEARNING_MIN_AGREEMENT_PERCENT) rules.set(key, winner[0]);
    }
    return rules;
  };
  return { merchants: stable(merchants, true), items: stable(items) };
}
