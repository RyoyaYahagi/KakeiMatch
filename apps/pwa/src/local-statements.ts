import { LocalDataRepository } from "../../../src/lib/local-data";
import { parseStatementBlob, sha256Hex, type CanonicalStatementTransaction, type StatementProvider } from "./statement-parser";

export type LocalStatement = CanonicalStatementTransaction & { id: string; importId: string };

export type StatementImportMetadata = {
  provider: StatementProvider;
  fileHash: string;
  accountId?: string;
  encoding: string;
  headerSignature: string;
  totalRows: number;
  excludedRows: number;
  duplicateRowsInFile: number;
  needsReviewRows?: Array<{ rowNumber: number; reason: string }>;
  createdAt: string;
};

export type LocalStatementImportResult = {
  id: string;
  added: number;
  duplicates: number;
  excluded: number;
  duplicateRowsInFile: number;
  needsReviewRows: Array<{ rowNumber: number; reason: string }>;
};

const FALLBACK_LOCKS = new Map<string, Promise<void>>();

async function withImportLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(key, { mode: "exclusive" }, task);
  }
  const previous = FALLBACK_LOCKS.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  FALLBACK_LOCKS.set(key, current);
  await previous;
  try { return await task(); }
  finally {
    release();
    if (FALLBACK_LOCKS.get(key) === current) FALLBACK_LOCKS.delete(key);
  }
}

function statementId(row: CanonicalStatementTransaction, accountId: string): string {
  return sha256Hex(new TextEncoder().encode(JSON.stringify([
    row.provider,
    accountId,
    row.externalId ?? row.sourceFingerprint,
    row.externalId ? null : row.duplicateOrdinal,
  ])));
}

function canonicalTransactionKey(row: LocalStatement | CanonicalStatementTransaction, accountId: string): string {
  return JSON.stringify([row.provider, accountId, row.externalId ?? row.sourceFingerprint,
    row.externalId ? null : row.duplicateOrdinal ?? null]);
}

function sameExternalTransaction(left: LocalStatement, right: CanonicalStatementTransaction): boolean {
  return left.kind === right.kind && left.usedDate === right.usedDate && left.usedTime === right.usedTime &&
    left.merchant === right.merchant && left.amountYen === right.amountYen;
}

export class LocalStatementService {
  constructor(private readonly repository: LocalDataRepository) {}

  async importFile(file: Blob, provider: StatementProvider, accountId: string): Promise<LocalStatementImportResult> {
    if (!accountId.trim()) throw new Error("明細の支払元を選択してください。");
    return withImportLock(`kakeimatch-statement-import:${this.repository.profileId}`, async () => {
      const parsed = await parseStatementBlob(file, provider);
      if (parsed.fatalErrors.length) {
        const error = new Error("明細を取り込めませんでした。ファイル形式または行の内容を確認してください。");
        Object.assign(error, { issues: parsed.fatalErrors });
        throw error;
      }
      if (parsed.headerSignature === null) throw new Error("CSVの列名を確認できませんでした。");

      const bytes = new Uint8Array(await file.arrayBuffer());
      const fileHash = sha256Hex(bytes);
      const imports = await this.repository.list<StatementImportMetadata>("statement-import");
      const oldImport = imports.find(({ value }) => value.provider === provider && value.fileHash === fileHash && value.accountId === accountId)
        ?? imports.find(({ value }) => value.provider === provider && value.fileHash === fileHash && value.accountId === undefined);
      const importAccounts = new Map(imports.flatMap(({ id, value }) => value.accountId ? [[id, value.accountId] as const] : []));
      if (oldImport && !oldImport.value.accountId) {
        oldImport.value = { ...oldImport.value, accountId };
        importAccounts.set(oldImport.id, accountId);
      }
      const current = (await this.repository.list<LocalStatement>("statement-transaction")).map(({ value }) => value);
      const externalKey = (rowProvider: string, rowAccountId: string, externalId: string) => JSON.stringify([rowProvider, rowAccountId, externalId]);
      const byExternal = new Map(current.filter((row) => row.externalId !== null && importAccounts.has(row.importId))
        .map((row) => [externalKey(row.provider, importAccounts.get(row.importId)!, row.externalId!), row]));
      const byCanonical = new Map(current.filter((row) => importAccounts.has(row.importId))
        .map((row) => [canonicalTransactionKey(row, importAccounts.get(row.importId)!), row]));
      for (const row of parsed.transactions) {
        if (!row.externalId) continue;
        const previous = byExternal.get(externalKey(row.provider, accountId, row.externalId));
        if (previous && !sameExternalTransaction(previous, row)) {
          throw Object.assign(new Error("同じ取引番号に異なる明細が見つかりました。"), {
            issues: [{ rowNumber: null, code: "duplicate_external_id_conflict" }],
          });
        }
      }

      const id = oldImport?.id ?? crypto.randomUUID();
      const now = new Date().toISOString();
      const value: StatementImportMetadata = oldImport?.value ?? {
        provider, fileHash, accountId, encoding: parsed.encoding, headerSignature: parsed.headerSignature,
        totalRows: parsed.totalRows, excludedRows: parsed.excludedRows.length,
        duplicateRowsInFile: parsed.duplicateRowsInFile, needsReviewRows: parsed.needsReviewRows ?? [], createdAt: now,
      };
      await this.repository.putBlob({
        id: `statement-source:${id}`, ownerKind: "statement-import", ownerId: id,
        blob: file, contentType: file.type || "text/csv", createdAt: now,
      });
      await this.repository.put({ id, kind: "statement-import", value, updatedAt: now });

      let added = 0;
      let duplicates = parsed.duplicateRowsInFile;
      for (const row of parsed.transactions) {
        const existing = row.externalId ? byExternal.get(externalKey(row.provider, accountId, row.externalId)) : undefined;
        const local: LocalStatement = { ...row, id: statementId(row, accountId), importId: id };
        if (byCanonical.has(canonicalTransactionKey(row, accountId)) || existing) { duplicates++; continue; }
        await this.repository.put({ id: local.id, kind: "statement-transaction", value: local, updatedAt: now });
        byCanonical.set(canonicalTransactionKey(row, accountId), local);
        if (row.externalId) byExternal.set(externalKey(row.provider, accountId, row.externalId), local);
        added++;
      }
      return { id, added, duplicates, excluded: parsed.excludedRows.length, duplicateRowsInFile: parsed.duplicateRowsInFile, needsReviewRows: parsed.needsReviewRows ?? [] };
    });
  }

  async list(): Promise<LocalStatement[]> {
    return (await this.repository.list<LocalStatement>("statement-transaction")).map(({ value }) => value);
  }

  async imports(): Promise<Array<{ id: string; value: StatementImportMetadata }>> {
    return this.repository.list<StatementImportMetadata>("statement-import");
  }

  async associateAccount(importId: string, accountId: string): Promise<void> {
    if (!accountId.trim()) throw new Error("明細の支払元を選択してください。");
    return withImportLock(`kakeimatch-statement-import:${this.repository.profileId}`, async () => {
      const record = await this.repository.get<StatementImportMetadata>(importId);
      if (!record || record.kind !== "statement-import") throw new Error("明細の取込記録が見つかりません。");
      if (record.value.accountId && record.value.accountId !== accountId) throw new Error("一度割り当てた明細の支払元は変更できません。必要なら別のCSVとして取り込んでください。");
      if (record.value.accountId === accountId) return;
      await this.repository.put({ id: importId, kind: "statement-import", value: { ...record.value, accountId }, updatedAt: new Date().toISOString() });
    });
  }
}
