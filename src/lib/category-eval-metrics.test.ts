import { describe, expect, it } from "vitest";
import { summarizeCategoryEval } from "../../eval/category-eval-metrics";

describe("category evaluation metrics", () => {
  it("reports accuracy, automatic coverage, review rate, probability, and top margin", () => {
    const metrics = summarizeCategoryEval([
      { expected: "food", category: "food", needsReview: false, selectedProbability: 0.9, probabilities: { food: 0.9, household: 0.1, transport: 0, medical: 0, clothing: 0, entertainment: 0, utilities: 0, communications: 0, other: 0 } },
      { expected: "other", category: null, needsReview: true, selectedProbability: 0.5, probabilities: { food: 0.5, household: 0, transport: 0, medical: 0, clothing: 0, entertainment: 0, utilities: 0, communications: 0, other: 0.5 } },
      { expected: "medical", category: null, needsReview: true, selectedProbability: null, probabilities: null },
    ]);
    expect(metrics).toEqual({
      count: 3,
      accuracy: 1 / 3,
      automaticSuggestionCoverage: 1 / 3,
      reviewRate: 2 / 3,
      averageSelectedProbability: 0.7,
      averageTop1Top2Margin: 0.4,
      probabilitySampleCount: 2,
    });
  });
});
