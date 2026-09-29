import { describe, expect, it } from "vitest";
import { parseStatement } from "./statement-parser";

const PAYPAY_HEADER = [
  "取引日", "出金金額（円）", "入金金額（円）", "海外出金金額", "通貨", "変換レート（円）", "利用国",
  "取引内容", "取引先", "取引方法", "支払い区分", "利用者", "取引番号",
];

function row(values: Partial<Record<(typeof PAYPAY_HEADER)[number], string>> = {}): string[] {
  const base: Record<string, string> = {
    "取引日": "2026/09/28 12:34", "出金金額（円）": "1,000", "入金金額（円）": "", "海外出金金額": "",
    "通貨": "", "変換レート（円）": "", "利用国": "", "取引内容": "支払い", "取引先": "食堂,駅前店",
    "取引方法": "PayPay残高", "支払い区分": "一回払い", "利用者": "本人", "取引番号": "synthetic-1",
  };
  return PAYPAY_HEADER.map((header) => values[header] ?? base[header]);
}

function csv(rows: string[][]): Buffer {
  const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
  return Buffer.from(`${rows.map((fields) => fields.map(quote).join(",")).join("\r\n")}\r\n`, "utf8");
}

describe("parseStatement", () => {
  it("parses strict PayPay purchases, Japanese merchant, quoted comma, and UTF-8 BOM", () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), csv([PAYPAY_HEADER, row()])]);
    const result = parseStatement(bytes, "paypay");
    expect(result.fatalErrors).toEqual([]);
    expect(result.encoding).toBe("utf-8-bom");
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]).toMatchObject({
      provider: "paypay", externalId: "synthetic-1", kind: "purchase", usedDate: "2026-09-28", usedTime: "12:34:00",
      postedDate: null, merchant: "食堂,駅前店", amountYen: 1000, paymentMethod: "PayPay残高", duplicateOrdinal: 1,
    });
    expect(result.transactions[0].sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps identical-looking distinct transactions by duplicate ordinal", () => {
    const first = row({ "取引番号": "synthetic-a" });
    const second = row({ "取引番号": "synthetic-b" });
    const result = parseStatement(csv([PAYPAY_HEADER, first, second]), "paypay");
    expect(result.fatalErrors).toEqual([]);
    expect(result.transactions.map((transaction) => transaction.duplicateOrdinal)).toEqual([1, 2]);
    expect(result.transactions[0].sourceFingerprint).toBe(result.transactions[1].sourceFingerprint);
  });

  it("parses a refund only from the explicit label and incoming amount", () => {
    const result = parseStatement(csv([PAYPAY_HEADER, row({
      "取引内容": "返金", "出金金額（円）": "", "入金金額（円）": "250", "取引先": "返金店", "取引番号": "synthetic-refund",
    })]), "paypay");
    expect(result.fatalErrors).toEqual([]);
    expect(result.transactions[0]).toMatchObject({ kind: "refund", amountYen: 250 });
  });

  it("handles quoted quotes and LF row delimiters", () => {
    const bytes = csv([PAYPAY_HEADER, row({ "取引先": '人工"商店' })]);
    const result = parseStatement(Buffer.from(bytes.toString("utf8").replaceAll("\r\n", "\n")), "paypay");
    expect(result.fatalErrors).toEqual([]);
    expect(result.transactions[0].merchant).toBe('人工"商店');
  });

  it.each([
    ["チャージ", "0", "500", "synthetic-charge"],
    ["ポイント付与", "0", "30", "lp-synthetic-point"],
    ["ポイント獲得", "0", "30", "synthetic-point-award"],
    ["受け取り", "0", "300", "synthetic-receive"],
    ["給与", "0", "50,000", "synthetic-salary"],
    ["入金", "0", "700", "synthetic-deposit"],
  ])("excludes known non-expense row %s", (kind, outflow, inflow, id) => {
    const result = parseStatement(csv([PAYPAY_HEADER, row({
      "取引内容": kind, "出金金額（円）": outflow, "入金金額（円）": inflow, "取引番号": id,
    })]), "paypay");
    expect(result.fatalErrors).toEqual([]);
    expect(result.transactions).toHaveLength(0);
    expect(result.excludedRows).toEqual([{ rowNumber: 2, reason: "non_expense" }]);
  });

  it("fails the whole parse for malformed amounts, dates, unsupported rows, and wrong headers", () => {
    for (const badRow of [
      row({ "出金金額（円）": "1.5" }),
      row({ "取引日": "2026/02/30 12:34" }),
      row({ "取引内容": "用途不明" }),
    ]) {
      const result = parseStatement(csv([PAYPAY_HEADER, row(), badRow]), "paypay");
      expect(result.fatalErrors).toHaveLength(1);
      expect(result.transactions).toEqual([]);
      expect(result.fatalErrors[0].rowNumber).toBe(3);
    }
    const mismatch = parseStatement(csv([[...PAYPAY_HEADER].reverse(), row()]), "paypay");
    expect(mismatch.fatalErrors[0].code).toBe("header_mismatch");
  });

  it("rejects conflicting repeated external IDs and suppresses exact repeated IDs", () => {
    const same = row();
    const exactResult = parseStatement(csv([PAYPAY_HEADER, same, same]), "paypay");
    expect(exactResult.transactions).toHaveLength(1);
    expect(exactResult.excludedRows).toHaveLength(0);
    expect(exactResult.duplicateRowsInFile).toBe(1);

    const changed = row({ "出金金額（円）": "2,000" });
    const conflict = parseStatement(csv([PAYPAY_HEADER, same, changed]), "paypay");
    expect(conflict.fatalErrors[0].code).toBe("duplicate_external_id_conflict");
    expect(conflict.transactions).toEqual([]);
  });

  it("rejects invalid files, empty/header-only files, malformed CSV, oversized fields, and unsupported providers", () => {
    expect(parseStatement(Buffer.alloc(0), "paypay").fatalErrors[0].code).toBe("empty_file");
    expect(parseStatement(Buffer.from([0xff, 0xfe, 0x00, 0x00]), "paypay").fatalErrors[0].code).toBe("invalid_file");
    expect(parseStatement(Buffer.from("a\u0000b", "utf8"), "paypay").fatalErrors[0].code).toBe("invalid_file");
    expect(parseStatement(csv([PAYPAY_HEADER]), "paypay").fatalErrors[0].code).toBe("header_only");
    expect(parseStatement(Buffer.from('"unterminated', "utf8"), "paypay").fatalErrors[0].code).toBe("malformed_csv");
    expect(parseStatement(csv([PAYPAY_HEADER, row({ "取引先": "x".repeat(2_001) })]), "paypay").fatalErrors[0].code).toBe("limit_exceeded");
    for (const provider of ["smbc_card", "rakuten_card", "aeon_card"] as const) {
      expect(parseStatement(csv([PAYPAY_HEADER, row()]), provider).fatalErrors[0].code).toBe("unsupported_provider");
    }
    expect(parseStatement(Buffer.alloc(5 * 1024 * 1024 + 1, 0x61), "paypay").fatalErrors[0].code).toBe("limit_exceeded");
    expect(parseStatement(csv([PAYPAY_HEADER, ...Array.from({ length: 20_001 }, () => row())]), "paypay").fatalErrors[0].code).toBe("limit_exceeded");
  });
});
