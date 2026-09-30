import { describe, expect, it } from "vitest";
import { createPortableBackup, readPortableBackup } from "./local-backup-format";
import type { LocalDataBackupV2 } from "./local-data";

const time = "2026-09-30T00:00:00.000Z";

function fixture(): LocalDataBackupV2 {
  return {
    format: "kakeimatch-local-data", schemaVersion: 2, exportedAt: time,
    records: [
      { id: "receipt:synthetic-1", kind: "receipt-metadata", updatedAt: time, value: {
        id: "receipt:synthetic-1", createdAt: time, updatedAt: time,
        image: { blobId: "receipt-image:synthetic-1", contentType: "image/jpeg", sizeBytes: 4 },
        extraction: { documentKind: "receipt", merchant: "Synthetic Cafe", purchasedDate: "2026-09-28", purchasedTime: "12:30", totalAmountYen: 1200, taxAmountYen: null, items: [{ name: "Coffee", amountYen: 1200 }], warnings: [] },
        aiSuggestion: { categoryId: "food", source: "jev", probabilities: { food: 1, household: 0, transport: 0, medical: 0, clothing: 0, entertainment: 0, utilities: 0, communications: 0, other: 0 }, model: "synthetic-model", attemptedAt: time },
        confirmedValue: { merchant: "Synthetic Cafe", purchasedDate: "2026-09-28", purchasedTime: null, totalAmountYen: 1200, categoryId: "food", accountId: "synthetic-account" },
        registration: { status: "applied", actualTransactionId: "actual-synthetic-transaction", lastError: null },
      } },
      { id: "receipt-extraction:receipt:synthetic-1", kind: "receipt-extraction", updatedAt: time, value: { receiptId: "receipt:synthetic-1", analyzedAt: time, extraction: {
        documentKind: "receipt", merchant: "Synthetic Cafe", purchasedDate: "2026-09-28", purchasedTime: "12:30", totalAmountYen: 1200, taxAmountYen: null, items: [], warnings: [],
      } } },
      { id: "statement-import-synthetic", kind: "statement-import", updatedAt: time, value: { provider: "paypay", fileHash: "a".repeat(64), encoding: "utf-8", headerSignature: "synthetic-header", totalRows: 1, excludedRows: 0, duplicateRowsInFile: 0, createdAt: time } },
      { id: "statement-transaction-synthetic", kind: "statement-transaction", updatedAt: time, value: { id: "statement-transaction-synthetic", importId: "statement-import-synthetic", provider: "paypay", externalId: "synthetic-external-id", kind: "purchase", usedDate: "2026-09-28", usedTime: "12:34:00", postedDate: null, merchant: "Synthetic Cafe", amountYen: 1200, paymentMethod: null, sourceFingerprint: "a".repeat(64), duplicateOrdinal: 0 } },
      { id: "reconciliation-run:synthetic-run", kind: "reconciliation-run", updatedAt: time, value: { runId: "synthetic-run", createdAt: time, completedAt: time, ruleVersion: "1.0.0", candidates: [], statementResults: [], receiptResults: [] } },
      { id: "settings:budget", kind: "app-settings", updatedAt: time, value: { budgetId: "synthetic-budget-id", dataDir: "synthetic-data-dir" } },
      { id: "settings:backup", kind: "app-settings", updatedAt: time, value: { lastExportAt: time } },
    ],
    blobs: [
      { id: "receipt-image:synthetic-1", ownerKind: "receipt", ownerId: "receipt:synthetic-1", blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/jpeg" }), contentType: "image/jpeg", createdAt: time },
      { id: "statement-source:statement-import-synthetic", ownerKind: "statement-import", ownerId: "statement-import-synthetic", blob: new Blob(["date,merchant,amount\n"], { type: "text/csv" }), contentType: "text/csv", createdAt: time },
    ],
  };
}

const actualBackup = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1]);
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_ENTRY_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 10_000;

async function create(input = fixture()): Promise<Blob> {
  return createPortableBackup({ actualBackup, localData: input });
}

async function rewriteManifest(file: Blob, edit: (manifest: Record<string, unknown>) => void): Promise<Blob> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const manifestLength = new DataView(bytes.buffer).getUint32(8, false);
  const manifest = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + manifestLength))) as Record<string, unknown>;
  edit(manifest);
  const text = new TextEncoder().encode(JSON.stringify(manifest));
  const header = new Uint8Array(12);
  header.set(bytes.subarray(0, 8));
  new DataView(header.buffer).setUint32(8, text.byteLength, false);
  return new Blob([header, text, bytes.subarray(12 + manifestLength)]);
}

