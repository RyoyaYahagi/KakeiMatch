import "server-only";
import { z } from "zod";
import { CATEGORY_IDS, isCategoryId, type CategoryId } from "./category";
import { env } from "./env";

export const DEFAULT_TYPESAFE_API_URL = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_JEV_MODEL = "jev-latest";
export const DEFAULT_JEV_CATEGORY_MIN_PROBABILITY = 0.75;
export const DEFAULT_JEV_CATEGORY_MIN_MARGIN = 0.15;
export const JEV_CATEGORY_QUESTION_VERSION = "receipt-category-v1";
export const JEV_CATEGORY_TIMEOUT_MS = 8_000;
export const MAX_CATEGORY_ITEMS = 30;
export const MAX_CATEGORY_TEXT_LENGTH = 200;

export type CategoryClassificationInput = {
  merchant: string | null;
  totalAmountYen: number | null;
  items: Array<{ name: string; amountYen: number | null }>;
};

export type CategoryClassificationDecision = {
  category: CategoryId | null;
  selectedProbability: number | null;
  confidence: number | null;
  probabilities: Record<CategoryId, number> | null;
  needsReview: boolean;
  source: "jev" | "unclassified";
  model: string | null;
  questionVersion: string | null;
};

const probabilitySchema = z.number().finite().min(0).max(1);
const choiceAnswerSchema = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  probabilities: z.record(z.string(), probabilitySchema),
  confidence: probabilitySchema,
}).passthrough();
const responseSchema = z.object({
  model: z.string().trim().min(1),
  answers: z.object({ category: choiceAnswerSchema }),
}).passthrough();

const CATEGORY_CRITERIA: Record<CategoryId, string> = {
  food: "食料品、飲料、外食、飲食店。",
  household: "洗剤、ティッシュ、生活雑貨、日用品などの消耗品。",
  transport: "電車、バス、タクシー、駐車場、高速道路、ガソリンなど。",
  medical: "病院、薬局、医薬品、診療や医療に関する支出。",
  clothing: "衣類、靴、服飾品。",
  entertainment: "趣味、映画、ゲーム、レジャーなどの娯楽。",
  utilities: "電気、ガス、水道などの公共料金。",
  communications: "携帯電話、固定回線、インターネット通信の料金。",
  other: "上記に適切に当てはまらない、または複数用途で代表カテゴリを決めにくい購入。",
};

const unclassified = (): CategoryClassificationDecision => ({
  category: null,
  selectedProbability: null,
  confidence: null,
  probabilities: null,
  needsReview: true,
  source: "unclassified",
  model: null,
  questionVersion: null,
});

function validInput(input: CategoryClassificationInput): boolean {
  return (input.merchant?.trim().length ?? 0) > 0
    || input.items.some((item) => item.name.trim().length > 0);
}

/** Build only the minimum validated receipt facts sent to TypeSafe. */
export function buildJevCategoryRequest(input: CategoryClassificationInput, model: string) {
  const state = {
    receipt: {
      merchant: input.merchant?.trim().slice(0, MAX_CATEGORY_TEXT_LENGTH) || null,
      totalAmountYen: input.totalAmountYen,
      items: input.items.slice(0, MAX_CATEGORY_ITEMS).map(({ name, amountYen }) => ({
        name: name.trim().slice(0, MAX_CATEGORY_TEXT_LENGTH),
        amountYen,
      })),
    },
  };
  return {
    model,
    state,
    questions: {
      category: {
        type: "choice" as const,
        instructions: "この購入を家計簿の基本カテゴリから1つ選んでください。店舗名だけでなく商品明細を優先してください。複数カテゴリが混在し代表カテゴリを決めにくい場合は other を選んでください。",
        criteria: CATEGORY_CRITERIA,
      },
    },
  };
}

