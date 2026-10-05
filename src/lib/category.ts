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
  medical: "医療・健康",
  clothing: "衣服・美容",
  entertainment: "趣味・娯楽",
  utilities: "水道・光熱",
  communications: "通信",
  other: "その他",
};

export const BASIC_EXPENSE_CATEGORY_LABELS = [
  "食費",
  "外食",
  "日用品",
  "衣服・美容",
  "交通",
  "医療・健康",
  "家電・デジタル",
  "趣味・娯楽",
  "AI・ソフトウェア",
  "通信",
  "教育・学習",
  "交際費",
  "住居",
  "水道・光熱",
  "その他",
] as const;

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
