export const CATEGORY_IDS = [
  "food",
  "household",
  "transport",
  "medical",
  "clothing",
  "entertainment",
  "utilities",
  "communications",
  "other",
] as const;

export type CategoryId = (typeof CATEGORY_IDS)[number];

export const CATEGORY_LABELS: Record<CategoryId, string> = {
  food: "食費",
  household: "日用品",
  transport: "交通",
  medical: "医療",
  clothing: "衣服",
  entertainment: "娯楽",
  utilities: "水道・光熱",
  communications: "通信",
  other: "その他",
};

const categoryIdSet: ReadonlySet<string> = new Set(CATEGORY_IDS);

export function isCategoryId(value: unknown): value is CategoryId {
  return typeof value === "string" && categoryIdSet.has(value);
}

/** Conservative exact-match key for user-confirmed merchant mappings. */
export function normalizeMerchant(merchant: string): string {
  return merchant
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}
