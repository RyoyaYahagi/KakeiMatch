import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";
import "fake-indexeddb/auto";
import { LocalDataRepository } from "./local-data";
import { LocalStatementService } from "../../apps/pwa/src/local-statements";
import { parseStatementBlob } from "../../apps/pwa/src/statement-parser";
import { sha256Hex } from "./statement-parser-core";
import { createPortableBackup, readPortableBackup } from "./local-backup-format";

const headers = ["取引日", "出金金額（円）", "入金金額（円）", "海外出金金額", "通貨", "変換レート（円）", "利用国", "取引内容", "取引先", "取引方法", "支払い区分", "利用者", "取引番号"];
const base = ["2026/09/28 12:34", "1,000", "", "", "", "", "", "支払い", "人工商店", "PayPay残高", "一回払い", "本人", "synthetic-1"];
const csv = (rows: string[][]) => new Blob([`${rows.map((row) => row.map((field) => `"${field.replaceAll('"', '""')}"`).join(",")).join("\r\n")}\r\n`], { type: "text/csv" });
const smbcMeta = ["SYNTHETIC MEMBER", "SYNTHETIC CARD", "SYNTHETIC STATEMENT"];
const smbcPurchase = ["2026/09/28", "Synthetic Market", "1200", "１", "１", "1200", ""];
const smbcReview = ["2026/09/29", "Synthetic Installment", "9000", "INSTALLMENT", "2", "3000", ""];
const smbcFooter = (amount: string) => ["", "", "", "", "", amount, ""];
const rakutenHeaders = ["利用日", "利用店名・商品名", "利用者", "支払方法", "利用金額", "手数料/利息", "支払総額", "9月支払金額", "当月請求額", "10月繰越残高", "新規サイン"];
const rakutenPurchase = ["2026/09/28", "Synthetic Market", "本人", "1回払い", "1200", "0", "1200", "1200", "1100", "0", ""];
const smbcCsv = (rows: string[][]) => {
  const text = `${rows.map((row) => row.map((field) => `"${field.replaceAll('"', '""')}"`).join(",")).join("\r\n")}\r\n`;
  const bytes = Buffer.concat(text.split(/(１)/).map((part) => part === "１" ? Buffer.from([0x82, 0x50]) : Buffer.from(part, "ascii")));
  return new Blob([bytes], { type: "text/csv" });
};
const repos: LocalDataRepository[] = [];

async function openService(): Promise<{ repository: LocalDataRepository; service: LocalStatementService }> {
  const repository = await LocalDataRepository.open("local-statement-test", new IDBFactory());
  repos.push(repository);
  return { repository, service: new LocalStatementService(repository) };
}

afterEach(() => repos.splice(0).forEach((repository) => repository.close()));

describe("LocalStatementService", () => {
  it("uses standard SHA-256 output for both canonical fingerprints and raw files", () => {
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex(new Uint8Array())).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    for (const length of [55, 56, 63, 64, 65, 1_000, 5 * 1024 * 1024]) {
      const bytes = new Uint8Array(length);
      for (let index = 0; index < bytes.length; index++) bytes[index] = (index * 31 + 7) & 0xff;
      expect(sha256Hex(bytes), `length ${length}`).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
  });

  it("rejects an oversized Blob before reading its bytes", async () => {
    const file = new Blob([new Uint8Array(5 * 1024 * 1024 + 1)]);
    Object.defineProperty(file, "arrayBuffer", { value: () => { throw new Error("must not read oversized file"); } });
    await expect(parseStatementBlob(file, "paypay")).resolves.toMatchObject({ fatalErrors: [{ code: "limit_exceeded" }] });
  });

  it("stores the validated source blob before canonical purchase and refund rows", async () => {
    const { repository, service } = await openService();
    const input = csv([headers, base, [...base.slice(0, 1), "", "250", ...base.slice(3, 7), "返金", "人工商店", "PayPay残高", "", "本人", "synthetic-refund"]]);
    const result = await service.importFile(input, "paypay");
    expect(result).toMatchObject({ added: 2, duplicates: 0, excluded: 0 });
    const raw = await repository.getBlob(`statement-source:${result.id}`);
    expect(raw?.ownerId).toBe(result.id);
    expect(await raw?.blob.text()).toBe(await input.text());
    expect((await service.list()).map(({ kind }) => kind).sort()).toEqual(["purchase", "refund"]);
    expect((await service.list()).find(row => row.kind === "refund")?.amountYen).toBe(250);
    expect((await service.list()).every(row => /^[a-f0-9]{64}$/.test(row.id))).toBe(true);
  });

  it("counts same-file repeats and whole-file repeats as duplicates", async () => {
    const { service } = await openService();
    const input = csv([headers, base, base]);
    const first = await service.importFile(input, "paypay");
    expect(first).toMatchObject({ added: 1, duplicates: 1, duplicateRowsInFile: 1 });
    const again = await service.importFile(input, "paypay");
    expect(again).toMatchObject({ id: first.id, added: 0, duplicates: 2, duplicateRowsInFile: 1 });
  });

  it("rejects malformed and unsupported files without storing their originals", async () => {
    const { repository, service } = await openService();
    await expect(service.importFile(csv([headers, [...base.slice(0, 1), "1.5", ...base.slice(2)]]), "paypay")).rejects.toMatchObject({ issues: [{ code: "invalid_row" }] });
    await expect(service.importFile(new Blob(["a,b\nc,d\n"]), "smbc_card")).rejects.toMatchObject({ issues: [{ code: "unsupported_layout" }] });
    expect(await repository.list("statement-import")).toHaveLength(0);
    expect((await repository.serialize()).blobs).toHaveLength(0);
  });

  it("rejects a changed row that reuses a previously imported external ID", async () => {
    const { service } = await openService();
    await service.importFile(csv([headers, base]), "paypay");
    const changed = [...base]; changed[1] = "2,000";
    await expect(service.importFile(csv([headers, changed]), "paypay")).rejects.toMatchObject({ issues: [{ code: "duplicate_external_id_conflict" }] });
  });

  it("stores SMBC review reasons without row values and keeps them in backup records", async () => {
    const { repository, service } = await openService();
    const input = smbcCsv([smbcMeta, smbcPurchase, smbcReview, smbcFooter("4200")]);
    const result = await service.importFile(input, "smbc_card");
    expect(result).toMatchObject({ added: 1, excluded: 0, needsReviewRows: [{ rowNumber: 3, reason: "1回払い以外の可能性があります" }] });
    const metadata = (await repository.get<{ headerSignature: string; needsReviewRows?: unknown[]; totalRows: number }>(result.id))?.value;
    expect(metadata).toMatchObject({ headerSignature: "smbc-vpass-cp932-v1", needsReviewRows: [{ rowNumber: 3, reason: "1回払い以外の可能性があります" }], totalRows: 2 });
    expect(JSON.stringify(metadata)).not.toContain("SYNTHETIC MEMBER");
    const portable = await createPortableBackup({ actualBackup: new Uint8Array([0x50, 0x4b, 0x03, 0x04]), localData: await repository.serialize() });
    const restored = await readPortableBackup(portable);
    expect(restored.localData.records.find((record) => record.id === result.id)?.value).toEqual(metadata);
  });

  it("deduplicates overlapping SMBC exports by fingerprint and ordinal", async () => {
    const { service } = await openService();
    const firstSubset = smbcCsv([smbcMeta, smbcPurchase, smbcFooter("1200")]);
    const first = await service.importFile(firstSubset, "smbc_card");
    expect(first.added).toBe(1);
    const overlapping = smbcCsv([smbcMeta, smbcPurchase, smbcPurchase, smbcFooter("2400")]);
    const second = await service.importFile(overlapping, "smbc_card");
    expect(second).toMatchObject({ added: 1, duplicates: 1 });
    expect((await service.list()).map(({ duplicateOrdinal }) => duplicateOrdinal).sort()).toEqual([1, 2]);
    const repeat = await service.importFile(overlapping, "smbc_card");
    expect(repeat).toMatchObject({ added: 0, duplicates: 2 });
    expect(await service.list()).toHaveLength(2);
  });

  it("persists Rakuten review reasons and deduplicates overlapping one-time purchases", async () => {
    const { repository, service } = await openService();
    const installment = ["2026/09/28", "Synthetic Installment", "本人", "分割払い", "900", "0", "900", "300", "300", "0", ""];
    const partialParent = ["2026/09/29", "Synthetic Partial", "本人", "1回払い", "500", "0", "500", "", "", "", ""];
    const continuation = ["", "Synthetic Continuation", "", "", "", "", "", "", "", "", ""];
    const firstInput = csv([rakutenHeaders, rakutenPurchase, installment, partialParent, continuation]);
    const first = await service.importFile(firstInput, "rakuten_card");
    expect(first).toMatchObject({ added: 1, duplicates: 0, needsReviewRows: [
      { rowNumber: 3, reason: "1回払い以外の可能性があります" },
      { rowNumber: 4, reason: "複数行明細または部分行の可能性があります" },
      { rowNumber: 5, reason: "継続行または部分行の可能性があります" },
    ] });
    const metadata = (await repository.get<{ needsReviewRows?: unknown[]; headerSignature: string }>(first.id))?.value;
    expect(metadata?.headerSignature).toContain("{month}月支払金額");
    expect(metadata?.needsReviewRows).toEqual(first.needsReviewRows);

    const changedMonths = [...rakutenHeaders];
    changedMonths[7] = "10月支払金額";
    changedMonths[9] = "11月繰越残高";
    const overlapping = await service.importFile(csv([changedMonths, rakutenPurchase, rakutenPurchase]), "rakuten_card");
    expect(overlapping).toMatchObject({ added: 1, duplicates: 1 });
    expect((await service.list()).map(({ duplicateOrdinal }) => duplicateOrdinal).sort()).toEqual([1, 2]);
    const repeatedFile = await service.importFile(csv([changedMonths, rakutenPurchase, rakutenPurchase]), "rakuten_card");
    expect(repeatedFile).toMatchObject({ added: 0, duplicates: 2 });
  });
});
