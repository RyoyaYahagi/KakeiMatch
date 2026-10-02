import { describe, expect, it } from "vitest";
import { costUsdMicros, monthBounds, pricingFor, PRICING_CATALOG, safeModel, tokenUsage } from "./ai-provider-costs";

describe("provider cost snapshots", () => {
  it("selects the newest matching pricing version at the dispatch instant", () => {
    const history = [
      { ...PRICING_CATALOG[0]!, version: "old", validFrom: 0, validUntil: 100, inputUsdPerMillionMicros: 10 },
      { ...PRICING_CATALOG[0]!, version: "new", validFrom: 100, inputUsdPerMillionMicros: 20 },
    ];
    expect(pricingFor("gemini", "gemini-3.5-flash-lite", 99, history)?.version).toBe("old");
    expect(pricingFor("gemini", "gemini-3.5-flash-lite", 100, history)?.version).toBe("new");
    expect(pricingFor("jev", "gemini-3.5-flash-lite", 100, history)).toBeNull();
  });

  it("accepts the provider-specific Gemini and Jev usage shapes with consistent totals", () => {
    expect(tokenUsage("gemini", {
      modelVersion: "gemini-3.5-flash-lite",
      usage: { total_input_tokens: 10, total_output_tokens: 5, total_thought_tokens: 2, total_cached_tokens: 0, total_tokens: 17 },
    })).toEqual({ input: 10, output: 5, thinking: 2, cached: 0, total: 17 });
    expect(tokenUsage("gemini", {
      model: "gemini-3.5-flash-lite",
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 2, cachedContentTokenCount: 0, totalTokenCount: 17 },
    })).toEqual({ input: 10, output: 5, thinking: 2, cached: 0, total: 17 });
    expect(tokenUsage("jev", { model: "jev-1.13.0", usage: { input_tokens: 10, output_tokens: 5 } }))
      .toEqual({ input: 10, output: 5, thinking: 0, cached: 0, total: 15 });
  });

  it("rejects unsafe or inconsistent usage and unsupported billing dimensions", () => {
    expect(tokenUsage("gemini", null)).toBeNull();
    expect(tokenUsage("gemini", { usageMetadata: { promptTokenCount: -1, candidatesTokenCount: 2, totalTokenCount: 1 } })).toBeNull();
    expect(tokenUsage("gemini", { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 14 } })).toBeNull();
    expect(tokenUsage("gemini", { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15, cachedContentTokenCount: 11 } })).toBeNull();
    expect(tokenUsage("gemini", { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15, toolUsePromptTokenCount: 1 } })).toBeNull();
    const usage = { input: 10, output: 5, thinking: 0, cached: 1, total: 15 };
    expect(costUsdMicros(usage, PRICING_CATALOG[0]!)).toBeNull();
  });

  it("rounds fractional micro-dollar costs upward and guards safe integers", () => {
    const pricing = { ...PRICING_CATALOG[0]!, inputUsdPerMillionMicros: 1, outputUsdPerMillionMicros: 3 };
    expect(costUsdMicros({ input: 1, output: 0, thinking: 0, cached: 0, total: 1 }, pricing)).toBe(1);
    expect(costUsdMicros({ input: 0, output: 1, thinking: 0, cached: 0, total: 1 }, pricing)).toBe(1);
    expect(costUsdMicros({ input: 1_000_000, output: 0, thinking: 0, cached: 0, total: 1_000_000 }, pricing)).toBe(1);
    expect(costUsdMicros({ input: Number.MAX_SAFE_INTEGER, output: 0, thinking: 0, cached: 0, total: Number.MAX_SAFE_INTEGER }, { ...pricing, inputUsdPerMillionMicros: 2_000_000 })).toBeNull();
  });

  it("accepts only safe model identifiers", () => {
    expect(safeModel("jev-1.13.0")).toBe("jev-1.13.0");
    for (const value of ["", "../secret", " model", "x".repeat(129), 4, null]) expect(safeModel(value)).toBeNull();
  });

  it("bounds months at Tokyo midnight, including leap February", () => {
    const february = monthBounds("2028-02")!;
    expect(new Date(february.start * 1000).toISOString()).toBe("2028-01-31T15:00:00.000Z");
    expect(new Date(february.end * 1000).toISOString()).toBe("2028-02-29T15:00:00.000Z");
    expect(monthBounds("2028-13")).toBeNull();
    expect(monthBounds("1999-12")).toBeNull();
  });
});
