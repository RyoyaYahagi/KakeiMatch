import { parse } from "csv-parse/browser/esm/sync";
import { sha256Hex } from "./statement-parser";

export type MoneyForwardKind = "expense" | "income";

export type MoneyForwardRow = {
  rowNumber: number;
  date: string;
  description: string;
  /** Original signed yen value: expenses are negative and income is positive. */
  amountYen: number;
  kind: MoneyForwardKind;
  accountName: string | null;
  majorCategory: string;
  minorCategory: string;
  memo: string;
  sourceTransactionId: string | null;
  /** Stable SHA-256 key; identical rows without a provider ID share a key. */
  sourceKey: string;
  isTransfer: boolean;
  isIncludedInCalculation: boolean;
  categoryNeedsReviewReason: string | null;
};

export type MoneyForwardParseResult = {
  transactions: MoneyForwardRow[];
  excludedRows: Array<{ rowNumber: number; reason: "transfer" | "excluded_from_calculation" }>;
  rowErrors: Array<{ rowNumber: number; reason: string }>;
  totalRows: number;
  encoding: "utf-8" | "utf-8-bom" | "shift_jis";
  fatalErrors: Array<{ rowNumber: number | null; code: "invalid_file" | "empty_file" | "header_only" | "header_mismatch" | "malformed_csv" | "limit_exceeded" }>;
  headerSignature: string | null;
  foundHeaders?: string[];
  missingHeaders?: string[];
  unknownHeaders?: string[];
  duplicateHeaders?: string[];
};

export type MoneyForwardAvailableCategory = {
  id: string;
  name: string;
  isIncome: boolean;
  hidden: boolean;
};

export const MAX_MONEY_FORWARD_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_MONEY_FORWARD_ROWS = 20_000;
export const MAX_MONEY_FORWARD_FIELD_LENGTH = 2_000;

const HEADER_ALIASES = {
  date: ["日付"],
  description: ["内容", "摘要"],
  amount: ["金額(円)", "金額（円）", "金額"],
  account: ["保有金融機関", "口座"],
  major: ["大項目"],
  minor: ["中項目"],
  memo: ["メモ"],
  transfer: ["振替", "振替フラグ"],
  calculation: ["計算対象"],
  transactionId: ["ID", "取引ID", "明細ID"],
} as const;

const CATEGORY_TARGETS: Record<MoneyForwardKind, Record<string, string>> = {
  expense: {
    "食費": "食費", "日用品": "日用品", "趣味・娯楽": "趣味・娯楽", "交際費": "交際費",
    "交通費": "交通", "衣服・美容": "衣服・美容", "健康・医療": "医療・健康", "自動車": "交通",
    "教養・教育": "教育・学習", "特別な支出": "その他", "現金・カード": "現金・カード",
    "水道・光熱費": "水道・光熱", "通信費": "通信", "住宅": "住居", "税・社会保障": "税・社会保障",
    "保険": "保険", "その他": "その他", "未分類": "未分類",
  },
  income: {
    "収入": "収入", "臨時収入": "臨時収入", "給与": "給与", "賞与": "賞与", "事業・副業": "事業・副業",
    "年金": "年金", "配当": "配当", "配当所得": "配当所得", "一時所得": "一時所得",
    "不動産所得": "不動産所得", "不明な入金": "不明な入金", "その他入金": "その他入金", "その他": "その他", "未分類": "未分類",
  },
};

