import { z } from "zod";
import { CATEGORY_IDS } from "./category";
import { LOCAL_DATA_SCHEMA_VERSION, type LocalDataBackupV2, type LocalDataKind, type LocalDataRecord, type LocalBlob } from "./local-data";

const MAGIC = new TextEncoder().encode("KMATCHB1");
const BACKUP_FORMAT_VERSION = 1;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_LOCAL_DATA_BYTES = 64 * 1024 * 1024;
const MAX_ENTRY_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const isoDateTime = z.string().datetime({ offset: true });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
});
const nullableString = z.string().nullable();
const safeYen = z.number().int().safe().nonnegative();
const probabilityMap = z.record(z.enum(CATEGORY_IDS), z.number().finite().min(0).max(1)).nullable();
const receiptItem = z.object({ id: z.string().min(1), name: z.string().min(1), amountYen: safeYen.nullable(), quantity: z.number().finite().positive().nullable().optional(), unitPriceYen: safeYen.nullable().optional(), categoryId: nullableString }).strict();
const receiptAdjustment = z.object({ id: z.string().min(1), label: z.string().min(1), amountYen: z.number().int().safe(), targetItemId: nullableString.optional() }).strict();
const detailFields = { items: z.array(receiptItem).max(100).optional(), adjustments: z.array(receiptAdjustment).max(100).optional(), taxAmountYen: safeYen.nullable().optional() };
const extraction = z.object({
  documentKind: z.enum(["receipt", "not_receipt", "unknown"]), merchant: z.string().nullable(), purchasedDate: date.nullable(),
  purchasedTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).nullable(), totalAmountYen: safeYen.nullable(), taxAmountYen: safeYen.nullable(),
  items: z.array(z.object({ name: z.string(), amountYen: safeYen.nullable(), quantity: z.number().finite().positive().nullable().optional(), unitPriceYen: safeYen.nullable().optional() }).strict()),
  adjustments: z.array(z.object({ label: z.string().min(1), amountYen: z.number().int().safe(), targetItemIndex: z.number().int().nonnegative().nullable().optional() }).strict()).max(100).optional(),
  warnings: z.array(z.object({ field: z.enum(["merchant", "purchasedDate", "purchasedTime", "totalAmountYen", "taxAmountYen", "items", "adjustments"]).nullable(), code: z.string(), message: z.string() }).strict()),
}).strict().refine(value => (value.adjustments ?? []).every(row => row.targetItemIndex == null || row.targetItemIndex < value.items.length));
const receipt = z.object({
  id: z.string().min(1), createdAt: isoDateTime, updatedAt: isoDateTime,
  image: z.object({ blobId: z.string().min(1), contentType: z.string().min(1), sizeBytes: z.number().int().safe().nonnegative() }).strict().nullable(),
  extraction: extraction.nullable(),
  aiFlowId: z.uuid().optional(),
  itemCategories: z.array(nullableString).max(100).optional(),
  aiSuggestion: z.object({ categoryId: z.string().nullable(), source: z.enum(["merchant_mapping", "jev", "unclassified"]), probabilities: probabilityMap, model: nullableString, attemptedAt: isoDateTime.nullable(), flowId: z.uuid().optional() }).strict(),
  confirmedValue: z.object({ merchant: z.string(), purchasedDate: date, purchasedTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).nullable(), totalAmountYen: safeYen, categoryId: z.string(), accountId: z.string(), ...detailFields }).strict().nullable(),
  registration: z.object({ status: z.enum(["pending", "processing", "applied", "failed"]), actualTransactionId: nullableString, lastError: nullableString }).strict(),
}).strict();
const statementImport = z.object({
  provider: z.enum(["smbc_card", "rakuten_card", "aeon_card", "paypay"]), fileHash: z.string().regex(/^[0-9a-f]{64}$/i), encoding: z.string(),
  headerSignature: z.string(), totalRows: z.number().int().safe().nonnegative(), excludedRows: z.number().int().safe().nonnegative(),
  duplicateRowsInFile: z.number().int().safe().nonnegative(), createdAt: isoDateTime,
}).strict();
const statement = z.object({
  id: z.string().min(1), importId: z.string().min(1), provider: z.enum(["smbc_card", "rakuten_card", "aeon_card", "paypay"]),
  externalId: nullableString, kind: z.enum(["purchase", "refund"]), usedDate: date, usedTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/).nullable(),
  postedDate: date.nullable(), merchant: z.string(), amountYen: safeYen, paymentMethod: nullableString, sourceFingerprint: z.string().min(1), duplicateOrdinal: z.number().int().safe().nonnegative(),
}).strict();
const candidate = z.object({ statementTransactionId: z.string(), receiptId: z.string(), rank: z.number().int().positive(), score: z.number().finite().min(0).max(1), amountDeltaYen: safeYen, dateDistanceDays: z.number().int().nonnegative(), merchantSimilarity: z.number().finite().min(0).max(1), reasons: z.array(z.string()) }).strict();
const runResult = z.object({
  ruleVersion: z.string(), candidates: z.array(candidate),
  statementResults: z.array(z.object({ statementTransactionId: z.string(), status: z.enum(["matched", "needs_review", "unmatched_statement"]), matchedReceiptId: nullableString, reasonCodes: z.array(z.string()) }).strict()),
  receiptResults: z.array(z.object({ receiptId: z.string(), status: z.enum(["matched", "needs_review", "unmatched_receipt"]), matchedStatementTransactionId: nullableString, reasonCodes: z.array(z.string()) }).strict()),
}).strict();
const resolution = z.object({
  id: z.string(), runId: z.string(), statementId: z.string(), resolution: z.enum(["same_expense", "no_receipt"]), source: z.enum(["automatic", "user"]),
  receiptId: nullableString, categoryId: nullableString, accountId: nullableString, statementAmountYen: safeYen, importedId: nullableString,
  status: z.enum(["pending", "processing", "applied", "failed"]), actualTransactionId: nullableString, errorCode: nullableString, createdAt: isoDateTime, updatedAt: isoDateTime,
}).strict();

