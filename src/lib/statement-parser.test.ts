import { describe, expect, it } from "vitest";
import { parseStatement, parseStatementText } from "./statement-parser";
import { parseStatementBlob } from "../../apps/pwa/src/statement-parser";

const PAYPAY_CARD_HEADER = [
  "利用日/キャンセル日", "利用店名・商品名", "利用者", "決済方法", "支払区分", "利用金額", "手数料",
  "支払総額", "当月支払金額", "翌月以降繰越金額", "調整額", "当月お支払日",
];
const RAKUTEN_2026_09_HEADER = [
  "利用日", "利用店名・商品名", "利用者", "支払方法", "利用金額", "手数料/利息", "支払総額",
  "9月支払金額", "当月請求額", "10月繰越残高", "新規サイン",
];
const RAKUTEN_12_COLUMN_HEADER = [
  "利用日", "利用店名・商品名", "利用者", "支払方法", "利用金額", "手数料/利息", "支払総額",
  "支払月", "10月支払金額", "当月請求額", "11月繰越残高", "11月以降請求額",
];
const smbcMetadata = ["SYNTHETIC MEMBER", "SYNTHETIC CARD", "SYNTHETIC STATEMENT"];
const smbcPurchase = (merchant = "Synthetic Store", amount = "1200") => ["2026/09/28", merchant, amount, "１", "１", amount, ""];
const smbcFooter = (amount: string) => ["", "", "", "", "", amount, ""];
const parseSmbcSynthetic = (rows: string[][]) => parseStatementText(csv(rows).toString("utf8"), "smbc_card", "cp932");

function row(values: Partial<Record<(typeof PAYPAY_CARD_HEADER)[number], string>> = {}): string[] {
  const base: Record<string, string> = {
    "利用日/キャンセル日": "2026/09/28", "利用店名・商品名": "食堂,駅前店", "利用者": "本人",
    "決済方法": "PayPayクレジット", "支払区分": "1回", "利用金額": "1,000", "手数料": "0",
    "支払総額": "1,000", "当月支払金額": "1,000", "翌月以降繰越金額": "0", "調整額": "0", "当月お支払日": "2026/10/27",
  };
  return PAYPAY_CARD_HEADER.map((header) => values[header] ?? base[header]);
}

function csv(rows: string[][]): Buffer {
  const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
  return Buffer.from(`${rows.map((fields) => fields.map(quote).join(",")).join("\r\n")}\r\n`, "utf8");
}

