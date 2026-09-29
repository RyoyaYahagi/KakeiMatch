import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { statementImport, statementTransaction } from "@/db/schema";
import { parseStatement, type CanonicalStatementTransaction, type StatementProvider } from "./statement-parser";
import { statementStorage } from "./statement-storage";

export type ImportIssue = { rowNumber: number | null; code: string };
export type ImportSummary = {
  totalRows: number;
  importedRows: number;
  duplicateRows: number;
  excludedRows: number;
  issues: ImportIssue[];
};

export class StatementImportError extends Error {
  constructor(message: string, readonly status: number, readonly issues: ImportIssue[] = []) {
    super(message);
  }
}

/** Issue #12 reads only canonical fields through this user-scoped interface. */
export async function getCanonicalStatementTransactions(userId: string): Promise<CanonicalStatementTransaction[]> {
  const rows = await db.select({
    provider: statementTransaction.provider,
    externalId: statementTransaction.externalId,
    kind: statementTransaction.kind,
    usedDate: statementTransaction.usedDate,
    usedTime: statementTransaction.usedTime,
    postedDate: statementTransaction.postedDate,
    merchant: statementTransaction.merchant,
    amountYen: statementTransaction.amountYen,
    paymentMethod: statementTransaction.paymentMethod,
    sourceFingerprint: statementTransaction.sourceFingerprint,
    duplicateOrdinal: statementTransaction.duplicateOrdinal,
  }).from(statementTransaction).where(eq(statementTransaction.userId, userId));
  return rows as CanonicalStatementTransaction[];
}

function summaryFromExisting(existing: typeof statementImport.$inferSelect, duplicateRows: number): ImportSummary {
  return {
    totalRows: existing.totalRows,
    importedRows: 0,
    duplicateRows,
    excludedRows: existing.excludedRows,
    issues: [],
  };
}

/** Fully parse first. Only a successfully validated file can reach private storage and a DB transaction. */
export async function importStatement(input: { userId: string; provider: StatementProvider; bytes: Buffer }): Promise<ImportSummary> {
  const { userId, provider, bytes } = input;
  const parsed = parseStatement(bytes, provider);
  if (parsed.fatalErrors.length) {
    throw new StatementImportError("明細を取り込めませんでした。ファイル形式または行の内容を確認してください。", 400, parsed.fatalErrors);
  }
  if (parsed.headerSignature === null) {
    throw new StatementImportError("CSVの列名を確認できませんでした。", 400);
  }
  const headerSignature = parsed.headerSignature;

  const fileHash = createHash("sha256").update(bytes).digest("hex");
  const existing = await db.select().from(statementImport).where(and(
    eq(statementImport.userId, userId), eq(statementImport.provider, provider), eq(statementImport.fileHash, fileHash),
  )).limit(1);
  if (existing[0]) return summaryFromExisting(existing[0], parsed.transactions.length + parsed.duplicateRowsInFile);

  const { storageKey } = await statementStorage.put(bytes);
  try {
    const now = new Date();
    const result = db.transaction((tx) => {
      const importId = randomUUID();
      const claim = tx.insert(statementImport).values({
        id: importId, userId, provider, storageKey, fileHash,
        encoding: parsed.encoding, headerSignature,
        status: "complete", totalRows: parsed.totalRows,
        importedRows: 0, duplicateRows: 0, excludedRows: parsed.excludedRows.length,
        rejectedRows: 0, createdAt: now, completedAt: now,
      }).onConflictDoNothing().returning({ id: statementImport.id }).all();
      if (!claim.length) return null;

      let importedRows = 0;
      let duplicateRows = parsed.duplicateRowsInFile;
      for (const row of parsed.transactions) {
        const inserted = tx.insert(statementTransaction).values({
          id: randomUUID(), importId, userId, provider: row.provider,
          externalId: row.externalId, kind: row.kind, usedDate: row.usedDate,
          usedTime: row.usedTime, postedDate: row.postedDate, merchant: row.merchant,
          amountYen: row.amountYen, paymentMethod: row.paymentMethod,
          sourceFingerprint: row.sourceFingerprint, duplicateOrdinal: row.duplicateOrdinal,
          createdAt: now,
        }).onConflictDoNothing().returning({ id: statementTransaction.id }).all();
        if (inserted.length) importedRows++;
        else {
          if (row.externalId) {
            const previous = tx.select().from(statementTransaction).where(and(
              eq(statementTransaction.userId, userId),
              eq(statementTransaction.provider, provider),
              eq(statementTransaction.externalId, row.externalId),
            )).limit(1).get();
            if (!previous || previous.kind !== row.kind || previous.usedDate !== row.usedDate ||
                previous.usedTime !== row.usedTime || previous.merchant !== row.merchant ||
                previous.amountYen !== row.amountYen) {
              throw new StatementImportError("同じ取引番号に異なる明細が見つかりました。", 409);
            }
          }
          duplicateRows++;
        }
      }
      tx.update(statementImport).set({ importedRows, duplicateRows }).where(eq(statementImport.id, importId)).run();
      return { totalRows: parsed.totalRows, importedRows, duplicateRows, excludedRows: parsed.excludedRows.length, issues: [] };
    });
    if (result) return result;

    // Another request claimed this hash while we stored the bytes. Keep the winning file only.
    await statementStorage.delete(storageKey);
    const winner = await db.select().from(statementImport).where(and(
      eq(statementImport.userId, userId), eq(statementImport.provider, provider), eq(statementImport.fileHash, fileHash),
    )).limit(1);
    if (winner[0]) return summaryFromExisting(winner[0], parsed.transactions.length + parsed.duplicateRowsInFile);
    throw new Error("Import claim was lost");
  } catch (error) {
    try { await statementStorage.delete(storageKey); } catch {
      console.error("明細原本の後始末に失敗しました。");
    }
    throw error;
  }
}
