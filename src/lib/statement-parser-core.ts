/** Browser-safe parser core shared by the Node API and the PWA. */
import { parse } from "csv-parse/browser/esm/sync";

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
  | "unsupported_layout"
  | "header_mismatch"
  | "malformed_csv"
  | "invalid_row"
  | "duplicate_external_id_conflict"
  | "limit_exceeded";

export type StatementParseResult = {
  transactions: CanonicalStatementTransaction[];
  excludedRows: Array<{ rowNumber: number; reason: "non_expense" }>;
  /** SMBC rows that were kept out of canonical transactions for human review. */
  needsReviewRows?: Array<{ rowNumber: number; reason: string }>;
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

const SMBC_HEADER_SIGNATURE = "smbc-vpass-cp932-v1";

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
  return sha256Hex(new TextEncoder().encode(JSON.stringify(fields)));
}

function parseYen(value: string): number | null {
  const normalized = value.trim();
  if (normalized === "") return 0;
  if (!/^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/.test(normalized)) return null;
  const amount = Number(normalized.replaceAll(",", ""));
  return Number.isSafeInteger(amount) ? amount : null;
}

function parseStrictSmbcYen(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const amount = Number(value);
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

function parseSmbcDate(value: string): string | null {
  const match = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day] = match;
  const date = `${year}-${month}-${day}`;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return null;
  return date;
}

function makeSmbcParseResult(rows: string[][], encoding: StatementParseResult["encoding"]): StatementParseResult {
  // Vpass exports have no header. Treat the first row as private, opaque metadata:
  // its values must never become a signature or appear in any result or error.
  const metadata = rows[0];
  const detailRows = rows.slice(1, -1);
  const summary = rows.at(-1);
  const invalidLayout = () => ({ ...EMPTY_RESULT("unsupported_layout", encoding), totalRows: Math.max(rows.length - 2, 0) });
  if (!metadata || metadata.length !== 3 || !summary || summary.length !== 7 || detailRows.length === 0) return invalidLayout();
  if (detailRows.some((row) => row.length !== 7)) return invalidLayout();

  const summaryAmount = parseStrictSmbcYen(summary[5] ?? "");
  if (summary.slice(0, 5).some((field) => field !== "") || summary[6] !== "" || summaryAmount === null || summaryAmount <= 0) return invalidLayout();

  const transactions: CanonicalStatementTransaction[] = [];
  const needsReviewRows: NonNullable<StatementParseResult["needsReviewRows"]> = [];
  const fingerprintOrdinals = new Map<string, number>();
  let purchaseAmountTotal = 0;
  let unsafeTotal = false;

  detailRows.forEach((row, index) => {
    const rowNumber = index + 2;
    if (row.some((field) => field.length > MAX_STATEMENT_FIELD_LENGTH)) {
      needsReviewRows.push({ rowNumber, reason: "明細の項目が長すぎます" });
      return;
    }
    const [rawDate, rawMerchant, rawAmount, paymentA, paymentB, rawStatementAmount, finalField] = row;
    const date = parseSmbcDate(rawDate);
    const amount = parseStrictSmbcYen(rawAmount);
    const statementAmount = parseStrictSmbcYen(rawStatementAmount);
    let reason: string | null = null;
    if (!date) reason = "利用日を確認できません";
    else if (rawMerchant.trim() === "") reason = "利用先を確認できません";
    else if (/年会費|手数料|キャッシング|利息|遅延損害金|取消|キャンセル|返金|返品|ボーナス|海外利用/.test(rawMerchant)) reason = "特殊な利用の可能性があります";
    else if (amount === null || amount <= 0) reason = "利用金額を確認できません";
    else if (paymentA !== "１" || paymentB !== "１") reason = "1回払い以外の可能性があります";
    else if (statementAmount === null || statementAmount <= 0 || amount !== statementAmount) reason = "利用金額と支払金額が一致しません";
    else if (finalField !== "") reason = "通常購入の形式ではありません";
    if (reason) {
      needsReviewRows.push({ rowNumber, reason });
      return;
    }

    const sourceFingerprint = fingerprint(["smbc_card", "purchase", date!, rawMerchant, String(amount), "１回払い"]);
    const duplicateOrdinal = (fingerprintOrdinals.get(sourceFingerprint) ?? 0) + 1;
    fingerprintOrdinals.set(sourceFingerprint, duplicateOrdinal);
    transactions.push({
      provider: "smbc_card", externalId: null, kind: "purchase", usedDate: date!, usedTime: null, postedDate: null,
      merchant: rawMerchant, amountYen: amount!, paymentMethod: "1回払い", sourceFingerprint, duplicateOrdinal,
    });
    purchaseAmountTotal += statementAmount!;
    if (!Number.isSafeInteger(purchaseAmountTotal)) unsafeTotal = true;
  });

  // The footer can validate the file only when every detail row is a strict
  // one-time purchase. Unsupported rows may contribute to its total.
  if (unsafeTotal || (needsReviewRows.length === 0 && purchaseAmountTotal !== summaryAmount)) return invalidLayout();

  return {
    transactions, excludedRows: [], needsReviewRows, duplicateRowsInFile: 0, totalRows: detailRows.length,
    encoding, fatalErrors: [], headerSignature: SMBC_HEADER_SIGNATURE,
  };
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
  smbc_card: { provider: "smbc_card", parse: makeSmbcParseResult },
  rakuten_card: rakutenParser,
  aeon_card: unsupportedParser("aeon_card"),
  paypay: { provider: "paypay", parse: makePaypayParseResult },
};