const EXPENSE_MINOR_TARGETS: Record<string, string> = {
  [JSON.stringify(["食費", "食料品"])]: "食費",
  [JSON.stringify(["食費", "外食"])]: "外食",
  [JSON.stringify(["食費", "朝ご飯"])]: "外食",
  [JSON.stringify(["食費", "昼ご飯"])]: "外食",
  [JSON.stringify(["食費", "夜ご飯"])]: "外食",
  [JSON.stringify(["食費", "カフェ"])]: "外食",
  [JSON.stringify(["趣味・娯楽", "アウトドア"])]: "趣味・娯楽",
  [JSON.stringify(["趣味・娯楽", "スポーツ"])]: "趣味・娯楽",
  [JSON.stringify(["趣味・娯楽", "映画・音楽・ゲーム"])]: "趣味・娯楽",
  [JSON.stringify(["趣味・娯楽", "本"])]: "趣味・娯楽",
  [JSON.stringify(["趣味・娯楽", "旅行"])]: "趣味・娯楽",
  [JSON.stringify(["交通費", "電車"])]: "交通",
  [JSON.stringify(["交通費", "バス"])]: "交通",
  [JSON.stringify(["交通費", "タクシー"])]: "交通",
  [JSON.stringify(["交通費", "航空券"])]: "交通",
  [JSON.stringify(["衣服・美容", "衣服"])]: "衣服・美容",
  [JSON.stringify(["衣服・美容", "クリーニング"])]: "衣服・美容",
  [JSON.stringify(["衣服・美容", "美容院・理髪"])]: "衣服・美容",
  [JSON.stringify(["衣服・美容", "化粧品"])]: "衣服・美容",
  [JSON.stringify(["衣服・美容", "アクセサリー"])]: "衣服・美容",
  [JSON.stringify(["健康・医療", "医療費"])]: "医療・健康",
  [JSON.stringify(["健康・医療", "薬"])]: "医療・健康",
  [JSON.stringify(["健康・医療", "フィットネス"])]: "医療・健康",
  [JSON.stringify(["健康・医療", "ボディケア"])]: "医療・健康",
  [JSON.stringify(["自動車", "ガソリン"])]: "交通",
  [JSON.stringify(["自動車", "自動車ローン"])]: "交通",
  [JSON.stringify(["自動車", "駐車場"])]: "交通",
  [JSON.stringify(["自動車", "高速道路"])]: "交通",
  [JSON.stringify(["自動車", "自動車保険"])]: "交通",
  [JSON.stringify(["教養・教育", "学費"])]: "教育・学習",
  [JSON.stringify(["教養・教育", "習い事"])]: "教育・学習",
  [JSON.stringify(["教養・教育", "塾"])]: "教育・学習",
  [JSON.stringify(["教養・教育", "子育て"])]: "教育・学習",
  [JSON.stringify(["教養・教育", "本"])]: "教育・学習",
  [JSON.stringify(["教養・教育", "雑誌"])]: "教育・学習",
  [JSON.stringify(["水道・光熱費", "電気"])]: "水道・光熱",
  [JSON.stringify(["水道・光熱費", "ガス"])]: "水道・光熱",
  [JSON.stringify(["水道・光熱費", "水道"])]: "水道・光熱",
  [JSON.stringify(["通信費", "携帯電話"])]: "通信",
  [JSON.stringify(["通信費", "インターネット"])]: "通信",
  [JSON.stringify(["住宅", "家賃"])]: "住居",
  [JSON.stringify(["住宅", "住宅ローン"])]: "住居",
  [JSON.stringify(["住宅", "管理費・積立金"])]: "住居",
  [JSON.stringify(["住宅", "地震・火災保険"])]: "住居",
  [JSON.stringify(["税・社会保障", "所得税"])]: "その他",
  [JSON.stringify(["税・社会保障", "住民税"])]: "その他",
  [JSON.stringify(["税・社会保障", "年金保険料"])]: "その他",
  [JSON.stringify(["税・社会保障", "健康保険"])]: "医療・健康",
  [JSON.stringify(["保険", "生命保険"])]: "保険",
  [JSON.stringify(["保険", "医療保険"])]: "保険",
};

const CATEGORY_LABEL_ALIASES: Record<string, string> = {
  "食費": "食費", "外食": "外食", "日用品": "日用品", "趣味・娯楽": "趣味・娯楽", "交際費": "交際費",
  "交通": "交通", "交通費": "交通", "衣服・美容": "衣服・美容", "医療・健康": "医療・健康", "健康・医療": "医療・健康",
  "教育・学習": "教育・学習", "水道・光熱": "水道・光熱", "水道・光熱費": "水道・光熱", "通信": "通信", "通信費": "通信",
  "住居": "住居", "住宅": "住居", "その他": "その他",
};

function emptyResult(code: MoneyForwardParseResult["fatalErrors"][number]["code"], encoding: MoneyForwardParseResult["encoding"] = "utf-8"): MoneyForwardParseResult {
  return { transactions: [], excludedRows: [], rowErrors: [], totalRows: 0, encoding, fatalErrors: [{ rowNumber: null, code }], headerSignature: null };
}

function headerKey(value: string): string {
  return value.normalize("NFKC").trim().replace(/[\s\u3000]/gu, "").toLowerCase();
}

function findColumn(headers: string[], aliases: readonly string[]): number {
  const keys = new Set(aliases.map(headerKey));
  return headers.findIndex(value => keys.has(headerKey(value)));
}

