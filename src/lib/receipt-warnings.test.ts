import { describe, expect, it } from "vitest";
import { receiptExtractionResultSchema } from "./receipt-extraction";

const base = {
  documentKind: "receipt" as const, merchant: "Synthetic Market", purchasedDate: "2026-10-04", purchasedTime: null, totalAmountYen: 0, taxAmountYen: null,
  items: [{ name: "Synthetic Lettuce", amountYen: 0 }, { name: "Synthetic Chicken", amountYen: 597 }],
  adjustments: [{ label: "Synthetic Coupon", amountYen: -540 }],
};

describe("receipt read warnings", () => {
  it("accepts a warning position only when it points at an entry of its field", () => {
    const parse = (warning: object) => receiptExtractionResultSchema.safeParse({ ...base, warnings: [{ code: "check", message: "確認してください。", ...warning }] }).success;
    expect(parse({ field: "items", index: 1 })).toBe(true);
    expect(parse({ field: "items", index: 2 })).toBe(false);
    expect(parse({ field: "adjustments", index: 0 })).toBe(true);
    expect(parse({ field: "merchant", index: 0 })).toBe(false);
    expect(parse({ field: "merchant", index: null })).toBe(true);
  });
});