const SHA256_K = [
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
];
function rotateRight(value: number, amount: number): number { return (value >>> amount) | (value << (32 - amount)); }
export function sha256Hex(input: Uint8Array): string {
  const bitLength = input.length * 8;
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength); bytes.set(input); bytes[input.length] = 0x80;
  const view = new DataView(bytes.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000)); view.setUint32(paddedLength - 4, bitLength >>> 0);
  const hash = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) { const a=words[i-15], b=words[i-2]; const s0=rotateRight(a,7)^rotateRight(a,18)^(a>>>3); const s1=rotateRight(b,17)^rotateRight(b,19)^(b>>>10); words[i]=(words[i-16]+s0+words[i-7]+s1)>>>0; }
    let [a,b,c,d,e,f,g,h] = hash;
    for (let i = 0; i < 64; i++) { const s1=rotateRight(e,6)^rotateRight(e,11)^rotateRight(e,25); const ch=(e&f)^(~e&g); const t1=(h+s1+ch+SHA256_K[i]+words[i])>>>0; const s0=rotateRight(a,2)^rotateRight(a,13)^rotateRight(a,22); const maj=(a&b)^(a&c)^(b&c); const t2=(s0+maj)>>>0; h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0; }
    hash[0]=(hash[0]+a)>>>0;hash[1]=(hash[1]+b)>>>0;hash[2]=(hash[2]+c)>>>0;hash[3]=(hash[3]+d)>>>0;hash[4]=(hash[4]+e)>>>0;hash[5]=(hash[5]+f)>>>0;hash[6]=(hash[6]+g)>>>0;hash[7]=(hash[7]+h)>>>0;
  }
  return hash.map((value) => value.toString(16).padStart(8, "0")).join("");
}
export function parseStatementText(text: string, provider: StatementProvider, encoding: StatementParseResult["encoding"] = "utf-8", sourceByteLength?: number): StatementParseResult {
  if ((sourceByteLength ?? new TextEncoder().encode(text).length) > MAX_STATEMENT_FILE_BYTES) return EMPTY_RESULT("limit_exceeded", encoding);
  if (text.includes("\u0000")) return EMPTY_RESULT("invalid_file", encoding);
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