describe("parseStatement", () => {
  it("parses strict PayPay Card one-time purchases, Japanese merchant, quoted comma, and UTF-8 BOM", () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), csv([PAYPAY_CARD_HEADER, row()])]);
    const result = parseStatement(bytes, "paypay_card");
    expect(result.fatalErrors).toEqual([]);
    expect(result.encoding).toBe("utf-8-bom");
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]).toMatchObject({
      provider: "paypay_card", externalId: null, kind: "purchase", usedDate: "2026-09-28", usedTime: null,
      postedDate: null, merchant: "食堂,駅前店", amountYen: 1000, paymentMethod: "PayPayクレジット（1回）", duplicateOrdinal: 1,
    });
    expect(result.transactions[0].sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps identical-looking distinct transactions by duplicate ordinal", () => {
    const first = row();
    const second = row();
    const result = parseStatement(csv([PAYPAY_CARD_HEADER, first, second]), "paypay_card");
    expect(result.fatalErrors).toEqual([]);
    expect(result.transactions.map((transaction) => transaction.duplicateOrdinal)).toEqual([1, 2]);
    expect(result.transactions[0].sourceFingerprint).toBe(result.transactions[1].sourceFingerprint);
  });

  it("sends negative cancellation rows and their matching purchases to review", () => {
    const result = parseStatement(csv([PAYPAY_CARD_HEADER,
      row(),
      row({ "利用金額": "-1,000", "支払総額": "-1,000", "当月支払金額": "-1,000" }),
    ]), "paypay_card");
    expect(result.fatalErrors).toEqual([]);
    expect(result.transactions).toEqual([]);
    expect(result.needsReviewRows?.map(({ rowNumber }) => rowNumber)).toEqual([2, 3]);
  });

  it("handles quoted quotes and LF row delimiters", () => {
    const bytes = csv([PAYPAY_CARD_HEADER, row({ "利用店名・商品名": '人工"商店' })]);
    const result = parseStatement(Buffer.from(bytes.toString("utf8").replaceAll("\r\n", "\n")), "paypay_card");
    expect(result.fatalErrors).toEqual([]);
    expect(result.transactions[0].merchant).toBe('人工"商店');
  });

  it.each([
    ["クレジットカード", "1回"],
    ["PayPay残高", "1回"],
    ["PayPayクレジット", "分割払い"],
  ])("sends unsupported payment method and type to review", (method, paymentType) => {
    const result = parseStatement(csv([PAYPAY_CARD_HEADER, row({ "決済方法": method, "支払区分": paymentType })]), "paypay_card");
    expect(result.fatalErrors).toEqual([]);
    expect(result.transactions).toHaveLength(0);
    expect(result.needsReviewRows).toHaveLength(1);
  });

  it("reviews malformed amount and date rows and rejects a wrong header", () => {
    for (const badRow of [
      row({ "利用金額": "1.5" }),
      row({ "利用日/キャンセル日": "2026/02/30" }),
    ]) {
      const result = parseStatement(csv([PAYPAY_CARD_HEADER, badRow]), "paypay_card");
      expect(result.fatalErrors).toEqual([]);
      expect(result.transactions).toEqual([]);
      expect(result.needsReviewRows).toHaveLength(1);
    }
    const mismatch = parseStatement(csv([[...PAYPAY_CARD_HEADER].reverse(), row()]), "paypay_card");
    expect(mismatch.fatalErrors[0].code).toBe("header_mismatch");
  });

  it("keeps repeated purchases separate by duplicate ordinal", () => {
    const same = row();
    const exactResult = parseStatement(csv([PAYPAY_CARD_HEADER, same, same]), "paypay_card");
    expect(exactResult.transactions).toHaveLength(2);
    expect(exactResult.excludedRows).toHaveLength(0);
    expect(exactResult.duplicateRowsInFile).toBe(0);
  });

  it("rejects invalid files, empty/header-only files, malformed CSV, oversized fields, and unsupported providers", () => {
    expect(parseStatement(Buffer.alloc(0), "paypay_card").fatalErrors[0].code).toBe("empty_file");
    expect(parseStatement(Buffer.from([0xff, 0xfe, 0x00, 0x00]), "paypay_card").fatalErrors[0].code).toBe("invalid_file");
    expect(parseStatement(Buffer.from([0xef, 0xbb, 0xbf, 0xc3, 0x28]), "rakuten_card").fatalErrors[0].code).toBe("invalid_file");
    expect(parseStatement(Buffer.from("a\u0000b", "utf8"), "paypay_card").fatalErrors[0].code).toBe("invalid_file");
    expect(parseStatement(csv([PAYPAY_CARD_HEADER]), "paypay_card").fatalErrors[0].code).toBe("header_only");
    expect(parseStatement(Buffer.from('"unterminated', "utf8"), "paypay_card").fatalErrors[0].code).toBe("malformed_csv");
    expect(parseStatement(csv([PAYPAY_CARD_HEADER, row({ "利用店名・商品名": "x".repeat(2_001) })]), "paypay_card").fatalErrors[0].code).toBe("limit_exceeded");
    expect(parseStatement(csv([PAYPAY_CARD_HEADER, row()]), "smbc_card").fatalErrors[0].code).toBe("invalid_file");
    expect(parseStatement(csv([PAYPAY_CARD_HEADER, row()]), "aeon_card").fatalErrors[0].code).toBe("unsupported_provider");
    expect(parseStatement(csv([PAYPAY_CARD_HEADER, row()]), "rakuten_card").fatalErrors[0].code).toBe("header_mismatch");
    expect(parseStatement(Buffer.alloc(5 * 1024 * 1024 + 1, 0x61), "paypay_card").fatalErrors[0].code).toBe("limit_exceeded");
    expect(parseStatement(csv([PAYPAY_CARD_HEADER, ...Array.from({ length: 20_001 }, () => row())]), "paypay_card").fatalErrors[0].code).toBe("limit_exceeded");
  });

  it("imports only strict Rakuten one-time purchases and uses 利用金額", () => {
    const synthetic = csv([RAKUTEN_2026_09_HEADER, ["2026/09/01", "人工商店", "本人", "1回払い", "100", "0", "100", "100", "80", "0", ""]]);
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), synthetic]);
    const result = parseStatement(bytes, "rakuten_card");
    expect(result.encoding).toBe("utf-8-bom");
    expect(result.fatalErrors).toEqual([]);
    expect(result.transactions[0]).toMatchObject({
      provider: "rakuten_card", kind: "purchase", usedDate: "2026-09-01", merchant: "人工商店",
      amountYen: 100, paymentMethod: "1回払い", duplicateOrdinal: 1,
    });
    expect(result.headerSignature).toContain("{month}月支払金額");
    expect(result.headerSignature).toContain("{month}月繰越残高");
    const changedMonth = [...RAKUTEN_2026_09_HEADER];
    changedMonth[7] = "10月支払金額";
    changedMonth[9] = "11月繰越残高";
    expect(parseStatement(csv([changedMonth, ["2026/09/01", "人工商店", "本人", "1回払い", "100", "0", "100", "100", "80", "0", ""]]), "rakuten_card").fatalErrors).toEqual([]);
    changedMonth[7] = "13月支払金額";
    expect(parseStatement(csv([changedMonth]), "rakuten_card").fatalErrors[0].code).toBe("header_mismatch");
  });

  it("imports the 12-column e-NAVI layout through the PWA using purchase amounts", async () => {
    const bytes = csv([RAKUTEN_12_COLUMN_HEADER,
      ["2026/09/01", "人工商店", "本人", "1回払い", "1200", "0", "1200", "10月", "1000", "800", "0", ""],
    ]);
    const result = await parseStatementBlob(new Blob([new Uint8Array(bytes)]), "rakuten_card");
    expect(result.fatalErrors).toEqual([]);
    expect(result.transactions).toMatchObject([{ merchant: "人工商店", usedDate: "2026-09-01", amountYen: 1200 }]);
    expect(parseStatement(bytes, "rakuten_card")).toEqual(result);
  });

  it("validates every 12-column header, monthly suffix, and row width", () => {
    const normal = ["2026/09/01", "人工商店", "本人", "1回払い", "1200", "0", "1200", "10月", "1200", "1200", "0", ""];
    for (const index of [7, 8, 9, 10, 11]) {
      const changed = [...RAKUTEN_12_COLUMN_HEADER];
      changed[index] = index === 7 || index === 9 ? "未知列" : changed[index].replace(/\d+月/, "13月");
      expect(parseStatement(csv([changed, normal]), "rakuten_card").fatalErrors[0].code).toBe("header_mismatch");
    }
    const december = [...RAKUTEN_12_COLUMN_HEADER];
    december[8] = "12月支払金額";
    december[10] = "1月繰越残高";
    december[11] = "1月以降請求額";
    expect(parseStatement(csv([december, normal]), "rakuten_card").fatalErrors).toEqual([]);
    expect(parseStatement(csv([RAKUTEN_12_COLUMN_HEADER, normal.slice(0, 11)]), "rakuten_card").fatalErrors[0].code).toBe("unsupported_layout");
  });

  it("preserves purchases before empty separators and separately dated incomplete 12-column rows", () => {
    const normal = ["2026/09/01", "人工商店", "本人", "1回払い", "1200", "0", "1200", "10月", "1200", "1200", "0", ""];
    const deferred = ["2026/09/02", "人工翌月店", "本人", "1回払い", "900", "0", "900", "翌月", "", "", "", "900"];
    const section = ["人工セクション", ...Array<string>(11).fill("")];
    const result = parseStatement(csv([RAKUTEN_12_COLUMN_HEADER, normal, deferred, Array<string>(12).fill(""), section]), "rakuten_card");
    expect(result.fatalErrors).toEqual([]);
    expect(result.transactions).toMatchObject([{ merchant: "人工商店" }]);
    expect(result.excludedRows).toEqual([{ rowNumber: 4, reason: "non_expense" }]);
    expect(result.needsReviewRows?.map(({ rowNumber }) => rowNumber)).toEqual([3, 5]);
    const continuation = ["", "人工商品内訳", ...Array<string>(10).fill("")];
    expect(parseStatement(csv([RAKUTEN_12_COLUMN_HEADER, normal, continuation]), "rakuten_card").transactions).toEqual([]);
  });

  it("keeps uncertain 12-column purchases for review without using future billing as purchase amounts", () => {
    const normal = ["2026/09/01", "人工商店", "本人", "1回払い", "1200", "0", "1200", "10月", "1200", "1200", "0", ""];
    const overrides: Array<[number, string]> = [[3, "分割払い"], [3, "１回"], [4, "-1200"], [5, "100"], [7, "13月"], [11, "abc"], [11, "900"], [11, "9007199254740992"]];
    for (const [index, value] of overrides) {
      const changed = [...normal];
      changed[index] = value;
      const result = parseStatement(csv([RAKUTEN_12_COLUMN_HEADER, changed]), "rakuten_card");
      expect(result.fatalErrors).toEqual([]);
      expect(result.transactions).toEqual([]);
      expect(result.needsReviewRows).toHaveLength(1);
    }
  });

  it("keeps split, revolving, bonus, refunds, cancellation, and continuation rows out of canonical purchases", () => {
    const normal = ["2026/09/01", "Synthetic Market", "本人", "1回払い", "100", "0", "100", "100", "80", "0", ""];
    const split = ["2026/09/02", "Synthetic Split", "本人", "分割払い", "900", "0", "900", "300", "300", "0", ""];
    const revolvo = ["2026/09/03", "Synthetic Revolving", "本人", "リボ払い", "800", "0", "800", "200", "200", "0", ""];
    const bonus = ["2026/09/04", "Synthetic Bonus", "本人", "ボーナス払い", "700", "0", "700", "700", "700", "0", ""];
    const refund = ["2026/09/05", "Synthetic Refund", "本人", "1回払い", "-100", "0", "-100", "-100", "-100", "0", ""];
    const cancel = ["2026/09/06", "Synthetic Cancel 取消", "本人", "1回払い", "100", "0", "100", "100", "100", "0", ""];
    const continuation = ["", "Synthetic Product Detail", "", "", "", "", "", "", "", "", ""];
    const result = parseStatement(csv([RAKUTEN_2026_09_HEADER, normal, split, revolvo, bonus, refund, cancel, normal, continuation]), "rakuten_card");
    expect(result.fatalErrors).toEqual([]);
    expect(result.transactions).toMatchObject([{ merchant: "Synthetic Market", amountYen: 100 }]);
    expect(result.needsReviewRows?.map(({ rowNumber }) => rowNumber)).toEqual([3, 4, 5, 6, 7, 8, 9]);
    expect(result.needsReviewRows?.find(({ rowNumber }) => rowNumber === 8)?.reason).toContain("複数行明細");
    expect(result.needsReviewRows?.find(({ rowNumber }) => rowNumber === 9)?.reason).toContain("継続行");
  });

  it("uses stable ordinals for identical purchases and rejects unknown row layouts", () => {
    const normal = ["2026/09/01", "Synthetic Market", "本人", "1回払い", "100", "0", "100", "100", "80", "0", ""];
    const duplicate = parseStatement(csv([RAKUTEN_2026_09_HEADER, normal, normal]), "rakuten_card");
    expect(duplicate.transactions.map(({ duplicateOrdinal }) => duplicateOrdinal)).toEqual([1, 2]);
    expect(parseStatement(csv([RAKUTEN_2026_09_HEADER, normal.slice(0, 10)]), "rakuten_card").fatalErrors[0].code).toBe("unsupported_layout");
    expect(parseStatement(csv([[...RAKUTEN_2026_09_HEADER.slice(0, 10), "未知列"]]), "rakuten_card").fatalErrors[0].code).toBe("header_mismatch");
  });

  it("sends malformed Rakuten date and amount rows to human review", () => {
    const badDate = ["2026/02/30", "Synthetic Market", "本人", "1回払い", "100", "0", "100", "100", "80", "0", ""];
    const badAmount = ["2026/09/01", "Synthetic Market", "本人", "1回払い", "12.5", "0", "12.5", "12.5", "12.5", "0", ""];
    const dashedDate = ["2026-09-01", "Synthetic Market", "本人", "1回払い", "100", "0", "100", "100", "80", "0", ""];
    const unsafeAmount = ["2026/09/01", "Synthetic Market", "本人", "1回払い", "9007199254740992", "0", "9007199254740992", "9007199254740992", "9007199254740992", "0", ""];
    const result = parseStatement(csv([RAKUTEN_2026_09_HEADER, badDate, badAmount, dashedDate, unsafeAmount]), "rakuten_card");
    expect(result.fatalErrors).toEqual([]);
    expect(result.transactions).toEqual([]);
    expect(result.needsReviewRows?.map(({ rowNumber }) => rowNumber)).toEqual([2, 3, 4, 5]);
  });

  it("keeps a partial parent row out when columns 1–7 are filled but billing columns are empty", () => {
    const partial = ["2026/09/01", "Synthetic Pair Parent", "本人", "1回払い", "500", "0", "500", "", "", "", ""];
    const result = parseStatement(csv([RAKUTEN_2026_09_HEADER, partial]), "rakuten_card");
    expect(result.transactions).toEqual([]);
    expect(result.needsReviewRows?.map(({ rowNumber }) => rowNumber)).toEqual([2]);
  });

  it("decodes a synthetic CP932 file for the still-unsupported headerless SMBC format", () => {
    const bytes = Buffer.from([0x82, 0xa0, 0x2c, 0x31, 0x0d, 0x0a]); // "あ,1\r\n" in CP932
    const result = parseStatement(bytes, "smbc_card");
    expect(result.encoding).toBe("cp932");
    expect(result.fatalErrors[0].code).toBe("unsupported_layout");
  });

  it("recognizes the private-metadata Vpass structure and accepts only strict one-time purchases", () => {
    const result = parseSmbcSynthetic([smbcMetadata, smbcPurchase("人工ストア", "1200"), smbcFooter("1200")]);
    expect(result).toMatchObject({ encoding: "cp932", headerSignature: "smbc-vpass-cp932-v1", totalRows: 1, fatalErrors: [] });
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]).toMatchObject({ provider: "smbc_card", externalId: null, kind: "purchase", usedDate: "2026-09-28", merchant: "人工ストア", amountYen: 1200, paymentMethod: "1回払い", duplicateOrdinal: 1 });
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC MEMBER");

    const cp932Text = `${smbcMetadata.join(",")}\r\n2026/09/28,あ,1200,１,１,1200,\r\n,,,,,1200,\r\n`;
    const cp932Bytes = Buffer.concat(cp932Text.split(/([あ１])/).map((part) => part === "あ" ? Buffer.from([0x82, 0xa0]) : part === "１" ? Buffer.from([0x82, 0x50]) : Buffer.from(part, "ascii")));
    const decoded = parseStatement(cp932Bytes, "smbc_card");
    expect(decoded.encoding).toBe("cp932");
    expect(decoded.transactions[0]?.merchant).toBe("あ");
  });

  it("stores only reasons for unsupported SMBC details and skips footer equality for mixed files", () => {
    const installment = ["2026/09/29", "Synthetic Installment", "9000", "分割", "２", "3000", ""];
    const result = parseSmbcSynthetic([smbcMetadata, smbcPurchase(), installment, smbcFooter("4200")]);
    expect(result.fatalErrors).toEqual([]);
    expect(result.transactions).toHaveLength(1);
    expect(result.needsReviewRows).toEqual([{ rowNumber: 3, reason: "1回払い以外の可能性があります" }]);
    expect(JSON.stringify(result)).not.toContain("Synthetic Installment");
  });

  it("keeps an explicitly named fee row for human review even when its columns match a purchase", () => {
    const fee = smbcPurchase("年会費", "500");
    const result = parseSmbcSynthetic([smbcMetadata, fee, smbcFooter("500")]);
    expect(result.fatalErrors).toEqual([]);
    expect(result.transactions).toEqual([]);
    expect(result.needsReviewRows).toEqual([{ rowNumber: 2, reason: "特殊な利用の可能性があります" }]);
  });

  it("sends malformed SMBC dates and amounts to row review without canonicalizing them", () => {
    const badDate = ["2026/02/30", "Synthetic Store", "1200", "１", "１", "1200", ""];
    const badAmount = ["2026/09/28", "Synthetic Store", "12.5", "１", "１", "12.5", ""];
    const result = parseSmbcSynthetic([smbcMetadata, badDate, badAmount, smbcFooter("2400")]);
    expect(result.fatalErrors).toEqual([]);
    expect(result.transactions).toEqual([]);
    expect(result.needsReviewRows).toEqual([
      { rowNumber: 2, reason: "利用日を確認できません" },
      { rowNumber: 3, reason: "利用金額を確認できません" },
    ]);
  });

  it("rejects unknown layouts and fails integrity checks for normal-only files", () => {
    expect(parseSmbcSynthetic([["private", "metadata"], smbcPurchase(), smbcFooter("1200")]).fatalErrors[0].code).toBe("unsupported_layout");
    expect(parseSmbcSynthetic([smbcMetadata, smbcPurchase(), smbcFooter("1300")]).fatalErrors[0].code).toBe("unsupported_layout");
    expect(parseSmbcSynthetic([smbcMetadata, smbcPurchase().slice(0, 6), smbcFooter("1200")]).fatalErrors[0].code).toBe("unsupported_layout");
  });
});
