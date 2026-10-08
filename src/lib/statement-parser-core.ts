/** Browser-safe parser core shared by the Node API and the PWA. */
import { parse } from "csv-parse/browser/esm/sync";

export type StatementProvider = "smbc_card" | "rakuten_card" | "aeon_card" | "paypay" | "paypay_card";

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
  /** Provider rows kept out of canonical transactions for human review. */
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

const PAYPAY_CARD_HEADERS = [
  "利用日/キャンセル日",
  "利用店名・商品名",
  "利用者",
  "決済方法",
  "支払区分",
  "利用金額",
  "手数料",
  "支払総額",
  "当月支払金額",
  "翌月以降繰越金額",
  "調整額",
  "当月お支払日",
] as const;

const RAKUTEN_HEADER_TEMPLATE = [
  "利用日", "利用店名・商品名", "利用者", "支払方法", "利用金額", "手数料/利息", "支払総額",
  "{month}月支払金額", "当月請求額", "{month}月繰越残高", "新規サイン",
] as const;

const RAKUTEN_12_COLUMN_HEADER_TEMPLATE = [
  "利用日", "利用店名・商品名", "利用者", "支払方法", "利用金額", "手数料/利息", "支払総額",
  "支払月", "{month}月支払金額", "当月請求額", "{month}月繰越残高", "{month}月以降請求額",
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

function parseSignedYen(value: string): number | null {
  const normalized = value.trim();
  if (normalized === "") return 0;
  if (!/^-?(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/.test(normalized)) return null;
  const amount = Number(normalized.replaceAll(",", ""));
  return Number.isSafeInteger(amount) ? amount : null;
}

function parseStrictSmbcYen(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const amount = Number(value);
  return Number.isSafeInteger(amount) ? amount : null;
}

function parseSlashDate(value: string): string | null {
  const match = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day] = match;
  const date = `${year}-${month}-${day}`;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return null;
  return date;
}

function parseFlexibleSlashDate(value: string): string | null {
  const match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day] = match;
  const date = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
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
    const date = parseSlashDate(rawDate);
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

const PAYPAY_CARD_HEADER_SIGNATURE = "paypay-card-statement-v1";

function makePaypayCardParseResult(rows: string[][], encoding: StatementParseResult["encoding"]): StatementParseResult {
  const [headers, ...bodyRows] = rows;
  if (headers.length !== PAYPAY_CARD_HEADERS.length || PAYPAY_CARD_HEADERS.some((header, index) => headers[index] !== header)) {
    return {
      ...EMPTY_RESULT("header_mismatch", encoding),
      totalRows: bodyRows.length,
      headerSignature: null,
    };
  }
  if (bodyRows.length === 0) {
    return {
      ...EMPTY_RESULT("header_only", encoding),
      headerSignature: PAYPAY_CARD_HEADER_SIGNATURE,
    };
  }

  const transactions: CanonicalStatementTransaction[] = [];
  const needsReviewRows: NonNullable<StatementParseResult["needsReviewRows"]> = [];
  const duplicateRowsInFile = 0;
  const fatalErrors: StatementParseResult["fatalErrors"] = [];
  const fingerprintOrdinals = new Map<string, number>();

  const possibleCancellationKeys = new Set<string>();
  for (const row of bodyRows) {
    if (row.length !== PAYPAY_CARD_HEADERS.length) continue;
    const merchant = row[1]?.trim() ?? "";
    for (const value of row.slice(5, 11)) {
      const amount = parseSignedYen(value);
      if (amount !== null && amount < 0) possibleCancellationKeys.add(JSON.stringify([merchant, Math.abs(amount)]));
    }
  }

  bodyRows.forEach((row, index) => {
    const rowNumber = index + 2;
    if (row.length !== PAYPAY_CARD_HEADERS.length || row.some((field) => field.length > MAX_STATEMENT_FIELD_LENGTH)) {
      fatalErrors.push({ rowNumber, code: row.some((field) => field.length > MAX_STATEMENT_FIELD_LENGTH) ? "limit_exceeded" : "invalid_row" });
      return;
    }

    const [rawDate, rawMerchant, , rawPaymentMethod, rawPaymentType, rawPurchaseAmount, rawFee,
      rawTotalAmount, rawCurrentPayment, rawCarryover, rawAdjustment, rawPaymentDate] = row;
    const date = parseFlexibleSlashDate(rawDate.trim());
    const paymentDate = parseFlexibleSlashDate(rawPaymentDate.trim());
    const merchant = rawMerchant.trim();
    const amounts = [rawPurchaseAmount, rawFee, rawTotalAmount, rawCurrentPayment, rawCarryover, rawAdjustment]
      .map(parseSignedYen);

    let reviewReason: string | null = null;
    if (!date) reviewReason = "利用日を確認できません";
    else if (!paymentDate) reviewReason = "当月お支払日を確認できません";
    else if (!merchant) reviewReason = "利用先を確認できません";
    else if (amounts.some((amount) => amount === null)) reviewReason = "金額欄を確認できません";
    else if (rawPaymentMethod.trim() !== "PayPayクレジット") reviewReason = "PayPayクレジット以外の決済方法です";
    else if (rawPaymentType.trim() !== "1回") reviewReason = "1回払い以外の可能性があります";
    else if (/キャンセル|取消|返金|返品/.test(merchant)) reviewReason = "返金・取消の可能性があります";
    if (!reviewReason && amounts.every((amount): amount is number => amount !== null)) {
      const [purchaseAmount, fee, totalAmount, currentPayment, carryover, adjustment] = amounts;
      if (purchaseAmount < 0) reviewReason = "返金・取消の可能性があります";
      else if (possibleCancellationKeys.has(JSON.stringify([merchant, purchaseAmount]))) reviewReason = "同じCSVにキャンセル明細があるため確認してください";
      else if (purchaseAmount <= 0) reviewReason = "利用金額を確認できません";
      else if (fee !== 0 || totalAmount !== purchaseAmount || currentPayment !== purchaseAmount || carryover !== 0 || adjustment !== 0) {
        reviewReason = "支払額に手数料・繰越・調整が含まれる可能性があります";
      }
    }
    if (reviewReason) {
      needsReviewRows.push({ rowNumber, reason: reviewReason });
      return;
    }

    const [purchaseAmount] = amounts as number[];

    const canonicalFields = ["paypay_card", "purchase", date!, merchant, String(purchaseAmount), rawPaymentMethod.trim(), rawPaymentType.trim()];
    const sourceFingerprint = fingerprint(canonicalFields);
    const duplicateOrdinal = (fingerprintOrdinals.get(sourceFingerprint) ?? 0) + 1;
    fingerprintOrdinals.set(sourceFingerprint, duplicateOrdinal);
    transactions.push({
      provider: "paypay_card",
      externalId: null,
      kind: "purchase",
      usedDate: date!,
      usedTime: null,
      postedDate: null,
      merchant,
      amountYen: purchaseAmount,
      paymentMethod: `${rawPaymentMethod.trim()}（${rawPaymentType.trim()}）`,
      sourceFingerprint,
      duplicateOrdinal,
    });
  });

  return {
    transactions: fatalErrors.length ? [] : transactions,
    excludedRows: [], needsReviewRows, duplicateRowsInFile, totalRows: bodyRows.length,
    encoding, fatalErrors, headerSignature: PAYPAY_CARD_HEADER_SIGNATURE,
  };
}

function unsupportedParser(provider: "smbc_card" | "aeon_card" | "paypay"): StatementParser {
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
    const template = [RAKUTEN_HEADER_TEMPLATE, RAKUTEN_12_COLUMN_HEADER_TEMPLATE].find((candidate) =>
      headers.length === candidate.length && candidate.every((header, index) =>
        header.includes("{month}")
          ? new RegExp(`^${header.replace("{month}", "(?:[1-9]|1[0-2])")}$`).test(headers[index])
          : headers[index] === header));
    if (!template) {
      return { ...EMPTY_RESULT("header_mismatch", encoding), totalRows: bodyRows.length, headerSignature: null };
    }
    const is12Column = template === RAKUTEN_12_COLUMN_HEADER_TEMPLATE;
    const headerSignature = JSON.stringify(template);
    if (bodyRows.length === 0) return { ...EMPTY_RESULT("header_only", encoding), headerSignature };

    const transactions: CanonicalStatementTransaction[] = [];
    const excludedRows: StatementParseResult["excludedRows"] = [];
    const needsReviewRows: NonNullable<StatementParseResult["needsReviewRows"]> = [];
    const fingerprintOrdinals = new Map<string, number>();
    let priorCandidate: { rowNumber: number; transactionIndex: number } | null = null;

    const addReview = (rowNumber: number, reason: string, continuation: boolean) => {
      if (continuation && priorCandidate?.rowNumber === rowNumber - 1) {
        const [removed] = transactions.splice(priorCandidate.transactionIndex, 1);
        const ordinal = fingerprintOrdinals.get(removed.sourceFingerprint) ?? 0;
        if (ordinal <= 1) fingerprintOrdinals.delete(removed.sourceFingerprint);
        else fingerprintOrdinals.set(removed.sourceFingerprint, ordinal - 1);
        needsReviewRows.push({ rowNumber: priorCandidate.rowNumber, reason: "複数行明細の可能性があるため確認してください" });
      }
      needsReviewRows.push({ rowNumber, reason });
      priorCandidate = null;
    };

    bodyRows.forEach((row, index) => {
      const rowNumber = index + 2;
      if (row.length !== template.length) return;
      if (row.some((field) => field.length > MAX_STATEMENT_FIELD_LENGTH)) return;
      // e-NAVI separates sections with an all-empty CSV record. This is not a
      // continuation of the preceding purchase; preserve its transaction.
      if (is12Column && row.every((field) => field.trim() === "")) {
        excludedRows.push({ rowNumber, reason: "non_expense" });
        priorCandidate = null;
        return;
      }

      const [rawDate, rawMerchant, , rawPaymentMethod, rawAmount, rawFee, rawTotal] = row;
      const rawMonthlyPayment = row[is12Column ? 8 : 7];
      const rawCurrentAmount = row[is12Column ? 9 : 8];
      const rawCarry = row[is12Column ? 10 : 9];
      const rawNewSign = is12Column ? "" : row[10];
      const rawFutureAmount = is12Column ? row[11] : "";
      const date = parseSlashDate(rawDate);
      const amount = parseYen(rawAmount);
      const parsedOtherAmounts = [rawFee, rawTotal, rawMonthlyPayment, rawCurrentAmount, rawCarry, rawFutureAmount]
        .map((value) => value.trim() === "" ? 0 : parseYen(value));
      const missingPurchaseColumns = [rawTotal, rawMonthlyPayment, rawCurrentAmount].some((value) => value.trim() === "");
      const continuation = rawDate.trim() === "" || rawMerchant.trim() === "" || (!is12Column && missingPurchaseColumns);

      let reason: string | null = null;
      if (!rawDate.trim() || !rawMerchant.trim()) reason = "継続行または部分行の可能性があります";
      else if (!date) reason = "利用日を確認できません";
      else if (/^-/.test(rawAmount.trim()) || /取消|キャンセル|返金|返品/.test(rawMerchant)) reason = "返金・取消の可能性があります";
      else if (rawPaymentMethod !== "1回払い") reason = "1回払い以外の可能性があります";
      else if (amount === null || amount <= 0) reason = "利用金額を確認できません";
      else if (parsedOtherAmounts.some((value) => value === null)) reason = "支払金額欄を確認できません";
      else if (is12Column && !/^(?:[1-9]|1[0-2])月$/.test(row[7])) reason = "支払月を確認できません";
      else if ((parseYen(rawFee) ?? 0) > 0 || rawNewSign.trim() !== "" || (parseYen(rawFutureAmount) ?? 0) > 0) reason = "通常購入の形式ではありません";
      else if (missingPurchaseColumns) reason = "複数行明細または部分行の可能性があります";

      if (reason) {
        addReview(rowNumber, reason, continuation);
        return;
      }

      const merchant = rawMerchant;
      const sourceFingerprint = fingerprint(["rakuten_card", "purchase", date!, merchant, String(amount), rawPaymentMethod]);
      const duplicateOrdinal = (fingerprintOrdinals.get(sourceFingerprint) ?? 0) + 1;
      fingerprintOrdinals.set(sourceFingerprint, duplicateOrdinal);
      const transaction: CanonicalStatementTransaction = {
        provider: "rakuten_card", externalId: null, kind: "purchase", usedDate: date!, usedTime: null, postedDate: null,
        merchant, amountYen: amount!, paymentMethod: rawPaymentMethod, sourceFingerprint, duplicateOrdinal,
      };
      transactions.push(transaction);
      priorCandidate = { rowNumber, transactionIndex: transactions.length - 1 };
    });

    if (bodyRows.some((row) => row.length !== template.length)) {
      return { ...EMPTY_RESULT("unsupported_layout", encoding), totalRows: bodyRows.length, headerSignature };
    }
    if (bodyRows.some((row) => row.some((field) => field.length > MAX_STATEMENT_FIELD_LENGTH))) {
      return { ...EMPTY_RESULT("limit_exceeded", encoding), totalRows: bodyRows.length, headerSignature };
    }

    return {
      transactions, excludedRows, needsReviewRows, duplicateRowsInFile: 0, totalRows: bodyRows.length,
      encoding, fatalErrors: [], headerSignature,
    };
  },
};

const adapters: Record<StatementProvider, StatementParser> = {
  smbc_card: { provider: "smbc_card", parse: makeSmbcParseResult },
  rakuten_card: rakutenParser,
  aeon_card: unsupportedParser("aeon_card"),
  paypay: unsupportedParser("paypay"),
  paypay_card: { provider: "paypay_card", parse: makePaypayCardParseResult },
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
