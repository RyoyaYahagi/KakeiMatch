import { describe, expect, it } from "vitest";
import { accountMetadataRecordId } from "./actual-browser-ledger";
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

describe("account metadata backup", () => {
  it("preserves a budget-scoped account type and accepts backups without account metadata", async () => {
    const oldBackup = await readPortableBackup(await create());
    expect(oldBackup.localData.records.some(record => record.kind === "account-metadata")).toBe(false);
    const data = fixture();
    const budgetId = "synthetic-budget-id";
    const accountId = "synthetic-account";
    data.records.push({ id: accountMetadataRecordId(budgetId, accountId), kind: "account-metadata", updatedAt: time, value: { budgetId, accountId, accountType: "credit_card" } });
    const restored = await readPortableBackup(await create(data));
    expect(restored.localData.records.at(-1)).toEqual(data.records.at(-1));
  });

  it.each([
    { accountType: "wallet" },
    { accountType: "cash", extra: true },
  ])("rejects invalid account metadata values", async invalid => {
    const data = fixture();
    data.records.push({ id: accountMetadataRecordId("budget", "account"), kind: "account-metadata", updatedAt: time, value: { budgetId: "budget", accountId: "account", ...invalid } });
    await expect(create(data)).rejects.toThrow(/記録内容が不正/);
  });

  it("rejects account metadata whose record ID or budget scope is inconsistent", async () => {
    const data = fixture();
    data.records.push({ id: "account-metadata:wrong-id", kind: "account-metadata", updatedAt: time, value: { budgetId: "budget", accountId: "account", accountType: "cash" } });
    await expect(create(data)).rejects.toThrow(/IDが一致/);
    data.records.pop();
    data.records.push({ id: accountMetadataRecordId("budget-a", "account"), kind: "account-metadata", updatedAt: time, value: { budgetId: "budget-a", accountId: "account", accountType: "cash" } });
    data.records.push({ id: accountMetadataRecordId("budget-b", "account"), kind: "account-metadata", updatedAt: time, value: { budgetId: "budget-b", accountId: "account", accountType: "bank" } });
    await expect(create(data)).rejects.toThrow(/複数の家計簿/);
  });
});

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
  it("preserves SMBC row review numbers and reasons through a portable backup", async () => {
    const data = fixture();
    const value = data.records.find((record) => record.id === "statement-import-synthetic")!.value as Record<string, unknown>;
    value.needsReviewRows = [{ rowNumber: 4, reason: "1回払い以外の可能性があります" }];
    const restored = await readPortableBackup(await create(data));
    expect(restored.localData.records.find((record) => record.id === "statement-import-synthetic")?.value).toMatchObject({
      needsReviewRows: [{ rowNumber: 4, reason: "1回払い以外の可能性があります" }],
    });
  });

  it("preserves custom-category learning observations and learned suggestions", async () => {
    const data = fixture();
    const observation = { targetType: "category-learning", receiptId: "receipt:synthetic-1", normalizedMerchant: "synthetic cafe", merchantCategoryId: "custom-category",
      items: [{ normalizedName: "synthetic coffee", categoryId: "custom-category" }], confirmedAt: time };
    data.records.push({ id: "category-learning:receipt:synthetic-1", kind: "correction-audit", updatedAt: time, value: observation });
    const receipt = data.records[0].value as { aiSuggestion: { source: string }; classificationAttempt?: unknown };
    receipt.aiSuggestion.source = "learned_rule";
    receipt.classificationAttempt = { model: "synthetic-model", attemptedAt: time, itemCategories: [null, "custom-category"], categoryId: null };
    const restored = await readPortableBackup(await create(data));
    expect(restored.localData.records.at(-1)?.value).toEqual(observation);
    expect((restored.localData.records[0].value as typeof receipt).classificationAttempt).toEqual(receipt.classificationAttempt);
    observation.items[0].categoryId = "";
    await expect(create(data)).rejects.toThrow(/correction-audit/);
  });
  it("round-trips a pending schedule creation and rejects malformed operation intents", async () => {
    const data = fixture();
    const intent = { targetType: "schedule", operationId: "synthetic-schedule-operation", operation: "create", scheduleId: null,
      input: { name: "Synthetic Subscription", kind: "expense", amountYen: 1500, categoryId: "synthetic-category", accountId: "synthetic-account", frequency: "monthly", startDate: "2026-10-01", postsTransaction: true },
      status: "pending", createdAt: time, appliedAt: null };
    data.records.push({ id: "schedule-operation:synthetic-schedule-operation", kind: "correction-audit", value: intent, updatedAt: time });
    const restored = await readPortableBackup(await create(data));
    expect(restored.localData.records.at(-1)?.value).toEqual(intent);
    intent.input.amountYen = 0.5;
    await expect(create(data)).rejects.toThrow(/correction-audit/);
  });
  it("round-trips new receipt flow IDs while accepting receipts written before the cutover", async () => {
    const data = fixture();
    data.records[0].value = { ...(data.records[0].value as Record<string, unknown>), aiFlowId: "00000000-0000-4000-8000-000000000001" };
    const restored = await readPortableBackup(await create(data));
    expect(restored.localData.records[0].value).toMatchObject({ aiFlowId: "00000000-0000-4000-8000-000000000001" });
    expect((await readPortableBackup(await create())).localData.records[0].value).not.toHaveProperty("aiFlowId");
  });

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
      { id: "receipt-correction:receipt-synthetic", kind: "correction-audit", updatedAt: time, value: { targetType: "receipt", receiptId: "receipt-synthetic", operationId: "operation-synthetic", before: { merchant: "Synthetic", purchasedDate: "2026-09-30", purchasedTime: null, totalAmountYen: 1000, categoryId: "synthetic-category", accountId: "synthetic-account" }, after: { merchant: "Synthetic Updated", purchasedDate: "2026-09-30", purchasedTime: null, totalAmountYen: 1100, categoryId: "synthetic-category", accountId: "synthetic-account" }, status: "pending", createdAt: time, appliedAt: null } },
      { id: "transaction-correction:actual-synthetic", kind: "correction-audit", updatedAt: time, value: { targetType: "transaction", transactionId: "actual-synthetic", operationId: "operation-synthetic", before: { id: "actual-synthetic", date: "2026-09-30", amountYen: -1000, kind: "expense", payeeName: "Synthetic", categoryName: "Food", accountId: "synthetic-account", cleared: false, categoryId: "synthetic-category", memo: null, importedId: "synthetic-import" }, after: { id: "actual-synthetic", date: "2026-09-30", amountYen: -1100, kind: "expense", payeeName: "Synthetic", categoryName: "Food", accountId: "synthetic-account", cleared: false, categoryId: "synthetic-category", memo: null, importedId: "synthetic-import" }, status: "applied", createdAt: time, appliedAt: time } },
    ] as LocalDataBackupV2["records"];
    data.records.push(...values);
    const result = await readPortableBackup(await create(data));
    expect(new Set(result.localData.records.map(({ kind }) => kind)).size).toBe(11);
  });

  it("round-trips reconciliation snapshots while accepting older runs and resolutions without them", async () => {
    const data = fixture();
    data.records.push(
      { id: "reconciliation-run:new-run", kind: "reconciliation-run", updatedAt: time, value: {
        runId: "new-run", createdAt: time, completedAt: time, ruleVersion: "1.0.0", candidates: [], statementResults: [], receiptResults: [],
        inputFingerprint: "b".repeat(64),
      } },
      { id: "reconciliation-resolution:new-statement", kind: "reconciliation-resolution", updatedAt: time, value: {
        id: "reconciliation-resolution:new-statement", runId: "new-run", statementId: "new-statement", resolution: "same_expense",
        source: "automatic", receiptId: "receipt:synthetic-1", categoryId: null, accountId: null, statementAmountYen: 1200,
        importedId: null, status: "failed", actualTransactionId: "actual-synthetic-transaction",
        actualSnapshot: { date: "2026-09-28", amountYen: -1200, payeeName: "Synthetic Cafe", accountId: "synthetic-account", isSplit: false },
        statementSnapshot: { usedDate: "2026-09-28", merchant: "Synthetic Cafe", kind: "purchase" },
        errorCode: "actual_apply_failed", createdAt: time, updatedAt: time,
      } },
      { id: accountMetadataRecordId("synthetic-budget-id", "synthetic-account"), kind: "account-metadata", updatedAt: time, value: {
        budgetId: "synthetic-budget-id", accountId: "synthetic-account", accountType: "credit_card", statementProvider: "paypay",
      } },
    );

    const restored = await readPortableBackup(await create(data));

    expect(restored.localData.records.find(({ id }) => id === "reconciliation-run:synthetic-run")?.value).not.toHaveProperty("inputFingerprint");
    expect(restored.localData.records.find(({ id }) => id === "reconciliation-run:new-run")?.value).toMatchObject({ inputFingerprint: "b".repeat(64) });
    expect(restored.localData.records.find(({ id }) => id === "reconciliation-resolution:new-statement")?.value).toMatchObject({
      actualSnapshot: { amountYen: -1200, isSplit: false }, statementSnapshot: { kind: "purchase" },
    });
    expect(restored.localData.records.find(({ kind }) => kind === "account-metadata")?.value).toMatchObject({ statementProvider: "paypay" });
  });

  it("preserves deletion undo snapshots in archives and rejects unverified native fields", async () => {
    const data = fixture();
    const originalReceipt = data.records.find(record => record.kind === "receipt-metadata")!.value;
    const nativeSnapshot = [{ id: "actual-synthetic-transaction", date: "2026-09-28", amount: -1200, account: "synthetic-account", payee: "synthetic-payee-id", category: "food", cleared: false, reconciled: false, imported_id: "kakeimatch:receipt:synthetic-1", is_parent: false }];
    data.records.push({ id: "transaction-deletion:operation-synthetic", kind: "correction-audit", updatedAt: time, value: {
      targetType: "deletion", transactionId: "actual-synthetic-transaction", operationId: "operation-synthetic", nativeSnapshot,
      receiptBefore: [originalReceipt], status: "deleted", createdAt: time, deletedAt: time,
      undoUntil: "2026-09-30T00:00:10.000Z", completedAt: time,
    } });
    const restored = await readPortableBackup(await create(data));
    expect(restored.localData.records.find(record => record.id === "transaction-deletion:operation-synthetic")?.value).toMatchObject({ status: "deleted", nativeSnapshot, receiptBefore: [originalReceipt] });

    const unverified = structuredClone(data);
    const deletion = unverified.records.find(record => record.kind === "correction-audit" && record.id.startsWith("transaction-deletion:"))!;
    ((deletion.value as { nativeSnapshot: Array<Record<string, unknown>> }).nativeSnapshot[0]!).unknownField = "must reject";
    await expect(create(unverified)).rejects.toThrow(/correction-audit/);
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


it("round trips item IDs, signed discounts, per-item AI categories and drafts while retaining legacy records", async () => {
  const data = fixture();
  const record = data.records[0].value as Record<string, unknown>;
  const details = { items: [{ id: "synthetic-item", name: "Coffee", amountYen: 1300, categoryId: "food", quantity: 1, unitPriceYen: 1300 }], adjustments: [{ id: "synthetic-discount", label: "クーポン", amountYen: -100, targetItemId: "synthetic-item" }], taxAmountYen: 109 };
  record.confirmedValue = { ...(record.confirmedValue as object), ...details };
  record.itemCategories = ["food"];
  (record.aiSuggestion as Record<string, unknown>).flowId = "00000000-0000-4000-8000-000000000001";
  record.extraction = { ...(record.extraction as object), adjustments: [{ label: "クーポン", amountYen: -100, targetItemIndex: 0 }] };
  data.records.push({ id: "receipt-draft:synthetic", kind: "category-state", value: record.confirmedValue, updatedAt: time });
  const restored = await readPortableBackup(await create(data));
  expect(restored.localData.records).toEqual(data.records);
  expect((restored.localData.records[1].value as { extraction: { adjustments?: unknown } }).extraction.adjustments).toBeUndefined();
});

it('preserves a pending manual transaction attempt ID and frozen snapshot in a backup', async () => {
  const data = fixture();
  data.records.push({ id: 'manual-draft:income:new', kind: 'category-state', updatedAt: time, value: { merchant: 'Synthetic Employer', purchasedDate: '2026-09-30', purchasedTime: null, totalAmountYen: 10000, categoryId: 'synthetic-income', accountId: 'synthetic-account', manualKind: 'income', manualMemo: 'Synthetic draft', manualImportedId: 'kakeimatch:manual:00000000-0000-4000-8000-000000000001', manualTransactionId: null, manualStatus: 'processing' } });
  expect((await readPortableBackup(await create(data))).localData.records).toEqual(data.records);
});

it('preserves the destination account and attempt ID of a pending transfer', async () => {
  const data = fixture();
  data.records.push({ id: 'manual-draft:transfer:new', kind: 'category-state', updatedAt: time, value: { merchant: '', purchasedDate: '2026-10-01', purchasedTime: null, totalAmountYen: 10000, categoryId: '', accountId: 'synthetic-source', destinationAccountId: 'synthetic-destination', manualKind: 'transfer', manualMemo: 'Synthetic transfer', manualImportedId: 'kakeimatch:transfer:00000000-0000-4000-8000-000000000002', manualTransactionId: null, manualStatus: 'processing' } });
  expect((await readPortableBackup(await create(data))).localData.records).toEqual(data.records);
});
