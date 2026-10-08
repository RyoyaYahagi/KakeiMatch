import { z } from "zod";
import {
  accountMetadataRecordId,
  type ActualAccountType,
} from "../../../src/lib/actual-browser-ledger";
import type { LocalDataRepository } from "../../../src/lib/local-data";
import type { StatementProvider } from "./statement-parser";

type AccountMetadata = {
  budgetId: string;
  accountId: string;
  accountType: ActualAccountType;
  statementProvider?: StatementProvider;
};
export const accountMetadataSchema = z.object({
  budgetId: z.string().min(1).max(128),
  accountId: z.string().min(1).max(128),
  accountType: z.enum(["bank", "credit_card", "cash", "other"]),
  statementProvider: z.enum(["smbc_card", "rakuten_card", "aeon_card", "paypay", "paypay_card"]).optional(),
}).strict();

const fallbackMetadataLocks = new Map<string, Promise<void>>();
async function withMetadataLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(`kakeimatch-account-metadata:${key}`, { mode: "exclusive" }, task);
  }
  const previous = fallbackMetadataLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  fallbackMetadataLocks.set(key, current);
  await previous;
  try { return await task(); }
  finally {
    release();
    if (fallbackMetadataLocks.get(key) === current) fallbackMetadataLocks.delete(key);
  }
}

/** Adapts profile-local records to the browser ledger's budget-scoped account metadata hooks. */
export function createAccountMetadataAccess(repository: LocalDataRepository) {
  return {
    async getExcludedSpendingIds(budgetId: string): Promise<string[]> {
      const records = await repository.list('app-settings');
      return records.filter(row => row.id.startsWith('settings:spending-exclusion:')).flatMap(row => {
        const value = z.object({ budgetId: z.string().min(1), transactionId: z.string().min(1), excluded: z.literal(true) }).strict().parse(row.value);
        if (row.id !== `settings:spending-exclusion:${encodeURIComponent(value.budgetId)}:${encodeURIComponent(value.transactionId)}`) throw new Error('支出集計の設定が不正です。');
        return value.budgetId === budgetId ? [value.transactionId] : [];
      });
    },
    async saveSpendingExclusion(budgetId: string, transactionId: string, excluded: boolean): Promise<void> {
      const id = `settings:spending-exclusion:${encodeURIComponent(budgetId)}:${encodeURIComponent(transactionId)}`;
      if (!excluded) { await repository.delete(id); return; }
      await repository.put({ id, kind: 'app-settings', value: { budgetId, transactionId, excluded: true }, updatedAt: new Date().toISOString() });
    },
    async getAccountType(budgetId: string, accountId: string): Promise<ActualAccountType | null> {
      const id = accountMetadataRecordId(budgetId, accountId);
      const record = await repository.get<unknown>(id);
      if (!record) return null;
      const parsed = accountMetadataSchema.safeParse(record.value);
      if (record.kind !== "account-metadata" || !parsed.success || parsed.data.budgetId !== budgetId || parsed.data.accountId !== accountId) {
        throw new Error("端末内の口座種類データが不正です。");
      }
      return parsed.data.accountType;
    },
    async saveAccountType(budgetId: string, accountId: string, accountType: ActualAccountType | null): Promise<void> {
      const id = accountMetadataRecordId(budgetId, accountId);
      return withMetadataLock(`${repository.profileId}:${id}`, async () => {
        if (accountType === null) {
          await repository.delete(id);
          return;
        }
        const existing = await repository.get<unknown>(id);
        let statementProvider: StatementProvider | undefined;
        if (existing) {
          const parsed = accountMetadataSchema.safeParse(existing.value);
          if (existing.kind !== "account-metadata" || !parsed.success || parsed.data.budgetId !== budgetId || parsed.data.accountId !== accountId) {
            throw new Error("端末内の口座種類データが不正です。");
          }
          statementProvider = parsed.data.statementProvider;
        }
        const value = accountMetadataSchema.parse({ budgetId, accountId, accountType, ...(statementProvider ? { statementProvider } : {}) });
        await repository.put({
          id,
          kind: "account-metadata",
          value: value satisfies AccountMetadata,
          updatedAt: new Date().toISOString(),
        });
      });
    },
    async getStatementProvider(budgetId: string, accountId: string): Promise<StatementProvider | null> {
      const id = accountMetadataRecordId(budgetId, accountId);
      const record = await repository.get<unknown>(id);
      if (!record) return null;
      const parsed = accountMetadataSchema.safeParse(record.value);
      if (record.kind !== "account-metadata" || !parsed.success || parsed.data.budgetId !== budgetId || parsed.data.accountId !== accountId) {
        throw new Error("端末内の口座種類データが不正です。");
      }
      return parsed.data.statementProvider ?? null;
    },
    async saveStatementProvider(budgetId: string, accountId: string, statementProvider: StatementProvider | null, accountType: ActualAccountType): Promise<void> {
      const id = accountMetadataRecordId(budgetId, accountId);
      return withMetadataLock(`${repository.profileId}:${id}`, async () => {
        const existing = await repository.get<unknown>(id);
        let currentType = accountType;
        if (existing) {
          const parsed = accountMetadataSchema.safeParse(existing.value);
          if (existing.kind !== "account-metadata" || !parsed.success || parsed.data.budgetId !== budgetId || parsed.data.accountId !== accountId) {
            throw new Error("端末内の口座種類データが不正です。");
          }
          currentType = parsed.data.accountType;
        }
        if (currentType === "cash" && statementProvider !== null) throw new Error("現金口座には明細サービスを設定できません。");
        if (statementProvider === null && !existing) return;
        const value = accountMetadataSchema.parse({ budgetId, accountId, accountType: currentType,
          ...(statementProvider ? { statementProvider } : {}) });
        await repository.put({ id, kind: "account-metadata", value, updatedAt: new Date().toISOString() });
      });
    },
  };
}
