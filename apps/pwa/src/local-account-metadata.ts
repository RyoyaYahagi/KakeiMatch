import { z } from "zod";
import {
  accountMetadataRecordId,
  type ActualAccountType,
} from "../../../src/lib/actual-browser-ledger";
import type { LocalDataRepository } from "../../../src/lib/local-data";

type AccountMetadata = {
  budgetId: string;
  accountId: string;
  accountType: ActualAccountType;
};
const accountMetadataSchema = z.object({ budgetId: z.string().min(1).max(128), accountId: z.string().min(1).max(128), accountType: z.enum(["bank", "credit_card", "cash", "other"]) }).strict();

/** Adapts profile-local records to the browser ledger's budget-scoped account metadata hooks. */
export function createAccountMetadataAccess(repository: LocalDataRepository) {
  return {
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
      if (accountType === null) {
        await repository.delete(id);
        return;
      }
      const value = accountMetadataSchema.parse({ budgetId, accountId, accountType });
      await repository.put({
        id,
        kind: "account-metadata",
        value: value satisfies AccountMetadata,
        updatedAt: new Date().toISOString(),
      });
    },
  };
}
