import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";

export type StatementProvider = "smbc_card" | "rakuten_card" | "aeon_card" | "paypay";

export type CanonicalStatementTransaction = {
  provider: StatementProvider;
  externalId: string | null;
  kind: "purchase" | "refund";
  usedDate: string;
  usedTime: string | null;
  postedDate: string | null;
  merchant: string;
  amountYen: number;
  paymentMethod: string | null;
  sourceFingerprint: string;
  duplicateOrdinal: number;
};

export type StatementFatalErrorCode =
  | "invalid_file"
  | "empty_file"
  | "header_only"
  | "unsupported_provider"
  | "header_mismatch"
  | "malformed_csv"
  | "invalid_row"
  | "duplicate_external_id_conflict"
  | "limit_exceeded";

export type StatementParseResult = {
  transactions: CanonicalStatementTransaction[];
  excludedRows: Array<{ rowNumber: number; reason: "non_expense" }>;
  duplicateRowsInFile: number;
  totalRows: number;
  encoding: "utf-8" | "utf-8-bom" | "cp932";
  fatalErrors: Array<{ rowNumber: number | null; code: StatementFatalErrorCode }>;
  headerSignature: string | null;
};

interface StatementParser {
  provider: StatementProvider;
  parse(rows: string[][], encoding: StatementParseResult["encoding"]): StatementParseResult;
}

export const MAX_STATEMENT_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_STATEMENT_ROWS = 20_000;
export const MAX_STATEMENT_FIELD_LENGTH = 2_000;

const PAYPAY_HEADERS = [
  "取引日",
  "出金金額（円）",
  "入金金額（円）",
  "海外出金金額",
  "通貨",
  "変換レート（円）",
  "利用国",
  "取引内容",
  "取引先",
  "取引方法",
  "支払い区分",
  "利用者",
  "取引番号",
] as const;

// Verified against a September 2026 e-NAVI export supplied by the user. The two month labels vary by export month.
const RAKUTEN_2026_09_HEADERS = [
  "利用日", "利用店名・商品名", "利用者", "支払方法", "利用金額", "手数料/利息", "支払総額",
  "9月支払金額", "当月請求額", "10月繰越残高", "新規サイン",
] as const;

const EMPTY_RESULT = (
  code: StatementFatalErrorCode,
  encoding: StatementParseResult["encoding"] = "utf-8",
): StatementParseResult => ({
  transactions: [],
  excludedRows: [],
  duplicateRowsInFile: 0,
  totalRows: 0,
  encoding,
  fatalErrors: [{ rowNumber: null, code }],
  headerSignature: null,
});

function fingerprint(fields: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(fields), "utf8").digest("hex");
}

function parseYen(value: string): number | null {
  const normalized = value.trim();
  if (normalized === "") return 0;
  if (!/^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/.test(normalized)) return null;
  const amount = Number(normalized.replaceAll(",", ""));
  return Number.isSafeInteger(amount) ? amount : null;
}

