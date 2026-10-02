import type { LocalDataRepository } from "../../../src/lib/local-data";
import type { LocalReceipt } from "./local-receipts";
import type { StatementProvider } from "./statement-parser";
import type { LocalStatement } from "./local-statements";

type RawArtifactKind = "receipts" | "statements";

export type CleanupArtifactSummary = {
  count: number;
  bytes: number;
};

export type LocalDataCleanupSummary = {
  receipts: CleanupArtifactSummary;
  statements: CleanupArtifactSummary;
  total: CleanupArtifactSummary;
};

export type CleanupResult = {
  deletedCount: number;
  deletedBytes: number;
};

type StatementImportMetadata = {
  provider: StatementProvider;
  fileHash: string;
  encoding: string;
  headerSignature: string;
  totalRows: number;
  excludedRows: number;
  duplicateRowsInFile: number;
  needsReviewRows?: Array<{ rowNumber: number; reason: string }>;
  createdAt: string;
};

type Candidate = { id: string; bytes: number; kind: RawArtifactKind };

const STATEMENT_PROVIDERS: readonly StatementProvider[] = ["smbc_card", "rakuten_card", "aeon_card", "paypay"];

function isStatementImportMetadata(value: unknown): value is StatementImportMetadata {
  if (!value || typeof value !== "object") return false;
  const metadata = value as Partial<StatementImportMetadata>;
  return STATEMENT_PROVIDERS.includes(metadata.provider as StatementProvider) &&
    typeof metadata.fileHash === "string" && /^[0-9a-f]{64}$/i.test(metadata.fileHash) &&
    typeof metadata.encoding === "string" && metadata.encoding.length > 0 &&
    typeof metadata.headerSignature === "string" && metadata.headerSignature.length > 0 &&
    Number.isSafeInteger(metadata.totalRows) && (metadata.totalRows ?? -1) >= 0 &&
    Number.isSafeInteger(metadata.excludedRows) && (metadata.excludedRows ?? -1) >= 0 &&
    Number.isSafeInteger(metadata.duplicateRowsInFile) && (metadata.duplicateRowsInFile ?? -1) >= 0 &&
    typeof metadata.createdAt === "string" && Number.isFinite(Date.parse(metadata.createdAt));
}

function isCanonicalStatement(value: unknown, importId: string): value is LocalStatement {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<LocalStatement>;
  return row.importId === importId && typeof row.id === "string" && row.id.length > 0 &&
    STATEMENT_PROVIDERS.includes(row.provider as StatementProvider) &&
    (row.kind === "purchase" || row.kind === "refund") &&
    typeof row.usedDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.usedDate) &&
    (row.postedDate === null || (typeof row.postedDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.postedDate))) &&
    typeof row.merchant === "string" && row.merchant.length > 0 &&
    Number.isSafeInteger(row.amountYen) && (row.amountYen ?? 0) > 0 &&
    (row.externalId === null || typeof row.externalId === "string") &&
    (row.sourceFingerprint === undefined || typeof row.sourceFingerprint === "string") &&
    (row.duplicateOrdinal === undefined || Number.isSafeInteger(row.duplicateOrdinal)) &&
    (row.paymentMethod === null || typeof row.paymentMethod === "string") &&
    (row.usedTime === undefined || row.usedTime === null || typeof row.usedTime === "string");
}

async function eligibleCandidates(repo: LocalDataRepository): Promise<Candidate[]> {
  const [receiptRecords, importRecords, statementRecords] = await Promise.all([
    repo.list<LocalReceipt>("receipt-metadata"),
    repo.list<StatementImportMetadata>("statement-import"),
    repo.list<LocalStatement>("statement-transaction"),
  ]);
  const candidates: Candidate[] = [];

  for (const { value: receipt } of receiptRecords) {
    // Applied registration plus confirmed fields make the image unnecessary for
    // retrying extraction or registration. Pending, processing, and failed
    // records keep their original image available for recovery.
    if (!receipt?.image?.blobId || !receipt.confirmedValue ||
      receipt.registration?.status !== "applied" || !receipt.registration.actualTransactionId) continue;
    const blob = await repo.getBlob(receipt.image.blobId);
    if (blob?.ownerKind === "receipt" && blob.ownerId === receipt.id) {
      candidates.push({ id: blob.id, bytes: blob.blob.size, kind: "receipts" });
    }
  }

  const statementsByImport = new Map<string, unknown[]>();
  for (const { value } of statementRecords) {
    if (!value || typeof value.importId !== "string") continue;
    const group = statementsByImport.get(value.importId) ?? [];
    group.push(value);
    statementsByImport.set(value.importId, group);
  }

  for (const { id: importId, value: metadata } of importRecords) {
    const rows = statementsByImport.get(importId);
    // The raw CSV is removable only while import metadata and canonical rows
    // remain available for duplicate detection and reconciliation.
    if (!isStatementImportMetadata(metadata) || !rows?.length ||
      rows.length !== metadata.totalRows - metadata.excludedRows - metadata.duplicateRowsInFile - (metadata.needsReviewRows?.length ?? 0) ||
      !rows.every((row) => isCanonicalStatement(row, importId))) continue;
    const blob = await repo.getBlob(`statement-source:${importId}`);
    if (blob?.ownerKind === "statement-import" && blob.ownerId === importId) {
      candidates.push({ id: blob.id, bytes: blob.blob.size, kind: "statements" });
    }
  }

  return candidates;
}

