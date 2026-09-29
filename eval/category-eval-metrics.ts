import type { CategoryId } from "../src/lib/category";

export type CategoryEvalOutcome = {
  expected: CategoryId;
  category: CategoryId | null;
  needsReview: boolean;
  selectedProbability: number | null;
  probabilities: Record<CategoryId, number> | null;
};

export function summarizeCategoryEval(outcomes: CategoryEvalOutcome[]) {
  const count = outcomes.length;
  const classified = outcomes.filter((result) => result.category !== null && !result.needsReview);
  const probabilityOutcomes = outcomes.filter((result) => result.probabilities !== null && result.selectedProbability !== null);
  const margins = probabilityOutcomes.map(({ probabilities }) => {
    const values = Object.values(probabilities as Record<CategoryId, number>).sort((a, b) => b - a);
    return values[0] - values[1];
  });
  return {
    count,
    accuracy: count === 0 ? 0 : outcomes.filter(({ expected, category, needsReview }) => !needsReview && category === expected).length / count,
    automaticSuggestionCoverage: count === 0 ? 0 : classified.length / count,
    reviewRate: count === 0 ? 0 : outcomes.filter(({ needsReview }) => needsReview).length / count,
    averageSelectedProbability: probabilityOutcomes.length === 0 ? null : probabilityOutcomes.reduce((sum, result) => sum + (result.selectedProbability ?? 0), 0) / probabilityOutcomes.length,
    averageTop1Top2Margin: margins.length === 0 ? null : margins.reduce((sum, margin) => sum + margin, 0) / margins.length,
    probabilitySampleCount: probabilityOutcomes.length,
  };
}