function parseDate(value: string): string | null {
  const match = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(value.trim());
  if (!match) return null;
  const date = `${match[1]}-${match[2]!.padStart(2, "0")}-${match[3]!.padStart(2, "0")}`;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date ? null : date;
}

function parseYen(value: string): number | null {
  const normalized = value.normalize("NFKC").trim().replace(/[￥¥円]/gu, "");
  if (!/^-?(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/.test(normalized)) return null;
  const amount = Number(normalized.replaceAll(",", ""));
  return Number.isSafeInteger(amount) ? amount : null;
}

function parseFlag(value: string, defaultValue: boolean): boolean | null {
  const normalized = value.normalize("NFKC").trim();
  if (!normalized) return defaultValue;
  if (/^(?:1|true|yes|on|対象|振替|はい|する)$/iu.test(normalized)) return true;
  if (/^(?:0|false|no|off|対象外|計算対象外|振替ではない|いいえ|しない)$/iu.test(normalized)) return false;
  return null;
}

export function categoryKey(row: Pick<MoneyForwardRow, "kind" | "majorCategory" | "minorCategory">): string {
  return JSON.stringify([row.kind, row.majorCategory.trim(), row.minorCategory.trim()]);
}

export function resolveMoneyForwardCategory(
  row: Pick<MoneyForwardRow, "kind" | "majorCategory" | "minorCategory">,
  available: MoneyForwardAvailableCategory[],
): { categoryId: string | null; suggestedName: string | null; reason: string } {
  const active = available.filter(category => !category.hidden && category.isIncome === (row.kind === "income"));
  if (row.majorCategory.trim() === "現金・カード") return { categoryId: null, suggestedName: "現金・カード", reason: "現金・カードの分類を確認してください" };
  const major = row.majorCategory.trim();
  const minor = row.minorCategory.trim();
  const individual = row.kind === "expense" ? EXPENSE_MINOR_TARGETS[JSON.stringify([major, minor])] : undefined;
  const sameName = active.find(category => category.name === (individual ?? minor))
    ?? (!individual ? active.find(category => category.name === major) : undefined);
  if (sameName) return { categoryId: sameName.id, suggestedName: sameName.name, reason: "" };
  const suggestedName = individual ?? CATEGORY_TARGETS[row.kind][major] ?? null;
  if (!suggestedName) return { categoryId: null, suggestedName: null, reason: "対応表にないカテゴリです。分類を確認してください" };
  const preferredName = suggestedName ? CATEGORY_LABEL_ALIASES[suggestedName] ?? suggestedName : null;
  const category = preferredName ? active.find(entry => entry.name === preferredName) : undefined;
  if (category) return { categoryId: category.id, suggestedName: category.name, reason: "" };
  return { categoryId: null, suggestedName, reason: "" };
}

export async function parseMoneyForwardBlob(file: Blob): Promise<MoneyForwardParseResult> {
  if (file.size > MAX_MONEY_FORWARD_FILE_BYTES) return emptyResult("limit_exceeded");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  if (!bytes.length) return emptyResult("empty_file");
  if (bytes.length > MAX_MONEY_FORWARD_FILE_BYTES) return emptyResult("limit_exceeded");
  if (bytes.includes(0)) return emptyResult("invalid_file");

  let encoding: MoneyForwardParseResult["encoding"] = bom ? "utf-8-bom" : "utf-8";
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bom ? bytes.subarray(3) : bytes);
  } catch {
    try {
      text = new TextDecoder("shift_jis", { fatal: true }).decode(bytes);
      encoding = "shift_jis";
    } catch {
      return emptyResult("invalid_file");
    }
  }

  let records: string[][];
  let lineEnds: number[];
  try {
    // csv-parse types describe string[][] even with info:true; the runtime supplies record + info.
    const decoded = parse(text, { bom: true, info: true, relax_column_count: true, skip_empty_lines: true, record_delimiter: ["\r\n", "\n", "\r"] }) as unknown as Array<{ record: string[]; info: { lines: number } }>;
    records = decoded.map(value => value.record);
    lineEnds = decoded.map(value => value.info.lines);
  } catch {
    return emptyResult("malformed_csv", encoding);
  }
  if (!records.length) return emptyResult("empty_file", encoding);
  if (records.length - 1 > MAX_MONEY_FORWARD_ROWS || records.some(record => record.some(field => field.length > MAX_MONEY_FORWARD_FIELD_LENGTH))) {
    return emptyResult("limit_exceeded", encoding);
  }

  const headers = records[0]!;
  if (records.length === 1) return { ...emptyResult("header_only", encoding), headerSignature: JSON.stringify(headers.map(headerKey)) };
  const columns = Object.fromEntries(Object.entries(HEADER_ALIASES).map(([key, aliases]) => [key, findColumn(headers, aliases)])) as Record<keyof typeof HEADER_ALIASES, number>;
  const requiredColumns = ["date", "description", "amount", "major"] as const;
  const requiredHeaders = { date: "日付", description: "内容", amount: "金額（円）", major: "大項目" } as const;
  const missingHeaders = requiredColumns.filter(key => columns[key] < 0).map(key => requiredHeaders[key]);
  const duplicateHeaders = requiredColumns.filter(key => headers.filter(value => (HEADER_ALIASES[key] as readonly string[]).some(alias => headerKey(alias) === headerKey(value))).length > 1).map(key => requiredHeaders[key]);
  const recognizedHeaders = new Set(Object.values(HEADER_ALIASES).flat().map(headerKey));
  const foundHeaders = headers.filter(value => recognizedHeaders.has(headerKey(value)));
  const unknownHeaders = headers.filter(value => !recognizedHeaders.has(headerKey(value)));
  if (missingHeaders.length || duplicateHeaders.length) {
    return { ...emptyResult("header_mismatch", encoding), totalRows: records.length - 1, foundHeaders, missingHeaders, unknownHeaders, duplicateHeaders };
  }
  const headerSignature = JSON.stringify(headers.map(headerKey));
  const transactions: MoneyForwardRow[] = [];
  const excludedRows: MoneyForwardParseResult["excludedRows"] = [];
  const rowErrors: MoneyForwardParseResult["rowErrors"] = [];
  const bodyRows = records.slice(1);

  bodyRows.forEach((record, index) => {
    const rowNumber = lineEnds[index + 1];
    if (record.length !== headers.length) {
      rowErrors.push({ rowNumber, reason: "CSVの列数が見出しと一致しません" });
      return;
    }
    const get = (column: number) => column < 0 ? "" : (record[column] ?? "").trim();
    const date = parseDate(get(columns.date));
    const description = get(columns.description);
    const amountYen = parseYen(get(columns.amount));
    if (!date) { rowErrors.push({ rowNumber, reason: "日付を確認できません" }); return; }
    if (!description) { rowErrors.push({ rowNumber, reason: "内容がありません" }); return; }
    if (amountYen === null || amountYen === 0) { rowErrors.push({ rowNumber, reason: "金額を確認できません" }); return; }

    const majorCategory = get(columns.major);
    const minorCategory = get(columns.minor);
    const transferValue = get(columns.transfer);
    const calculationValue = get(columns.calculation);
    const transfer = parseFlag(transferValue, false);
    const included = parseFlag(calculationValue, true);
    if (transfer === null) { rowErrors.push({ rowNumber, reason: "振替の値を確認できません" }); return; }
    if (included === null) { rowErrors.push({ rowNumber, reason: "計算対象の値を確認できません" }); return; }
    const isTransfer = transfer || majorCategory === "振替" || minorCategory === "振替";
    const isIncludedInCalculation = included;
    if (isTransfer) { excludedRows.push({ rowNumber, reason: "transfer" }); return; }
    if (!isIncludedInCalculation) { excludedRows.push({ rowNumber, reason: "excluded_from_calculation" }); return; }

    const kind: MoneyForwardKind = amountYen < 0 ? "expense" : "income";
    const sourceTransactionId = get(columns.transactionId) || null;
    const accountName = get(columns.account) || null;
    const memo = get(columns.memo);
    const rowIdentity = sourceTransactionId
      ? ["id", sourceTransactionId]
      : ["row", date, description, String(amountYen), accountName, majorCategory, minorCategory, memo, transferValue, calculationValue];
    const sourceKey = sha256Hex(new TextEncoder().encode(JSON.stringify(["moneyforward", rowIdentity])));
    const row: MoneyForwardRow = {
      rowNumber, date, description, amountYen, kind, accountName, majorCategory, minorCategory, memo,
      sourceTransactionId, sourceKey, isTransfer, isIncludedInCalculation,
      categoryNeedsReviewReason: null,
    };
    if (majorCategory === "現金・カード") row.categoryNeedsReviewReason = "現金・カードの分類を確認してください";
    transactions.push(row);
  });

  return { transactions, excludedRows, rowErrors, totalRows: bodyRows.length, encoding, fatalErrors: [], headerSignature };
}
