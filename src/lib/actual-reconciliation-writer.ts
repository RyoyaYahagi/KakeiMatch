import "server-only";

import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { actualBudgetMapping } from "@/db/schema";
import { ActualBudgetNotLinkedError, ActualUnavailableError } from "@/lib/actual-gateway";
import { createActualReceiptWriter, type ActualReceiptRecord } from "@/lib/actual-receipt-writer";
import { env } from "@/lib/env";

const idSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const dateSchema = z.iso.date();

export type ActualReconciliationUpdate = {
  transactionId: string;
  /** Set only when the user explicitly confirmed a same-expense decision. */
  amountYen?: number;
  cleared: true;
};

export type ActualNoReceiptInput = {
  accountId: string;
  date: string;
  amountYen: number;
  merchant: string;
  categoryId: string;
  importedId: string;
};

export interface ActualReconciliationWriter {
  listOpenAccounts(): Promise<{ id: string; name: string }[]>;
  listExpenseCategories(): Promise<{ id: string; name: string }[]>;
  findByImportedId(importedId: string): Promise<ActualReceiptRecord | null>;
  applyTransactionUpdates(updates: ActualReconciliationUpdate[]): Promise<void>;
  importNoReceipt(input: ActualNoReceiptInput): Promise<ActualReceiptRecord>;
}

type BatchApi = {
  init(config: { serverURL: string; password: string; dataDir: string; verbose: false }): Promise<void>;
  downloadBudget(options: { syncId: string }): Promise<void>;
  batchBudgetUpdates(callback: () => Promise<void>): Promise<void>;
  updateTransaction(id: string, fields: { amount?: number; cleared: true }): Promise<null>;
  sync(): Promise<void>;
  shutdown(): Promise<void>;
};

type BatchRunner = (userId: string, updates: ActualReconciliationUpdate[]) => Promise<void>;

function dataDirectory(mappingId: string, syncId: string): string {
  const key = createHash("sha256").update(mappingId).update("\0").update(syncId).digest("hex");
  return resolve(env.ACTUAL_CLI_DATA_DIR, key, "reconciliation-api");
}

async function runBatchApi(userId: string, updates: ActualReconciliationUpdate[]): Promise<void> {
  if (!env.ACTUAL_SERVER_PASSWORD) throw new ActualUnavailableError("configuration");
  const [mapping] = await db.select({ id: actualBudgetMapping.id, syncId: actualBudgetMapping.syncId })
    .from(actualBudgetMapping).where(eq(actualBudgetMapping.userId, userId)).limit(1);
  if (!mapping) throw new ActualBudgetNotLinkedError();

  const directory = dataDirectory(mapping.id, mapping.syncId);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  } catch {
    throw new ActualUnavailableError("configuration");
  }

  // The official API client owns process-global state, so calls are serialized below.
  const api = await import("@actual-app/api") as unknown as BatchApi;
  try {
    await api.init({ serverURL: env.ACTUAL_SERVER_URL, password: env.ACTUAL_SERVER_PASSWORD, dataDir: directory, verbose: false });
    await api.downloadBudget({ syncId: mapping.syncId });
    await api.batchBudgetUpdates(async () => {
      for (const update of updates) {
        await api.updateTransaction(update.transactionId, {
          ...(update.amountYen === undefined ? {} : { amount: update.amountYen }),
          cleared: true,
        });
      }
    });
    await api.sync();
  } catch {
    throw new ActualUnavailableError("process");
  } finally {
    await api.shutdown().catch(() => undefined);
  }
}

let batchTail: Promise<void> = Promise.resolve();
async function serializedBatch(userId: string, updates: ActualReconciliationUpdate[]): Promise<void> {
  const result = batchTail.then(() => runBatchApi(userId, updates));
  batchTail = result.catch(() => undefined);
  return result;
}

export function createActualReconciliationWriter(options: {
  userId: string;
  runBatch?: BatchRunner;
}): ActualReconciliationWriter {
  const userId = idSchema.parse(options.userId);
  const receiptWriter = createActualReceiptWriter({ userId });
  const updateBatch = options.runBatch ?? serializedBatch;

  return {
    listOpenAccounts: () => receiptWriter.listOpenAccounts(),
    listExpenseCategories: () => receiptWriter.listExpenseCategories(),
    findByImportedId: (importedId) => receiptWriter.findByImportedId(importedId),

    async applyTransactionUpdates(updates) {
      const parsed = z.array(z.object({
        transactionId: idSchema,
        amountYen: z.number().int().safe().negative().optional(),
        cleared: z.literal(true),
      }).strict()).min(1).max(500).safeParse(updates);
      if (!parsed.success || new Set(parsed.data?.map(({ transactionId }) => transactionId)).size !== parsed.data?.length) {
        throw new Error("Invalid Actual reconciliation batch.");
      }
      await updateBatch(userId, parsed.data);
    },

    async importNoReceipt(input) {
      const parsed = z.object({
        accountId: idSchema,
        date: dateSchema,
        amountYen: z.number().int().safe().negative(),
        merchant: z.string().trim().min(1).max(200),
        categoryId: idSchema,
        importedId: z.string().min(1).max(200),
      }).strict().safeParse(input);
      if (!parsed.success) throw new Error("Invalid Actual no-receipt transaction.");

      // Actual importTransactions deduplicates by imported_id. Retrying a failed request
      // therefore reads the same row back instead of creating a second transaction.
      const imported = await receiptWriter.findByImportedId(parsed.data.importedId);
      if (!imported) {
        await receiptWriter.importReceipt(parsed.data);
      }
      const saved = await receiptWriter.findByImportedId(parsed.data.importedId);
      if (!saved || saved.accountId !== parsed.data.accountId || saved.date !== parsed.data.date ||
        saved.amountYen !== parsed.data.amountYen || saved.payeeName !== parsed.data.merchant ||
        saved.categoryId !== parsed.data.categoryId) {
        throw new ActualUnavailableError("invalid_data");
      }
      if (!saved.cleared) {
        await updateBatch(userId, [{ transactionId: saved.id, cleared: true }]);
      }
      const verified = await receiptWriter.findByImportedId(parsed.data.importedId);
      if (!verified || verified.id !== saved.id || !verified.cleared || verified.accountId !== parsed.data.accountId ||
        verified.date !== parsed.data.date || verified.amountYen !== parsed.data.amountYen ||
        verified.categoryId !== parsed.data.categoryId) {
        throw new ActualUnavailableError("invalid_data");
      }
      return verified;
    },
  };
}
