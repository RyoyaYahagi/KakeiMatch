import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  deriveNeedsReview,
  ReceiptExtractionError,
  receiptExtractionJsonSchema,
  validateReceiptExtraction,
} from "./receipt-extraction";
import { GeminiReceiptExtractor } from "./gemini-receipt-extractor";

const goodResult = {
  documentKind: "receipt",
  merchant: "人工スーパー",
  purchasedDate: "2026-09-28",
  purchasedTime: "18:30",
  totalAmountYen: 1280,
  taxAmountYen: 116,
  items: [{ name: "人工りんご", amountYen: 300 }],
  adjustments: [],
  warnings: [],
};

function extractorReturning(response: unknown) {
  const create = vi.fn().mockResolvedValue(response);
  const extractor = new GeminiReceiptExtractor({ apiKey: "test-key", client: { interactions: { create } } as never });
  return { extractor, create };
}

describe("receipt extraction schema and review derivation", () => {
  it("accepts a valid result and derives review from missing fields and warnings", () => {
    const result = validateReceiptExtraction(goodResult);
    expect(result).toEqual(goodResult);
    expect(deriveNeedsReview(result)).toBe(false);
    expect(deriveNeedsReview(validateReceiptExtraction({ ...goodResult, totalAmountYen: null }))).toBe(true);
    expect(deriveNeedsReview(validateReceiptExtraction({ ...goodResult, merchant: null }))).toBe(true);
    expect(deriveNeedsReview(validateReceiptExtraction({ ...goodResult, purchasedDate: null }))).toBe(true);
    expect(deriveNeedsReview(validateReceiptExtraction({
      ...goodResult,
      warnings: [{ field: "purchasedTime", code: "unreadable", message: "時刻を読み取れません" }],
    }))).toBe(true);
    expect(deriveNeedsReview(validateReceiptExtraction({ ...goodResult, documentKind: "not_receipt" }))).toBe(true);
  });

  it("rejects negative and decimal amounts and malformed schema values", () => {
    expect(() => validateReceiptExtraction({ ...goodResult, totalAmountYen: -1 })).toThrow(ReceiptExtractionError);
    expect(() => validateReceiptExtraction({ ...goodResult, totalAmountYen: 1.5 })).toThrow(ReceiptExtractionError);
    expect(() => validateReceiptExtraction({ ...goodResult, purchasedDate: "2026-02-30" })).toThrow(ReceiptExtractionError);
    expect(() => validateReceiptExtraction({ ...goodResult, items: "not an array" })).toThrow(ReceiptExtractionError);
    expect(() => validateReceiptExtraction({ ...goodResult, items: [{ name: "人工りんご", amountYen: Number.MAX_SAFE_INTEGER + 1 }] })).toThrow(ReceiptExtractionError);
    expect(() => validateReceiptExtraction({ ...goodResult, adjustments: [{ label: "割引", amountYen: -1.5 }] })).toThrow(ReceiptExtractionError);
    expect(() => validateReceiptExtraction({ ...goodResult, adjustments: [{ label: "割引", amountYen: -100, targetItemIndex: 1 }] })).toThrow(ReceiptExtractionError);
    expect(() => validateReceiptExtraction({ ...goodResult, documentKind: "receipt", unknown: "extra" })).toThrow(ReceiptExtractionError);
  });

  it("keeps the generated Gemini schema aligned with runtime fields", () => {
    const properties = (receiptExtractionJsonSchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(properties)).toEqual([
      "documentKind", "merchant", "purchasedDate", "purchasedTime", "totalAmountYen", "taxAmountYen", "items", "adjustments", "warnings",
    ]);
    expect(JSON.stringify(receiptExtractionJsonSchema)).not.toContain("category");
    expect(JSON.stringify(receiptExtractionJsonSchema)).not.toMatch(/anyOf|\$schema|minLength|pattern/);
    expect((properties.totalAmountYen as { type: string[] }).type).toEqual(["integer", "null"]);
    expect((properties.merchant as { type: string[] }).type).toEqual(["string", "null"]);
  });

  it("accepts quantity, unit price and signed adjustments while preserving old results", () => {
    const result = validateReceiptExtraction({
      ...goodResult,
      items: [{ name: "人工りんご", amountYen: 600, quantity: 2, unitPriceYen: 300 }],
      adjustments: [{ label: "商品割引", amountYen: -100, targetItemIndex: 0 }],
      warnings: [{ field: "adjustments", code: "uncertain_target", message: "対象商品を確認してください" }],
    });
    expect(result.adjustments?.[0]).toEqual({ label: "商品割引", amountYen: -100, targetItemIndex: 0 });
    const { adjustments: _ignored, ...legacyResult } = goodResult;
    expect(validateReceiptExtraction(legacyResult)).toEqual(legacyResult);
  });
});

