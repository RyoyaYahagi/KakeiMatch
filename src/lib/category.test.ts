import { describe, expect, it } from "vitest";
import { CATEGORY_IDS, CATEGORY_LABELS, isCategoryId, normalizeMerchant } from "./category";

describe("category definitions", () => {
  it("keeps the fixed IDs separate from their Japanese labels", () => {
    expect(CATEGORY_IDS).toHaveLength(9);
    expect(CATEGORY_LABELS).toEqual({
      food: "食費",
      household: "日用品",
      transport: "交通",
      medical: "医療",
      clothing: "衣服",
      entertainment: "娯楽",
      utilities: "水道・光熱",
      communications: "通信",
      other: "その他",
    });
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
