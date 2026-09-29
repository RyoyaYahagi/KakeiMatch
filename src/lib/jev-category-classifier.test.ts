import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

import { CATEGORY_IDS } from "./category";
import { JevCategoryClassifier, buildJevCategoryRequest, JEV_CATEGORY_QUESTION_VERSION } from "./jev-category-classifier";

const sample = { merchant: "Synthetic Market", totalAmountYen: 1200, items: [{ name: "Synthetic cereal", amountYen: 1200 }] };

function providerBody(choice = "food", selected = 0.86, runnerUp = 0.04) {
  const runnerUpCategory = choice === "other" ? "food" : "other";
  const probabilities = Object.fromEntries(CATEGORY_IDS.map((id) => [id, id === choice ? selected : id === runnerUpCategory ? runnerUp : (1 - selected - runnerUp) / 7]));
  return { model: "jev-latest", answers: { category: { type: "choice", choice, probabilities, confidence: 0.61 } } };
}

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("JevCategoryClassifier", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("sends only bounded extraction fields with fixed categories including other", () => {
    const input = { ...sample, items: Array.from({ length: 35 }, (_, i) => ({ name: `item-${i}`, amountYen: i })) };
    const request = buildJevCategoryRequest(input, "jev-latest");
    expect(request.state.receipt.items).toHaveLength(30);
    expect(request.state.receipt).toEqual(expect.objectContaining({ merchant: sample.merchant, totalAmountYen: sample.totalAmountYen }));
    expect(request.questions.category.criteria).toHaveProperty("other");
    expect(JSON.stringify(request)).not.toMatch(/receiptId|storageKey|userId|email|image/i);
  });

  it("returns a suggestion only when selected probability and margin meet thresholds", async () => {
    const classifier = new JevCategoryClassifier({ apiKey: "secret", fetchImpl: vi.fn(async () => okResponse(providerBody())) });
    const decision = await classifier.classify(sample);
    expect(decision).toMatchObject({ category: "food", selectedProbability: 0.86, confidence: 0.61, needsReview: false, source: "jev", model: "jev-latest", questionVersion: JEV_CATEGORY_QUESTION_VERSION });
  });

  it("does not use confidence alone when probability is low or margin is small", async () => {
    const low = new JevCategoryClassifier({ apiKey: "secret", fetchImpl: vi.fn(async () => okResponse(providerBody("food", 0.7, 0.1))) });
    expect(await low.classify(sample)).toMatchObject({ category: null, needsReview: true, source: "unclassified", confidence: 0.61 });
    const close = new JevCategoryClassifier({ apiKey: "secret", fetchImpl: vi.fn(async () => okResponse(providerBody("food", 0.5, 0.45))) });
    expect(await close.classify(sample)).toMatchObject({ category: null, needsReview: true, source: "unclassified" });
  });

  it("permits high-confidence other and rejects unknown category values", async () => {
    const other = new JevCategoryClassifier({ apiKey: "secret", fetchImpl: vi.fn(async () => okResponse(providerBody("other", 0.86, 0.04))) });
    expect(await other.classify(sample)).toMatchObject({ category: "other", source: "jev", needsReview: false });
    const unknown = new JevCategoryClassifier({ apiKey: "secret", fetchImpl: vi.fn(async () => okResponse(providerBody("unclassified", 0.86, 0.04))) });
    expect(await unknown.classify(sample)).toMatchObject({ category: null, source: "unclassified", needsReview: true, probabilities: null });
  });

  it("rejects malformed envelopes, missing categories, bad distributions, and unknown probability keys", async () => {
    for (const body of [
      {},
      { model: "jev-latest", answers: {} },
      { model: "jev-latest", answers: { category: { ...providerBody().answers.category, type: undefined } } },
      { ...providerBody(), answers: { category: { ...providerBody().answers.category, choice: "household" } } },
      { ...providerBody(), answers: { category: { ...providerBody().answers.category, probabilities: { ...providerBody().answers.category.probabilities, food: 0.99 } } } },
      { ...providerBody(), answers: { category: { ...providerBody().answers.category, probabilities: { ...providerBody().answers.category.probabilities, surprise: 0 } } } },
    ]) {
      const classifier = new JevCategoryClassifier({ apiKey: "secret", fetchImpl: vi.fn(async () => okResponse(body)) });
      expect(await classifier.classify(sample)).toMatchObject({ category: null, source: "unclassified", needsReview: true });
    }
  });

  it("falls back on HTTP errors and retries 429/529 at most once", async () => {
    for (const status of [401, 422, 500]) {
      const fetchImpl = vi.fn(async () => new Response("provider detail", { status }));
      const classifier = new JevCategoryClassifier({ apiKey: "secret", fetchImpl });
      expect(await classifier.classify(sample)).toMatchObject({ category: null, source: "unclassified" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
    for (const status of [429, 529]) {
      const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(null, { status })).mockResolvedValueOnce(okResponse(providerBody()));
      const classifier = new JevCategoryClassifier({ apiKey: "secret", fetchImpl });
      expect(await classifier.classify(sample)).toMatchObject({ category: "food", source: "jev" });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    }
    const alwaysRateLimited = vi.fn(async () => new Response(null, { status: 529 }));
    expect(await new JevCategoryClassifier({ apiKey: "secret", fetchImpl: alwaysRateLimited }).classify(sample)).toMatchObject({ category: null });
    expect(alwaysRateLimited).toHaveBeenCalledTimes(2);
  });

  it("handles timeout, missing key, and missing classification facts as unclassified", async () => {
    const timeoutFetch: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
    const timeout = new JevCategoryClassifier({ apiKey: "secret", timeoutMs: 1, fetchImpl: timeoutFetch });
    expect(await timeout.classify(sample)).toMatchObject({ category: null, source: "unclassified", needsReview: true });
    const fetchImpl = vi.fn(async () => okResponse(providerBody()));
    expect(await new JevCategoryClassifier({ apiKey: "" , fetchImpl }).classify(sample)).toMatchObject({ category: null });
    expect(await new JevCategoryClassifier({ apiKey: "secret", fetchImpl }).classify({ merchant: null, totalAmountYen: null, items: [] })).toMatchObject({ category: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps the API key out of the request body", async () => {
    let sentUrl: string | URL | Request | undefined;
    let sentInit: RequestInit | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      sentUrl = input;
      sentInit = init;
      return okResponse(providerBody());
    };
    await new JevCategoryClassifier({ apiKey: "secret-only-key", fetchImpl }).classify(sample);
    expect(sentUrl).toBe("https://api.typesafe.ai/v1/systemone");
    expect(sentInit?.headers).toMatchObject({ authorization: "Bearer secret-only-key" });
    expect(sentInit?.body).not.toContain("secret-only-key");
  });
});