const rawBlobMetadata = z.object({
  id: z.string().min(1), ownerKind: z.enum(["receipt", "statement-import"]), ownerId: z.string().min(1), contentType: z.string().min(1),
  createdAt: isoDateTime, present: z.boolean(), entry: z.string().nullable(), size: z.number().int().safe().nonnegative().nullable(), sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
}).strict();
const missingRaw = z.object({ id: z.string().min(1), ownerKind: z.enum(["receipt", "statement-import"]), ownerId: z.string().min(1), contentType: z.string().nullable() }).strict();
const entryDescriptor = z.object({ path: z.string().min(1), size: z.number().int().safe().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const manifestSchema = z.object({
  backupFormatVersion: z.literal(BACKUP_FORMAT_VERSION), localDataSchemaVersion: z.literal(LOCAL_DATA_SCHEMA_VERSION), exportedAt: isoDateTime,
  entries: z.array(entryDescriptor).min(2).max(MAX_ENTRIES), rawArtifacts: z.array(rawBlobMetadata).max(MAX_ENTRIES), missingRawArtifacts: z.array(missingRaw).max(MAX_ENTRIES),
}).strict();

export type PortableBackupManifest = z.infer<typeof manifestSchema>;
export type PortableBackupContents = { actualBackup: Uint8Array; localData: LocalDataBackupV2; manifest: PortableBackupManifest };

function fail(message: string): never { throw new Error(`バックアップを読み込めませんでした: ${message}`); }
async function hash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function blobPart(bytes: Uint8Array): ArrayBuffer { return new Uint8Array(bytes).buffer as ArrayBuffer; }
function recordValueSchema(kind: LocalDataKind, id: string): z.ZodType {
  switch (kind) {
    case "receipt-metadata": return receipt;
    case "receipt-extraction": return z.object({ receiptId: z.string().min(1), extraction, analyzedAt: isoDateTime }).strict();
    case "category-state": return z.object({ merchant: z.string(), purchasedDate: z.string(), purchasedTime: z.string().nullable(), totalAmountYen: z.number().finite(), categoryId: z.string(), accountId: z.string(), ...detailFields, manualKind: z.enum(["expense", "income"]).optional(), manualMemo: nullableString.optional(), manualImportedId: z.string().min(1).max(200).optional(), manualTransactionId: nullableString.optional(), manualStatus: z.enum(["draft", "processing", "failed"]).optional() }).strict();
    case "merchant-mapping": return id.startsWith("merchant:")
      ? z.union([z.object({ normalizedMerchant: z.string(), categoryId: z.enum(CATEGORY_IDS) }).strict(), z.object({ normalizedMerchant: z.string(), actualCategoryId: z.string().min(1) }).strict()])
      : z.object({ merchant: z.string(), aliasMerchant: z.string() }).strict();
    case "statement-import": return statementImport;
    case "statement-transaction": return statement;
    case "reconciliation-run": return runResult.extend({ runId: z.string(), createdAt: isoDateTime, completedAt: isoDateTime }).strict();
    case "reconciliation-result": return runResult;
    case "reconciliation-resolution": return resolution;
    case "correction-audit": return z.object({ runId: z.string(), statementId: z.string(), receiptId: z.string() }).strict();
    case "app-settings":
      if (id === "settings:budget") return z.object({ budgetId: z.string().min(1), dataDir: z.string().min(1).optional() }).strict();
      if (id === "reconciliation:latest-run") return z.object({ runId: z.string().min(1) }).strict();
      if (id === "settings:backup") return z.object({ lastExportAt: isoDateTime }).strict();
      return z.never();
  }
}

function validateLocalData(value: unknown): LocalDataBackupV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("端末データの形式が不正です。");
  const backup = value as Record<string, unknown>;
  if (Object.keys(backup).some((key) => !["format", "schemaVersion", "exportedAt", "records", "blobs"].includes(key))) fail("端末データに未対応の項目があります。");
  if (backup.format !== "kakeimatch-local-data" || backup.schemaVersion !== LOCAL_DATA_SCHEMA_VERSION || !Array.isArray(backup.records) || !Array.isArray(backup.blobs)) fail("端末データの形式またはschema versionが未対応です。");
  if (typeof backup.exportedAt !== "string" || !isoDateTime.safeParse(backup.exportedAt).success) fail("端末データの日時が不正です。");
  if (backup.records.length + backup.blobs.length > MAX_ENTRIES) fail("添付ファイルまたは記録の件数が上限を超えています。");
  const recordIds = new Set<string>();
  const records: LocalDataRecord[] = backup.records.map((raw) => {
    const parsedRecord = z.object({ id: z.string().min(1), kind: z.enum(["receipt-metadata", "receipt-extraction", "category-state", "merchant-mapping", "statement-import", "statement-transaction", "reconciliation-run", "reconciliation-result", "reconciliation-resolution", "correction-audit", "app-settings"]), value: z.unknown(), updatedAt: isoDateTime }).strict().safeParse(raw);
    if (!parsedRecord.success) fail("端末データに不正な記録があります。");
    const { id, kind, value: recordValue, updatedAt } = parsedRecord.data;
    if (recordIds.has(id)) fail("同じ記録IDが複数あります。");
    recordIds.add(id);
    if (!recordValueSchema(kind, id).safeParse(recordValue).success) fail(`「${kind}」の記録内容が不正です。`);
    if (kind === "receipt-metadata" && (recordValue as { id: string }).id !== id) fail("レシート記録のIDが一致しません。");
    if (kind === "receipt-metadata" || kind === "category-state") {
      const detail = (kind === "receipt-metadata" ? (recordValue as { confirmedValue: unknown }).confirmedValue : recordValue) as { items?: Array<{ id: string }>; adjustments?: Array<{ id: string; targetItemId?: string | null }> } | null;
      if (detail) {
        const items = detail.items ?? [], adjustments = detail.adjustments ?? [];
        if (new Set([...items, ...adjustments].map(row => row.id)).size !== items.length + adjustments.length || adjustments.some(row => row.targetItemId != null && !items.some(item => item.id === row.targetItemId))) fail("品目・値引きのIDまたは対象が不正です。");
      }
    }
    return { id, kind, value: recordValue, updatedAt };
  });
  const blobIds = new Set<string>();
  const blobs: LocalBlob[] = backup.blobs.map((raw) => {
    const base = z.object({ id: z.string().min(1), ownerKind: z.enum(["receipt", "statement-import"]), ownerId: z.string().min(1), blob: z.instanceof(Blob), contentType: z.string().min(1), createdAt: isoDateTime }).strict().safeParse(raw);
    if (!base.success) fail("添付ファイルの情報が不正です。");
    if (blobIds.has(base.data.id)) fail("同じ添付ファイルIDが複数あります。");
    blobIds.add(base.data.id);
    if (base.data.blob.type && base.data.blob.type !== base.data.contentType) fail("添付ファイルの種類が一致しません。");
    return base.data;
  });
  return { format: "kakeimatch-local-data", schemaVersion: LOCAL_DATA_SCHEMA_VERSION, exportedAt: backup.exportedAt, records, blobs };
}

function expectedMissingArtifacts(data: LocalDataBackupV2): Array<z.infer<typeof missingRaw>> {
  const present = new Set(data.blobs.map(({ id }) => id));
  const missing: Array<z.infer<typeof missingRaw>> = [];
  for (const record of data.records) {
    if (record.kind === "receipt-metadata") {
      const image = (record.value as { image: { blobId: string; contentType: string } | null }).image;
      if (image && !present.has(image.blobId)) missing.push({ id: image.blobId, ownerKind: "receipt", ownerId: record.id, contentType: image.contentType });
    }
    if (record.kind === "statement-import") {
      const id = `statement-source:${record.id}`;
      if (!present.has(id)) missing.push({ id, ownerKind: "statement-import", ownerId: record.id, contentType: null });
    }
  }
  return missing;
}

function validateBlobOwners(data: LocalDataBackupV2): void {
  const receipts = new Map(data.records.filter(({ kind }) => kind === "receipt-metadata").map((record) => [record.id, record.value as { image: { blobId: string; contentType: string; sizeBytes: number } | null }]));
  const imports = new Set(data.records.filter(({ kind }) => kind === "statement-import").map(({ id }) => id));
  for (const blob of data.blobs) {
    if (blob.ownerKind === "receipt") {
      const owner = receipts.get(blob.ownerId);
      if (!owner?.image || owner.image.blobId !== blob.id || owner.image.contentType !== blob.contentType || owner.image.sizeBytes !== blob.blob.size) fail("レシート画像と添付ファイルの対応が一致しません。");
    } else if (!imports.has(blob.ownerId) || blob.id !== `statement-source:${blob.ownerId}`) {
      fail("明細原本と添付ファイルの対応が一致しません。");
    }
  }
}

function safePath(path: string): boolean {
  return path.length <= 256 && !path.startsWith("/") && !path.includes("\\") && !path.split("/").some((part) => !part || part === "." || part === "..") && /^[a-z0-9._/-]+$/.test(path);
}

export async function createPortableBackup(input: { actualBackup: Uint8Array; localData: LocalDataBackupV2 }): Promise<Blob> {
  if (!(input.actualBackup instanceof Uint8Array) || input.actualBackup.byteLength === 0) fail("ActualのバックアップZIPが空か不正です。");
  if (input.actualBackup.byteLength > MAX_ENTRY_BYTES) fail("Actualのバックアップが個別上限を超えています。");
  const localData = validateLocalData(input.localData);
  validateBlobOwners(localData);
  const exportedAt = new Date().toISOString();
  const localJson = encoder.encode(JSON.stringify({ ...localData, blobs: [] }));
  if (localJson.byteLength > MAX_LOCAL_DATA_BYTES) fail("端末データが上限を超えています。");
  const sourceEntries: Array<{ path: string; size: number; source: Uint8Array | Blob; sha256?: string }> = [
    { path: "actual-budget.zip", size: input.actualBackup.byteLength, source: input.actualBackup },
    { path: "local-data.json", size: localJson.byteLength, source: localJson },
  ];
  const rawArtifacts: Array<z.infer<typeof rawBlobMetadata>> = [];
  localData.blobs.forEach((item, index) => {
    if (item.blob.size > MAX_ENTRY_BYTES) fail("添付ファイルが個別上限を超えています。");
    rawArtifacts.push({ id: item.id, ownerKind: item.ownerKind, ownerId: item.ownerId, contentType: item.contentType, createdAt: item.createdAt, present: true, entry: `artifacts/${String(index).padStart(6, "0")}.bin`, size: item.blob.size, sha256: null });
    sourceEntries.push({ path: rawArtifacts[index]!.entry!, size: item.blob.size, source: item.blob });
  });
  const missingRawArtifacts = expectedMissingArtifacts(localData);
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const entry of sourceEntries) {
    if (!safePath(entry.path) || paths.has(entry.path)) fail("ファイル名が不正か重複しています。");
    paths.add(entry.path);
    totalBytes += entry.size;
  }
  if (sourceEntries.length > MAX_ENTRIES || totalBytes > MAX_TOTAL_BYTES) fail("バックアップ全体が上限を超えています。");
  const entries = [];
  for (const entry of sourceEntries) {
    const bytes = entry.source instanceof Blob ? new Uint8Array(await entry.source.arrayBuffer()) : entry.source;
    entry.sha256 = await hash(bytes);
    entries.push({ path: entry.path, size: entry.size, sha256: entry.sha256 });
  }
  rawArtifacts.forEach((artifact, index) => { artifact.sha256 = sourceEntries[index + 2]!.sha256!; });
  const manifest = manifestSchema.parse({ backupFormatVersion: BACKUP_FORMAT_VERSION, localDataSchemaVersion: LOCAL_DATA_SCHEMA_VERSION, exportedAt, entries, rawArtifacts, missingRawArtifacts });
  const manifestBytes = encoder.encode(JSON.stringify(manifest));
  if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) fail("目録が上限を超えています。");
  const header = new Uint8Array(MAGIC.length + 4);
  header.set(MAGIC);
  new DataView(header.buffer).setUint32(MAGIC.length, manifestBytes.byteLength, false);
  return new Blob([header, manifestBytes, ...sourceEntries.map(({ source }) => source instanceof Blob ? source : blobPart(source))], { type: "application/vnd.kakeimatch.backup" });
}

