import { describe, expect, it } from "vitest";
import { BASIC_EXPENSE_CATEGORY_LABELS, CATEGORY_IDS, CATEGORY_LABELS, isCategoryId, normalizeMerchant } from "./category";

describe("category definitions", () => {
  it("keeps the fixed IDs separate from their Japanese labels", () => {
    expect(CATEGORY_IDS).toHaveLength(9);
    expect(CATEGORY_LABELS).toEqual({
      food: "食費",
      household: "日用品",
      transport: "交通",
      medical: "医療・健康",
      clothing: "衣服・美容",
      entertainment: "趣味・娯楽",
      utilities: "水道・光熱",
      communications: "通信",
      other: "その他",
    });
  });

  it("defines the default expense categories by use rather than payment form", () => {
    expect(BASIC_EXPENSE_CATEGORY_LABELS).toEqual([
      "食費", "外食", "日用品", "衣服・美容", "交通", "医療・健康", "家電・デジタル", "趣味・娯楽",
      "AI・ソフトウェア", "通信", "教育・学習", "交際費", "住居", "水道・光熱", "その他",
    ]);
    expect(BASIC_EXPENSE_CATEGORY_LABELS).not.toContain("サブスク");
  });

  it("accepts only known category IDs", () => {
    expect(isCategoryId("other")).toBe(true);
    expect(isCategoryId("unclassified")).toBe(false);
    expect(isCategoryId("toString")).toBe(false);
    expect(isCategoryId(null)).toBe(false);
  });

  it("normalizes only Unicode form, surrounding/repeated whitespace, and ASCII case", () => {
    expect(normalizeMerchant("  ＡＢＣ　 Store\t  ")).toBe("abc store");
    expect(normalizeMerchant("カタカナABC株式会社")).toBe("カタカナabc株式会社");
  });
});
