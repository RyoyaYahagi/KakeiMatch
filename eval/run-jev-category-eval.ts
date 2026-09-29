import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { env } from "../src/lib/env";
import { isCategoryId, type CategoryId } from "../src/lib/category";
import { JevCategoryClassifier, type CategoryClassificationInput } from "../src/lib/jev-category-classifier";
import { summarizeCategoryEval, type CategoryEvalOutcome } from "./category-eval-metrics";

type EvalCase = { id: string; expected: CategoryId; input: CategoryClassificationInput };

async function main() {
  if (!process.argv.includes("--live")) {
    throw new Error("Live Jev requests are opt-in. Run with --live; this sends only the synthetic dataset to TypeSafe.");
  }
  if (!env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is required for live category evaluation.");
  const datasetPath = resolve(process.cwd(), "eval/category-eval-dataset.json");
  const dataset = JSON.parse(await readFile(datasetPath, "utf8")) as EvalCase[];
  if (dataset.length < 15 || dataset.length > 30 || dataset.some((item) => !isCategoryId(item.expected))) {
    throw new Error("Category eval dataset must contain 15–30 cases with known expected categories.");
  }

  const classifier = new JevCategoryClassifier();
  const outcomes: CategoryEvalOutcome[] = [];
  for (const item of dataset) {
    const result = await classifier.classify(item.input);
    outcomes.push({
      expected: item.expected,
      category: result.category,
      needsReview: result.needsReview,
      selectedProbability: result.selectedProbability,
      probabilities: result.probabilities,
    });
  }

  console.log(JSON.stringify({
    dataset: datasetPath,
    source: "live Jev; synthetic inputs only",
    model: env.JEV_MODEL,
    minimumProbability: env.JEV_CATEGORY_MIN_PROBABILITY,
    minimumMargin: env.JEV_CATEGORY_MIN_MARGIN,
    metrics: summarizeCategoryEval(outcomes),
    cases: dataset.map((item, index) => ({ id: item.id, ...outcomes[index] })),
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Category evaluation failed.");
  process.exitCode = 1;
});