async function digest(bytes: Uint8Array): Promise<string> {
  const value = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer as ArrayBuffer);
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function rewriteEntry(file: Blob, path: string, replacement: Uint8Array): Promise<Blob> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const manifestLength = new DataView(bytes.buffer).getUint32(8, false);
  const manifest = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + manifestLength))) as { entries: Array<{ path: string; size: number; sha256: string }> };
  let cursor = 12 + manifestLength;
  const contents = manifest.entries.map((entry) => {
    const body = bytes.slice(cursor, cursor + entry.size);
    cursor += entry.size;
    if (entry.path === path) {
      entry.size = replacement.byteLength;
      entry.sha256 = "";
      return replacement;
    }
    return body;
  });
  const target = manifest.entries.find((entry) => entry.path === path);
  if (!target) throw new Error(`Missing entry: ${path}`);
  target.sha256 = await digest(replacement);
  const text = new TextEncoder().encode(JSON.stringify(manifest));
  const header = new Uint8Array(12);
  header.set(bytes.subarray(0, 8));
  new DataView(header.buffer).setUint32(8, text.byteLength, false);
  return new Blob([header, text, ...contents.map((content) => new Uint8Array(content).buffer as ArrayBuffer)]);
}

describe("portable local backup format", () => {
  it("round-trips Actual ZIP bytes, structured records, and raw files", async () => {
    const result = await readPortableBackup(await create());
    expect([...result.actualBackup]).toEqual([...actualBackup]);
    expect(result.localData.records.map(({ kind }) => kind)).toContain("receipt-metadata");
    expect(await result.localData.blobs[0]!.blob.text()).toBe("\u0001\u0002\u0003\u0004");
    expect(await result.localData.blobs[1]!.blob.text()).toContain("date,merchant,amount");
    expect(result.manifest.backupFormatVersion).toBe(1);
    expect(result.manifest.localDataSchemaVersion).toBe(2);
  });

  it("validates every record kind currently written by the PWA, including blank drafts", async () => {
    const data = fixture();
    const values = [
      { id: "receipt-draft:receipt:synthetic-1", kind: "category-state", updatedAt: time, value: { merchant: "", purchasedDate: "", purchasedTime: null, totalAmountYen: 0, categoryId: "", accountId: "" } },
      { id: "merchant:synthetic", kind: "merchant-mapping", updatedAt: time, value: { normalizedMerchant: "synthetic", categoryId: "food" } },
      { id: "merchant-alias:synthetic", kind: "merchant-mapping", updatedAt: time, value: { merchant: "Synthetic Cafe", aliasMerchant: "Synthetic Shop" } },
      { id: "reconciliation-result:synthetic-run", kind: "reconciliation-result", updatedAt: time, value: { ruleVersion: "1.0.0", candidates: [], statementResults: [], receiptResults: [] } },
      { id: "reconciliation-resolution:statement-synthetic", kind: "reconciliation-resolution", updatedAt: time, value: { id: "reconciliation-resolution:statement-synthetic", runId: "synthetic-run", statementId: "statement-synthetic", resolution: "no_receipt", source: "user", receiptId: null, categoryId: "synthetic-category", accountId: "synthetic-account", statementAmountYen: 1200, importedId: "kakeimatch:statement:statement-synthetic", status: "applied", actualTransactionId: "actual-synthetic-transaction", errorCode: null, createdAt: time, updatedAt: time } },
      { id: "reconciliation-pair-rejection:synthetic-run:statement-synthetic:receipt-synthetic", kind: "correction-audit", updatedAt: time, value: { runId: "synthetic-run", statementId: "statement-synthetic", receiptId: "receipt-synthetic" } },
    ] as LocalDataBackupV2["records"];
    data.records.push(...values);
    const result = await readPortableBackup(await create(data));
    expect(new Set(result.localData.records.map(({ kind }) => kind)).size).toBe(11);
  });

  it("records missing source artifacts without inventing blob contents", async () => {
    const data = fixture();
    data.blobs = data.blobs.filter(({ id }) => id !== "receipt-image:synthetic-1");
    const result = await readPortableBackup(await create(data));
    expect(result.localData.blobs.map(({ id }) => id)).toEqual(["statement-source:statement-import-synthetic"]);
    expect(result.manifest.missingRawArtifacts).toEqual([{ id: "receipt-image:synthetic-1", ownerKind: "receipt", ownerId: "receipt:synthetic-1", contentType: "image/jpeg" }]);
  });

  it("rejects checksum corruption and unknown cloud identity settings", async () => {
    const bytes = new Uint8Array(await (await create()).arrayBuffer());
    bytes[bytes.length - 1] ^= 0xff;
    await expect(readPortableBackup(new Blob([bytes]))).rejects.toThrow(/チェックサム/);

    const data = fixture();
    data.records.find(({ id }) => id === "settings:backup")!.value = { lastExportAt: time, cloudUserId: "synthetic-user" };
    await expect(createPortableBackup({ actualBackup, localData: data })).rejects.toThrow(/記録内容が不正/);
  });

  it("rejects duplicated record IDs and unsupported schema versions", async () => {
    const data = fixture();
    data.records.push(data.records[0]!);
    await expect(createPortableBackup({ actualBackup, localData: data })).rejects.toThrow(/記録ID/);

    await expect(readPortableBackup(await rewriteManifest(await create(), (manifest) => { manifest.backupFormatVersion = 99; }))).rejects.toThrow(/未対応/);
  });

  it("rejects path traversal and duplicate archive entry paths", async () => {
    const pathTraversal = await rewriteManifest(await create(), (manifest) => {
      const entries = manifest.entries as Array<Record<string, unknown>>;
      entries[0]!.path = "../actual-budget.zip";
    });
    await expect(readPortableBackup(pathTraversal)).rejects.toThrow(/ファイル名が不正/);
    const duplicate = await rewriteManifest(await create(), (manifest) => {
      const entries = manifest.entries as Array<Record<string, unknown>>;
      entries[1]!.path = entries[0]!.path;
    });
    await expect(readPortableBackup(duplicate)).rejects.toThrow(/ファイル名が不正/);
  });

  it("rejects an oversized entry count before reading entry bodies", async () => {
    const file = await rewriteManifest(await create(), (manifest) => {
      const entries = manifest.entries as Array<Record<string, unknown>>;
      const descriptor = entries[0]!;
      manifest.entries = [...entries, ...Array.from({ length: MAX_ENTRIES - entries.length + 1 }, () => ({ ...descriptor }))];
    });
    expect(file.size).toBeLessThan(MAX_MANIFEST_BYTES + MAX_TOTAL_BYTES);
    await expect(readPortableBackup(file)).rejects.toThrow(/目録/);
  });

  it("rejects a single entry above the individual size cap", async () => {
    const file = await rewriteManifest(await create(), (manifest) => {
      const entries = manifest.entries as Array<Record<string, unknown>>;
      entries[0]!.size = MAX_ENTRY_BYTES + 1;
    });
    await expect(readPortableBackup(file)).rejects.toThrow(/個別上限/);
  });

  it("checks blob size caps before reading any raw bytes", async () => {
    const data = fixture();
    const oversized = data.blobs[0]!;
    Object.defineProperty(oversized.blob, "size", { value: MAX_ENTRY_BYTES + 1 });
    Object.defineProperty(oversized.blob, "arrayBuffer", { value: () => { throw new Error("raw data was read before precheck"); } });
    ((data.records[0]!.value as { image: { sizeBytes: number } }).image).sizeBytes = MAX_ENTRY_BYTES + 1;
    await expect(createPortableBackup({ actualBackup, localData: data })).rejects.toThrow(/個別上限/);
  });

  it("rejects declared entries above the aggregate size cap", async () => {
    const file = await rewriteManifest(await create(), (manifest) => {
      const entries = manifest.entries as Array<Record<string, unknown>>;
      entries.slice(0, 3).forEach((entry) => { entry.size = 100 * 1024 * 1024; });
    });
    await expect(readPortableBackup(file)).rejects.toThrow(/全体が上限/);
  });

  it("rejects a malformed manifest independently of the entry checksums", async () => {
    const bytes = new Uint8Array(await (await create()).arrayBuffer());
    bytes[12] = 0x3f;
    await expect(readPortableBackup(new Blob([bytes]))).rejects.toThrow(/目録を読み取れません/);
  });

  it("rejects malformed and unsupported structured JSON after a valid outer checksum", async () => {
    const malformed = await rewriteEntry(await create(), "local-data.json", new TextEncoder().encode("{"));
    await expect(readPortableBackup(malformed)).rejects.toThrow(/端末データを読み取れません/);

    const data = fixture();
    data.schemaVersion = 99 as 2;
    const structured = new TextEncoder().encode(JSON.stringify({ ...data, blobs: [] }));
    const futureSchema = await rewriteEntry(await create(), "local-data.json", structured);
    await expect(readPortableBackup(futureSchema)).rejects.toThrow(/未対応/);
  });
});