describe("GeminiReceiptExtractor", () => {
  it("sends inline image with structured output and does not store the interaction", async () => {
    const { extractor, create } = extractorReturning({ output_text: JSON.stringify(goodResult) });
    const actual = await extractor.extract({ imageBytes: Buffer.from("synthetic-image"), contentType: "image/jpeg" });
    expect(actual).toEqual(goodResult);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      model: "gemini-3.5-flash-lite",
      store: false,
      response_format: expect.objectContaining({ type: "text", mime_type: "application/json" }),
      input: expect.arrayContaining([
        expect.objectContaining({ type: "image", data: Buffer.from("synthetic-image").toString("base64"), mime_type: "image/jpeg" }),
      ]),
    }), { timeout_ms: 30_000, retries: { strategy: "none" } });
    const sent = JSON.stringify(create.mock.calls[0]?.[0]);
    expect(sent).not.toContain("email");
    expect(sent).not.toContain("userId");
    expect(sent).not.toContain("tools");
  });

  it("rejects malformed JSON, schema mismatch, and missing output", async () => {
    const malformed = extractorReturning({ output_text: "{bad" }).extractor;
    const mismatch = extractorReturning({ output_text: JSON.stringify({ ...goodResult, totalAmountYen: -4 }) }).extractor;
    const missing = extractorReturning({}).extractor;
    await expect(malformed.extract({ imageBytes: Buffer.from("x"), contentType: "image/png" })).rejects.toMatchObject({ code: "invalid_response" });
    await expect(mismatch.extract({ imageBytes: Buffer.from("x"), contentType: "image/png" })).rejects.toMatchObject({ code: "invalid_response" });
    await expect(missing.extract({ imageBytes: Buffer.from("x"), contentType: "image/png" })).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("normalizes timeout and provider failures without leaking raw error text", async () => {
    const timeout = new GeminiReceiptExtractor({ apiKey: "test", client: { interactions: { create: vi.fn().mockRejectedValue(Object.assign(new Error("secret stack"), { name: "TimeoutError" })) } } as never });
    const failed = new GeminiReceiptExtractor({ apiKey: "test", client: { interactions: { create: vi.fn().mockRejectedValue(Object.assign(new Error("private provider body"), { status: 503 })) } } as never });
    await expect(timeout.extract({ imageBytes: Buffer.from("x"), contentType: "image/webp" })).rejects.toMatchObject({ code: "timeout" });
    await expect(failed.extract({ imageBytes: Buffer.from("x"), contentType: "image/webp" })).rejects.toMatchObject({ code: "provider_unavailable" });
    await expect(failed.extract({ imageBytes: Buffer.from("x"), contentType: "image/webp" })).rejects.not.toThrow("private provider body");
    const sdkTimeout = new GeminiReceiptExtractor({ apiKey: "test", client: { interactions: { create: vi.fn().mockRejectedValue(Object.assign(new Error("sdk timeout"), { name: "APIConnectionTimeoutError" })) } } as never });
    await expect(sdkTimeout.extract({ imageBytes: Buffer.from("x"), contentType: "image/webp" })).rejects.toMatchObject({ code: "timeout" });
  });

  it("normalizes rate limits without exposing provider text", async () => {
    const limited = new GeminiReceiptExtractor({ apiKey: "test", client: { interactions: { create: vi.fn().mockRejectedValue(Object.assign(new Error("provider quota detail"), { status: 429 })) } } as never });
    await expect(limited.extract({ imageBytes: Buffer.from("x"), contentType: "image/jpeg" })).rejects.toMatchObject({ code: "rate_limited" });
    await expect(limited.extract({ imageBytes: Buffer.from("x"), contentType: "image/jpeg" })).rejects.not.toThrow("provider quota detail");
  });

  it("requires an API key at call time when no mock client is supplied", async () => {
    const unconfigured = new GeminiReceiptExtractor({ apiKey: "" });
    await expect(unconfigured.extract({ imageBytes: Buffer.from("x"), contentType: "image/png" })).rejects.toMatchObject({ code: "not_configured" });
  });
});
