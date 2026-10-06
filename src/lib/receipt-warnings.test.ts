import { describe, expect, it } from "vitest";
import { describeReceiptWarnings } from "../../apps/pwa/src/receipt-warnings";
import { receiptExtractionResultSchema } from "./receipt-extraction";

const base = {
  documentKind: "receipt" as const, merchant: "Synthetic Market", purchasedDate: "2026-10-04", purchasedTime: null, totalAmountYen: 0, taxAmountYen: null,
  items: [{ name: "Synthetic Lettuce", amountYen: 0 }, { name: "Synthetic Chicken", amountYen: 597 }],
  adjustments: [{ label: "Synthetic Coupon", amountYen: -540 }],
};

describe("receipt read warnings", () => {
  it("says where to look and why for items, adjustments, fields and the whole receipt", () => {
    expect(describeReceiptWarnings({ ...base, warnings: [
      { field: "items", code: "out_of_stock", message: "欠品のため金額が0円です。", index: 0 },
      { field: "adjustments", code: "coupon", message: "クーポンの対象を確認してください。", index: 0 },
      { field: "totalAmountYen", code: "points", message: "ポイント利用で支払額が0円です。" },
      { field: null, code: "layout", message: "通常のレシートと形式が異なります。" },
    ] })).toEqual([
      { target: { kind: "item", index: 0 }, label: "品目1「Synthetic Lettuce」", message: "欠品のため金額が0円です。" },
      { target: { kind: "adjustment", index: 0 }, label: "値引き・調整「Synthetic Coupon」", message: "クーポンの対象を確認してください。" },
      { target: { kind: "field", field: "totalAmountYen" }, label: "合計金額", message: "ポイント利用で支払額が0円です。" },
      { target: { kind: "image" }, label: "レシート全体", message: "通常のレシートと形式が異なります。" },
    ]);
  });
  it("replaces messages from older reads that are not Japanese with a plain instruction", () => {
    expect(describeReceiptWarnings({ ...base, warnings: [
      { field: "items", code: "ambiguous", message: "Ambiguous adjustment" },
      { field: null, code: "unknown", message: "Unclear document" },
    ] })).toEqual([
      { target: { kind: "item", index: null }, label: "品目", message: "画像の品目と照らし合わせてください。" },
      { target: { kind: "image" }, label: "レシート全体", message: "画像の内容と照らし合わせてください。" },
    ]);
  });
  it("accepts a warning position only when it points at an entry of its field", () => {
    const parse = (warning: object) => receiptExtractionResultSchema.safeParse({ ...base, warnings: [{ code: "check", message: "確認してください。", ...warning }] }).success;
    expect(parse({ field: "items", index: 1 })).toBe(true);
    expect(parse({ field: "items", index: 2 })).toBe(false);
    expect(parse({ field: "adjustments", index: 0 })).toBe(true);
    expect(parse({ field: "merchant", index: 0 })).toBe(false);
    expect(parse({ field: "merchant", index: null })).toBe(true);
  });
});