function parseProbabilities(value: Record<string, number>): Record<CategoryId, number> | null {
  const keys = Object.keys(value);
  if (keys.length !== CATEGORY_IDS.length || !CATEGORY_IDS.every((id) => Object.hasOwn(value, id))) return null;
  const probabilities = Object.fromEntries(CATEGORY_IDS.map((id) => [id, value[id]])) as Record<CategoryId, number>;
  const sum = CATEGORY_IDS.reduce((total, id) => total + probabilities[id], 0);
  return Math.abs(sum - 1) <= 0.02 ? probabilities : null;
}

function decisionFromResponse(value: unknown, minProbability: number, minMargin: number): CategoryClassificationDecision {
  const parsed = responseSchema.safeParse(value);
  if (!parsed.success) return unclassified();
  const answer = parsed.data.answers.category;
  const choice = answer.choice;
  if (!isCategoryId(choice)) return unclassified();
  const probabilities = parseProbabilities(answer.probabilities);
  if (!probabilities) return unclassified();
  const selectedProbability = probabilities[choice];
  const ranked = CATEGORY_IDS.map((id) => probabilities[id]).sort((a, b) => b - a);
  if (selectedProbability !== ranked[0]) return unclassified();
  const margin = ranked[0] - ranked[1];
  const highConfidence = selectedProbability >= minProbability && margin >= minMargin;
  if (!highConfidence) {
    return {
      category: null,
      selectedProbability,
      confidence: answer.confidence,
      probabilities,
      needsReview: true,
      source: "unclassified",
      model: parsed.data.model,
      questionVersion: JEV_CATEGORY_QUESTION_VERSION,
    };
  }
  return {
    category: choice,
    selectedProbability,
    confidence: answer.confidence,
    probabilities,
    needsReview: false,
    source: "jev",
    model: parsed.data.model,
    questionVersion: JEV_CATEGORY_QUESTION_VERSION,
  };
}

export type JevCategoryClassifierOptions = {
  apiKey?: string;
  apiUrl?: string;
  model?: string;
  minProbability?: number;
  minMargin?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export class JevCategoryClassifier {
  private readonly apiKey: string | undefined;
  private readonly apiUrl: string;
  private readonly model: string;
  private readonly minProbability: number;
  private readonly minMargin: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: JevCategoryClassifierOptions = {}) {
    this.apiKey = options.apiKey ?? env.TYPESAFE_API_KEY;
    this.apiUrl = options.apiUrl ?? env.TYPESAFE_API_URL ?? DEFAULT_TYPESAFE_API_URL;
    this.model = options.model ?? env.JEV_MODEL ?? DEFAULT_JEV_MODEL;
    this.minProbability = options.minProbability ?? env.JEV_CATEGORY_MIN_PROBABILITY ?? DEFAULT_JEV_CATEGORY_MIN_PROBABILITY;
    this.minMargin = options.minMargin ?? env.JEV_CATEGORY_MIN_MARGIN ?? DEFAULT_JEV_CATEGORY_MIN_MARGIN;
    this.timeoutMs = options.timeoutMs ?? JEV_CATEGORY_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async classify(input: CategoryClassificationInput): Promise<CategoryClassificationDecision> {
    if (!this.apiKey || !validInput(input)) return unclassified();
    const body = JSON.stringify(buildJevCategoryRequest(input, this.model));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(this.apiUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.apiKey}`,
          },
          body,
          signal: controller.signal,
        });
        if ((response.status === 429 || response.status === 529) && attempt === 0) {
          await response.body?.cancel().catch(() => undefined);
          await new Promise((resolve) => setTimeout(resolve, 100));
          continue;
        }
        if (!response.ok) return unclassified();
        let decoded: unknown;
        try {
          decoded = await response.json();
        } catch {
          return unclassified();
        }
        return decisionFromResponse(decoded, this.minProbability, this.minMargin);
      } catch {
        return unclassified();
      } finally {
        clearTimeout(timeout);
      }
    }
    return unclassified();
  }
}

export const jevCategoryClassifier = new JevCategoryClassifier();

export function classify(input: CategoryClassificationInput): Promise<CategoryClassificationDecision> {
  return jevCategoryClassifier.classify(input);
}