export async function readPortableBackup(file: Blob): Promise<PortableBackupContents> {
  if (file.size > MAX_TOTAL_BYTES + MAX_MANIFEST_BYTES + MAGIC.length + 4) fail("バックアップ全体が上限を超えています。");
  if (file.size < MAGIC.length + 4) fail("ファイル形式が違います。");
  const header = new Uint8Array(await file.slice(0, MAGIC.length + 4).arrayBuffer());
  if (!MAGIC.every((byte, index) => header[index] === byte)) fail("ファイル形式が違います。");
  const manifestLength = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(MAGIC.length, false);
  if (manifestLength === 0 || manifestLength > MAX_MANIFEST_BYTES || MAGIC.length + 4 + manifestLength > file.size) fail("目録の長さが不正です。");
  const manifestEnd = MAGIC.length + 4 + manifestLength;
  let manifestUnknown: unknown;
  try { manifestUnknown = JSON.parse(decoder.decode(await file.slice(MAGIC.length + 4, manifestEnd).arrayBuffer())); }
  catch { return fail("目録を読み取れません。"); }
  const parsedManifest = manifestSchema.safeParse(manifestUnknown);
  if (!parsedManifest.success) fail("未対応の形式、または不正な目録です。");
  const manifest = parsedManifest.data;
  const entryByPath = new Map<string, Blob>();
  const declaredPaths = new Set<string>();
  let totalBytes = 0;
  for (const descriptor of manifest.entries) {
    if (!safePath(descriptor.path) || declaredPaths.has(descriptor.path)) fail("ファイル名が不正か重複しています。");
    declaredPaths.add(descriptor.path);
    if (descriptor.size > MAX_ENTRY_BYTES) fail("ファイルが個別上限を超えています。");
    totalBytes += descriptor.size;
    if (totalBytes > MAX_TOTAL_BYTES) fail("バックアップ全体が上限を超えています。");
  }
  let cursor = manifestEnd;
  for (const descriptor of manifest.entries) {
    if (cursor + descriptor.size > file.size) fail("ファイルの長さが不正です。");
    const content = file.slice(cursor, cursor + descriptor.size);
    const checksum = await hash(new Uint8Array(await content.arrayBuffer()));
    if (checksum !== descriptor.sha256) fail("ファイルのチェックサムが一致しません。");
    entryByPath.set(descriptor.path, content);
    cursor += descriptor.size;
  }
  if (cursor !== file.size) fail("未定義のデータが末尾にあります。");
  if (!declaredPaths.has("actual-budget.zip") || !declaredPaths.has("local-data.json")) fail("必要なファイルがありません。");
  if (manifest.entries.length !== 2 + manifest.rawArtifacts.filter((item) => item.present).length) fail("目録のファイル数が一致しません。");
  const actualDescriptor = manifest.entries.find(({ path }) => path === "actual-budget.zip")!;
  const localDescriptor = manifest.entries.find(({ path }) => path === "local-data.json")!;
  if (actualDescriptor.size === 0 || localDescriptor.size > MAX_LOCAL_DATA_BYTES) fail("必須ファイルの長さが不正です。");
  const artifactPaths = manifest.rawArtifacts.map(({ entry }) => entry);
  if (artifactPaths.some((path) => path === null) || new Set(artifactPaths).size !== artifactPaths.length) fail("添付ファイル名が重複しているか不正です。");
  const expectedPaths = new Set(["actual-budget.zip", "local-data.json", ...artifactPaths as string[]]);
  if (expectedPaths.size !== manifest.entries.length || manifest.entries.some(({ path }) => !expectedPaths.has(path))) fail("目録内のファイル一覧が一致しません。");
  let localJson: unknown;
  try { localJson = JSON.parse(await entryByPath.get("local-data.json")!.text()); }
  catch { return fail("端末データを読み取れません。"); }
  const localData = validateLocalData(localJson);
  if (localData.blobs.length !== 0) fail("端末データに未対応の添付形式があります。");
  const rawIds = new Set<string>();
  const hydratedBlobs: LocalBlob[] = [];
  for (const raw of manifest.rawArtifacts) {
    if (rawIds.has(raw.id)) fail("同じ添付ファイルIDが複数あります。");
    rawIds.add(raw.id);
    if (!raw.present || !raw.entry || raw.size === null || !raw.sha256) fail("添付ファイルの目録が不正です。");
    const payload = entryByPath.get(raw.entry);
    const descriptor = manifest.entries.find(({ path }) => path === raw.entry);
    if (!payload || !descriptor || payload.size !== raw.size || descriptor.sha256 !== raw.sha256) fail("添付ファイルが欠落しているか破損しています。");
    hydratedBlobs.push({ id: raw.id, ownerKind: raw.ownerKind, ownerId: raw.ownerId, blob: payload.slice(0, payload.size, raw.contentType), contentType: raw.contentType, createdAt: raw.createdAt });
  }
  validateBlobOwners({ ...localData, blobs: hydratedBlobs });
  if (rawIds.size !== manifest.rawArtifacts.length) fail("添付ファイルの数が目録と一致しません。");
  const missingRawArtifacts = expectedMissingArtifacts({ ...localData, blobs: hydratedBlobs });
  if (JSON.stringify(missingRawArtifacts) !== JSON.stringify(manifest.missingRawArtifacts)) fail("欠損ファイルの目録が一致しません。");
  const localDataWithArtifacts: LocalDataBackupV2 = { ...localData, blobs: hydratedBlobs };
  return { actualBackup: new Uint8Array(await entryByPath.get("actual-budget.zip")!.arrayBuffer()), localData: localDataWithArtifacts, manifest };
}
