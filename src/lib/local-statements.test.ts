import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";
import "fake-indexeddb/auto";
import { LocalDataRepository } from "./local-data";
import { LocalStatementService } from "../../apps/pwa/src/local-statements";
import { parseStatementBlob } from "../../apps/pwa/src/statement-parser";
import { sha256Hex } from "./statement-parser-core";

const headers = ["取引日", "出金金額（円）", "入金金額（円）", "海外出金金額", "通貨", "変換レート（円）", "利用国", "取引内容", "取引先", "取引方法", "支払い区分", "利用者", "取引番号"];
const base = ["2026/09/28 12:34", "1,000", "", "", "", "", "", "支払い", "人工商店", "PayPay残高", "一回払い", "本人", "synthetic-1"];
const csv = (rows: string[][]) => new Blob([`${rows.map((row) => row.map((field) => `"${field.replaceAll('"', '""')}"`).join(",")).join("\r\n")}\r\n`], { type: "text/csv" });
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
    await expect(service.importFile(new Blob(["a,b\nc,d\n"]), "smbc_card")).rejects.toMatchObject({ issues: [{ code: "unsupported_provider" }] });
    expect(await repository.list("statement-import")).toHaveLength(0);
    expect((await repository.serialize()).blobs).toHaveLength(0);
  });

  it("rejects a changed row that reuses a previously imported external ID", async () => {
    const { service } = await openService();
    await service.importFile(csv([headers, base]), "paypay");
    const changed = [...base]; changed[1] = "2,000";
    await expect(service.importFile(csv([headers, changed]), "paypay")).rejects.toMatchObject({ issues: [{ code: "duplicate_external_id_conflict" }] });
  });
});