function parsePaypayDate(value: string): { date: string; time: string } | null {
  const match = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const date = `${year}-${month}-${day}`;
  const parsed = new Date(`${date}T${hour}:${minute}:00Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getUTCFullYear() !== Number(year) ||
    parsed.getUTCMonth() + 1 !== Number(month) ||
    parsed.getUTCDate() !== Number(day) ||
    parsed.getUTCHours() !== Number(hour) ||
    parsed.getUTCMinutes() !== Number(minute)
  ) return null;
  return { date, time: `${hour}:${minute}` };
}

function makePaypayParseResult(rows: string[][], encoding: StatementParseResult["encoding"]): StatementParseResult {
  const [headers, ...bodyRows] = rows;
  const headerSignature = JSON.stringify(headers);
  if (headers.length !== PAYPAY_HEADERS.length || PAYPAY_HEADERS.some((header, index) => headers[index] !== header)) {
    return {
      ...EMPTY_RESULT("header_mismatch", encoding),
      totalRows: bodyRows.length,
      headerSignature,
    };
  }
  if (bodyRows.length === 0) {
    return {
      ...EMPTY_RESULT("header_only", encoding),
      headerSignature,
    };
  }

  const transactions: CanonicalStatementTransaction[] = [];
  const excludedRows: StatementParseResult["excludedRows"] = [];
  let duplicateRowsInFile = 0;
  const fatalErrors: StatementParseResult["fatalErrors"] = [];
  const fingerprintOrdinals = new Map<string, number>();
  const externalIdRows = new Map<string, { rowHash: string; rowNumber: number }>();

  bodyRows.forEach((row, index) => {
    const rowNumber = index + 2;
    if (row.length !== PAYPAY_HEADERS.length || row.some((field) => field.length > MAX_STATEMENT_FIELD_LENGTH)) {
      fatalErrors.push({ rowNumber, code: row.some((field) => field.length > MAX_STATEMENT_FIELD_LENGTH) ? "limit_exceeded" : "invalid_row" });
      return;
    }

    const [rawDate, rawOutflow, rawInflow, , , , , rawKind, rawMerchant, rawMethod, , , rawExternalId] = row;
    const kind = rawKind.trim();
    const externalId = rawExternalId.trim();
    const merchant = rawMerchant.trim();
    const outflow = parseYen(rawOutflow);
    const inflow = parseYen(rawInflow);
    const date = parsePaypayDate(rawDate);

    if (outflow === null || inflow === null || !date) {
      fatalErrors.push({ rowNumber, code: "invalid_row" });
      return;
    }

    const isLimitedPointGrant = externalId.startsWith("lp-");
    const isPurchase = !isLimitedPointGrant && kind === "支払い" && outflow > 0 && inflow === 0;
    const isRefund = !isLimitedPointGrant && kind === "返金" && inflow > 0 && outflow === 0;
    const knownNonExpenseKinds = ["チャージ", "ポイント", "ポイント付与", "ポイント獲得", "PayPayポイント", "入金", "受け取り", "給与"];
    if (!isPurchase && !isRefund && (knownNonExpenseKinds.includes(kind) || isLimitedPointGrant)) {
      // Non-expense rows are excluded only when the incoming/outgoing columns agree with a credit.
      if ((knownNonExpenseKinds.includes(kind) || isLimitedPointGrant) && outflow === 0 && inflow > 0) {
        excludedRows.push({ rowNumber, reason: "non_expense" });
      } else {
        fatalErrors.push({ rowNumber, code: "invalid_row" });
      }
      return;
    }
    if (!isPurchase && !isRefund) {
      fatalErrors.push({ rowNumber, code: "invalid_row" });
      return;
    }
    if (!externalId || !merchant) {
      fatalErrors.push({ rowNumber, code: "invalid_row" });
      return;
    }

    const rowHash = fingerprint(row);
    const priorExternal = externalIdRows.get(externalId);
    if (priorExternal) {
      if (priorExternal.rowHash !== rowHash) {
        fatalErrors.push({ rowNumber, code: "duplicate_external_id_conflict" });
      } else {
        duplicateRowsInFile += 1;
      }
      return;
    }
    externalIdRows.set(externalId, { rowHash, rowNumber });

    const canonicalFields = ["paypay", isPurchase ? "purchase" : "refund", date.date, date.time, merchant, String(isPurchase ? outflow : inflow), rawMethod.trim()];
    const sourceFingerprint = fingerprint(canonicalFields);
    const duplicateOrdinal = (fingerprintOrdinals.get(sourceFingerprint) ?? 0) + 1;
    fingerprintOrdinals.set(sourceFingerprint, duplicateOrdinal);
    transactions.push({
      provider: "paypay",
      externalId,
      kind: isPurchase ? "purchase" : "refund",
      usedDate: date.date,
      usedTime: `${date.time}:00`,
      postedDate: null,
      merchant,
      amountYen: isPurchase ? outflow : inflow,
      paymentMethod: rawMethod.trim() || null,
      sourceFingerprint,
      duplicateOrdinal,
    });
  });

  return { transactions: fatalErrors.length ? [] : transactions, excludedRows, duplicateRowsInFile, totalRows: bodyRows.length, encoding, fatalErrors, headerSignature };
}

function unsupportedParser(provider: "smbc_card" | "aeon_card"): StatementParser {
  return {
    provider,
    parse(rows, encoding) {
      // No header is verified here. SMBC's first row contains private account data.
      return { ...EMPTY_RESULT("unsupported_provider", encoding), totalRows: Math.max(rows.length - 1, 0) };
    },
  };
}

const rakutenParser: StatementParser = {
  provider: "rakuten_card",
  parse(rows, encoding) {
    const [headers, ...bodyRows] = rows;
    const headerSignature = JSON.stringify(headers);
    if (headers.length !== RAKUTEN_2026_09_HEADERS.length ||
        RAKUTEN_2026_09_HEADERS.some((header, index) => headers[index] !== header)) {
      return { ...EMPTY_RESULT("header_mismatch", encoding), totalRows: bodyRows.length, headerSignature: null };
    }
    if (bodyRows.length === 0) return { ...EMPTY_RESULT("header_only", encoding), headerSignature };
    // The verified export contains continuation and partial rows whose meaning is unresolved.
    return { ...EMPTY_RESULT("unsupported_provider", encoding), totalRows: bodyRows.length, headerSignature };
  },
};

const adapters: Record<StatementProvider, StatementParser> = {
  smbc_card: unsupportedParser("smbc_card"),
  rakuten_card: rakutenParser,
  aeon_card: unsupportedParser("aeon_card"),
  paypay: { provider: "paypay", parse: makePaypayParseResult },
};

export function parseStatement(bytes: Buffer, provider: StatementProvider): StatementParseResult {
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const encoding = provider === "smbc_card" ? "cp932" : hasBom ? "utf-8-bom" : "utf-8";
  if (bytes.length === 0) return EMPTY_RESULT("empty_file", encoding);
  if (bytes.length > MAX_STATEMENT_FILE_BYTES) return EMPTY_RESULT("limit_exceeded", encoding);
  if (bytes.includes(0)) return EMPTY_RESULT("invalid_file", encoding);

  let text: string;
  try {
    text = new TextDecoder(encoding === "cp932" ? "shift_jis" : "utf-8", { fatal: true })
      .decode(hasBom && encoding !== "cp932" ? bytes.subarray(3) : bytes);
  } catch {
    return EMPTY_RESULT("invalid_file", encoding);
  }
  if (!text.trim()) return EMPTY_RESULT("empty_file", encoding);

  let rows: string[][];
  try {
    rows = parse(text, { bom: true, relax_column_count: true, skip_empty_lines: true, record_delimiter: ["\r\n", "\n", "\r"] }) as string[][];
  } catch {
    return EMPTY_RESULT("malformed_csv", encoding);
  }
  if (rows.length === 0) return EMPTY_RESULT("empty_file", encoding);
  if (rows.length - 1 > MAX_STATEMENT_ROWS) return EMPTY_RESULT("limit_exceeded", encoding);
  if (rows.some((row) => row.some((field) => field.length > MAX_STATEMENT_FIELD_LENGTH))) return EMPTY_RESULT("limit_exceeded", encoding);

  return adapters[provider].parse(rows, encoding);
}