export async function getCleanupSummary(repo: LocalDataRepository): Promise<LocalDataCleanupSummary> {
  const candidates = await eligibleCandidates(repo);
  const summary: LocalDataCleanupSummary = {
    receipts: { count: 0, bytes: 0 },
    statements: { count: 0, bytes: 0 },
    total: { count: 0, bytes: 0 },
  };
  for (const candidate of candidates) {
    const bucket = summary[candidate.kind];
    bucket.count += 1;
    bucket.bytes += candidate.bytes;
    summary.total.count += 1;
    summary.total.bytes += candidate.bytes;
  }
  return summary;
}

async function cleanup(repo: LocalDataRepository, kind: RawArtifactKind): Promise<CleanupResult> {
  const candidates = (await eligibleCandidates(repo)).filter((candidate) => candidate.kind === kind);
  const result: CleanupResult = { deletedCount: 0, deletedBytes: 0 };
  for (const candidate of candidates) {
    if (!(await eligibleCandidates(repo)).some((current) => current.id === candidate.id && current.kind === kind)) continue;
    // Re-check immediately before deletion in case a caller changed the record
    // while cleanup was in progress.
    const blob = await repo.getBlob(candidate.id);
    if (!blob) continue;
    await repo.deleteBlob(candidate.id);
    result.deletedCount += 1;
    result.deletedBytes += blob.blob.size;
  }
  return result;
}

export function cleanupReceiptImages(repo: LocalDataRepository): Promise<CleanupResult> {
  return cleanup(repo, "receipts");
}

export function cleanupStatementCsv(repo: LocalDataRepository): Promise<CleanupResult> {
  return cleanup(repo, "statements");
}

export type LocalStorageStatus = {
  usage: number | null;
  quota: number | null;
  persisted: boolean | null;
  persistenceRequested: boolean | null;
};

type StorageManagerLike = {
  estimate?: () => Promise<{ usage?: number; quota?: number }>;
  persisted?: () => Promise<boolean>;
  persist?: () => Promise<boolean>;
};

export async function getStorageStatus(options: { requestPersistence?: boolean } = {}): Promise<LocalStorageStatus> {
  const status: LocalStorageStatus = { usage: null, quota: null, persisted: null, persistenceRequested: null };
  const storage = typeof navigator === "undefined"
    ? undefined
    : (navigator as Navigator & { storage?: StorageManagerLike }).storage;
  if (!storage) return status;

  if (typeof storage.estimate === "function") {
    try {
      const estimate = await storage.estimate();
      status.usage = typeof estimate.usage === "number" && Number.isFinite(estimate.usage) ? estimate.usage : null;
      status.quota = typeof estimate.quota === "number" && Number.isFinite(estimate.quota) ? estimate.quota : null;
    } catch {
      // Browser quota estimates are advisory and may be unavailable.
    }
  }

  if (options.requestPersistence && typeof storage.persist === "function") {
    try {
      status.persistenceRequested = await storage.persist();
      status.persisted = status.persistenceRequested;
      return status;
    } catch {
      status.persistenceRequested = null;
    }
  }

  if (typeof storage.persisted === "function") {
    try { status.persisted = await storage.persisted(); }
    catch { status.persisted = null; }
  }
  return status;
}

const EXPORT_REMINDER_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** A generated export timestamp is only a reminder baseline, not proof of a saved file. */
export function shouldRemindLocalExport(lastExportAt: string | null | undefined, now = new Date()): boolean {
  if (!lastExportAt) return true;
  const exportedAt = Date.parse(lastExportAt);
  const currentTime = now.getTime();
  if (!Number.isFinite(exportedAt)) return true;
  if (!Number.isFinite(currentTime) || exportedAt > currentTime) return false;
  return currentTime - exportedAt >= EXPORT_REMINDER_AGE_MS;
}
