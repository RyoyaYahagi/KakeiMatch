import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";
import "fake-indexeddb/auto";
import { LocalDataRepository } from "./local-data";
import { LocalStatementService } from "../../apps/pwa/src/local-statements";
import { parseStatementBlob } from "../../apps/pwa/src/statement-parser";
import { sha256Hex } from "./statement-parser-core";
import { createPortableBackup, readPortableBackup } from "./local-backup-format";

const headers = ["利用日/キャンセル日", "利用店名・商品名", "利用者", "決済方法", "支払区分", "利用金額", "手数料", "支払総額", "当月支払金額", "翌月以降繰越金額", "調整額", "当月お支払日"];
const base = ["2026/09/28", "人工商店", "本人", "PayPayクレジット", "1回", "1,000", "0", "1,000", "1,000", "0", "0", "2026/10/27"];
const cardRow = (overrides: Partial<Record<(typeof headers)[number], string>> = {}) => headers.map((header, index) => overrides[header] ?? base[index]);
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
    await expect(parseStatementBlob(file, "paypay_card")).resolves.toMatchObject({ fatalErrors: [{ code: "limit_exceeded" }] });
  });

  it("stores the validated source blob, canonical purchases, and review reasons", async () => {
    const { repository, service } = await openService();
    const input = csv([headers, base, cardRow({ "支払区分": "分割払い", "利用金額": "1,200", "支払総額": "1,200", "当月支払金額": "400", "翌月以降繰越金額": "800" })]);
    const result = await service.importFile(input, "paypay_card");
    expect(result).toMatchObject({ added: 1, duplicates: 0, excluded: 0, needsReviewRows: [{ rowNumber: 3, reason: "1回払い以外の可能性があります" }] });
    const raw = await repository.getBlob(`statement-source:${result.id}`);
    expect(raw?.ownerId).toBe(result.id);
    expect(await raw?.blob.text()).toBe(await input.text());
    expect((await service.list()).map(({ kind }) => kind)).toEqual(["purchase"]);
    expect((await service.list())[0]?.amountYen).toBe(1000);
    expect((await service.list()).every(row => /^[a-f0-9]{64}$/.test(row.id))).toBe(true);
  });

  it("counts same-file repeats and whole-file repeats as duplicates", async () => {
    const { service } = await openService();
    const input = csv([headers, base, base]);
    const first = await service.importFile(input, "paypay_card");
    expect(first).toMatchObject({ added: 2, duplicates: 0, duplicateRowsInFile: 0 });
    const again = await service.importFile(input, "paypay_card");
    expect(again).toMatchObject({ id: first.id, added: 0, duplicates: 2, duplicateRowsInFile: 0 });
  });

  it("imports with provider and CSV only and never stores a payment source", async () => {
    const { repository, service } = await openService();
    const result = await service.importFile(csv([headers, base]), "paypay_card");
    const metadata = (await repository.get<Record<string, unknown>>(result.id))!.value;
    expect(metadata).toMatchObject({ provider: "paypay_card" });
    expect(metadata).not.toHaveProperty("accountId");
  });

  it("deduplicates rows from legacy account-scoped imports and keeps their metadata", async () => {
    const { repository, service } = await openService();
    const input = csv([headers, base]);
    const parsed = await parseStatementBlob(input, "paypay_card");
    const row = parsed.transactions[0]!;
    const legacyImportId = "legacy-import";
    await repository.put({ id: legacyImportId, kind: "statement-import", value: {
      provider: "paypay_card", fileHash: "b".repeat(64), accountId: "account-1", encoding: parsed.encoding,
      headerSignature: parsed.headerSignature!, totalRows: 1, excludedRows: 0, duplicateRowsInFile: 0, createdAt: new Date().toISOString(),
    }, updatedAt: new Date().toISOString() });
    await repository.put({ id: "legacy-scoped-row", kind: "statement-transaction", value: { ...row, id: "legacy-scoped-row", importId: legacyImportId }, updatedAt: new Date().toISOString() });

    const repeated = await service.importFile(input, "paypay_card");

    expect(repeated).toMatchObject({ added: 0, duplicates: 1 });
    expect((await service.list()).map(({ id }) => id)).toEqual(["legacy-scoped-row"]);
    expect((await repository.get<Record<string, unknown>>(legacyImportId))?.value).toMatchObject({ accountId: "account-1" });
  });

  it("reuses a legacy import with the same file without dropping its payment source", async () => {
    const { repository, service } = await openService();
    const input = csv([headers, base]);
    const imported = await service.importFile(input, "paypay_card");
    const metadata = (await repository.get<Record<string, unknown>>(imported.id))!.value;
    await repository.put({ id: imported.id, kind: "statement-import", value: { ...metadata, accountId: "account-1" }, updatedAt: new Date().toISOString() });

    const repeated = await service.importFile(input, "paypay_card");

    expect(repeated).toMatchObject({ id: imported.id, added: 0, duplicates: 1 });
    expect((await repository.get<Record<string, unknown>>(imported.id))?.value).toMatchObject({ accountId: "account-1" });
    expect(await service.list()).toHaveLength(1);
  });

  it("rejects malformed and unsupported files without storing their originals", async () => {
    const { repository, service } = await openService();
    await expect(service.importFile(csv([[...headers].reverse(), base]), "paypay_card")).rejects.toMatchObject({ issues: [{ code: "header_mismatch" }] });
    await expect(service.importFile(new Blob(["a,b\nc,d\n"]), "smbc_card")).rejects.toMatchObject({ issues: [{ code: "unsupported_layout" }] });
    expect(await repository.list("statement-import")).toHaveLength(0);
    expect((await repository.serialize()).blobs).toHaveLength(0);
  });

  it("treats a changed amount as a distinct purchase when no external ID is available", async () => {
    const { service } = await openService();
    await service.importFile(csv([headers, base]), "paypay_card");
    const changed = cardRow({ "利用金額": "2,000", "支払総額": "2,000", "当月支払金額": "2,000" });
    const result = await service.importFile(csv([headers, changed]), "paypay_card");
    expect(result.added).toBe(1);
    expect(await service.list()).toHaveLength(2);
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
