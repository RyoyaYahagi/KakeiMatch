import { describe, expect, it } from "vitest";
import {
  categoryKey,
  parseMoneyForwardBlob,
  resolveMoneyForwardCategory,
} from "../../apps/pwa/src/moneyforward-parser";

const headers = "日付,内容,金額(円),保有金融機関,大項目,中項目,メモ,振替,計算対象";

describe("Money Forward CSV parser", () => {
  it("identifies columns by header names, accepts a UTF-8 BOM, and hashes rows without IDs", async () => {
    const reorderedHeaders = "内容,日付,金額(円),大項目,中項目,計算対象,保有金融機関,メモ,振替";
    const text = `\uFEFF${reorderedHeaders}\n架空スーパー,2025/1/2,-1200,食費,食料品,1,合成口座,合成fixture,0\n架空スーパー,2025/1/2,-1200,食費,食料品,1,合成口座,合成fixture,0`;
    const result = await parseMoneyForwardBlob(new Blob([text]));

    expect(result.fatalErrors).toEqual([]);
    expect(result.encoding).toBe("utf-8-bom");
    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[0]).toMatchObject({
      rowNumber: 2, date: "2025-01-02", description: "架空スーパー", amountYen: -1200,
      kind: "expense", accountName: "合成口座", sourceTransactionId: null,
    });
    expect(result.transactions[0]!.sourceKey).toMatch(/^[0-9a-f]{64}$/);
    expect(result.transactions[1]!.sourceKey).toBe(result.transactions[0]!.sourceKey);
  });

  it("reads dates across a year, accepts blank descriptions and IDs, and skips empty records", async () => {
    const text = `${headers},ID\n2026/1/2,,-1200,合成口座,食費,食料品,,0,1,id-jan\n,,,,,,,,,\n2026/12/31,   ,-900,合成口座,食費,食料品,,0,1,\n2026/12/31,   ,-900,合成口座,食費,食料品,,0,1,\n , , , , , , , , , \n2026/2/30,,-100,合成口座,食費,食料品,,0,1,`;
    const result = await parseMoneyForwardBlob(new Blob([text]));
    expect(result.fatalErrors).toEqual([]);
    expect(result.totalRows).toBe(4);
    expect(result.transactions.map(row => [row.date, row.description, row.sourceTransactionId])).toEqual([
      ["2026-01-02", "", "id-jan"], ["2026-12-31", "", null], ["2026-12-31", "", null],
    ]);
    expect(result.transactions[1]!.sourceKey).toBe(result.transactions[2]!.sourceKey);
    expect(result.rowErrors).toEqual([{ rowNumber: 7, reason: "日付を確認できません" }]);
  });

  it("still validates partial records and excludes transfers with blank descriptions", async () => {
    const text = `${headers}\n2026/1/2,,-300,合成口座,食費,食料品,,1,1\n2026/1/2,,-400,合成口座,食費,食料品,,0,0\n,,-100,合成口座,食費,食料品,,0,1\n2026/1/2,,,合成口座,食費,食料品,,0,1`;
    const result = await parseMoneyForwardBlob(new Blob([text]));
    expect(result.transactions).toEqual([]);
    expect(result.excludedRows).toEqual([
      { rowNumber: 2, reason: "transfer" }, { rowNumber: 3, reason: "excluded_from_calculation" },
    ]);
    expect(result.rowErrors).toEqual([
      { rowNumber: 4, reason: "日付を確認できません" }, { rowNumber: 5, reason: "金額を確認できません" },
    ]);
  });

  it("decodes Shift-JIS and retains excluded row reasons and per-row validation errors", async () => {
    const sjisBytes = Uint8Array.from([
      0x93,0xfa,0x95,0x74,0x2c,0x93,0xe0,0x97,0x65,0x2c,0x8b,0xe0,0x8a,0x7a,0x28,0x89,0x7e,0x29,0x2c,
      0x95,0xdb,0x97,0x4c,0x8b,0xe0,0x97,0x5a,0x8b,0x40,0x8a,0xd6,0x2c,0x91,0xe5,0x8d,0x80,0x96,0xda,0x2c,
      0x92,0x86,0x8d,0x80,0x96,0xda,0x2c,0x83,0x81,0x83,0x82,0x2c,0x90,0x55,0x91,0xd6,0x2c,0x8c,0x76,
      0x8e,0x5a,0x91,0xce,0x8f,0xdb,0x0a,0x32,0x30,0x32,0x35,0x2f,0x31,0x2f,0x32,0x2c,0x89,0xcb,0x8b,
      0xf3,0x83,0x58,0x81,0x5b,0x83,0x70,0x81,0x5b,0x2c,0x2d,0x31,0x32,0x30,0x30,0x2c,0x8d,0x87,0x90,
      0xac,0x8c,0xfb,0x8d,0xc0,0x2c,0x90,0x48,0x94,0xef,0x2c,0x90,0x48,0x97,0xbf,0x95,0x69,0x2c,0x2c,
      0x30,0x2c,0x31,0x0a,
    ]);
    const sjis = await parseMoneyForwardBlob(new Blob([sjisBytes]));
    expect(sjis.encoding).toBe("shift_jis");
    expect(sjis.transactions[0]?.description).toBe("架空スーパー");

    const excluded = await parseMoneyForwardBlob(new Blob([`${headers}\n2025/1/2,振替,-300,合成口座,食費,食料品,,1,1\n2025/1/2,対象外,-400,合成口座,食費,食料品,,0,0\n不正な日付,壊れた行,-5,合成口座,食費,食料品,,0,1` ]));
    expect(excluded.excludedRows).toEqual([
      { rowNumber: 2, reason: "transfer" },
      { rowNumber: 3, reason: "excluded_from_calculation" },
    ]);
    expect(excluded.rowErrors).toEqual([{ rowNumber: 4, reason: "日付を確認できません" }]);
  });

  it("maps saved and known categories, and leaves cash/card for human review", () => {
    const row = { kind: "expense" as const, majorCategory: "食費", minorCategory: "食料品" };
    const available = [{ id: "food-id", name: "食費", isIncome: false, hidden: false }];
    expect(categoryKey(row)).toBe(JSON.stringify(["expense", "食費", "食料品"]));
    expect(resolveMoneyForwardCategory(row, available)).toEqual({ categoryId: "food-id", suggestedName: "食費", reason: "" });
    expect(resolveMoneyForwardCategory({ ...row, majorCategory: "健康・医療", minorCategory: "薬" }, [
      { id: "medical-id", name: "医療・健康", isIncome: false, hidden: false },
    ])).toEqual({ categoryId: "medical-id", suggestedName: "医療・健康", reason: "" });
    expect(resolveMoneyForwardCategory({ ...row, majorCategory: "現金・カード", minorCategory: "現金" }, available)).toEqual({
      categoryId: null, suggestedName: "現金・カード", reason: "現金・カードの分類を確認してください",
    });
  });

  it("uses same-name custom categories and physical ending line numbers after multiline fields", async () => {
    expect(resolveMoneyForwardCategory({ kind: "expense", majorCategory: "独自用途", minorCategory: "試験" }, [
      { id: "custom", name: "独自用途", isIncome: false, hidden: false },
    ]).categoryId).toBe("custom");
    const result = await parseMoneyForwardBlob(new Blob([`${headers}\n\n2025/1/2,架空店舗,-100,合成口座,食費,食料品,"複数\n行メモ",0,1\n不正日付,架空店舗,-100,合成口座,食費,食料品,,0,1`]));
    expect(result.transactions[0]?.rowNumber).toBe(4);
    expect(result.rowErrors[0]?.rowNumber).toBe(5);
  });

  it("reports missing and duplicate required headers without attempting row parsing", async () => {
    const duplicate = await parseMoneyForwardBlob(new Blob(["日付,日付,内容,金額（円）,大項目\n2025/1/2,2025/1/2,test,-1,食費"]));
    expect(duplicate.fatalErrors).toEqual([{ rowNumber: null, code: "header_mismatch" }]);
    expect(duplicate.missingHeaders).toEqual([]);
    expect(duplicate.duplicateHeaders).toEqual(["日付"]);

    const missing = await parseMoneyForwardBlob(new Blob(["日付,内容,大項目\n2025/1/2,test,食費"]));
    expect(missing.missingHeaders).toEqual(["金額（円）"]);
  });

  it("keeps unknown flag values as row errors", async () => {
    const result = await parseMoneyForwardBlob(new Blob([`${headers}\n2025/1/2,架空スーパー,-1200,合成口座,食費,食料品,,不明,1`]));
    expect(result.transactions).toEqual([]);
    expect(result.rowErrors).toEqual([{ rowNumber: 2, reason: "振替の値を確認できません" }]);
  });
});
