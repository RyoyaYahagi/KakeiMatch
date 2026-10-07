import { z } from "zod";
import { nativeTransactionSnapshotSchema } from "./actual-browser-ledger";

export const moneyForwardRowSchema = z.object({
  rowNumber: z.number().int().min(2).max(5 * 1024 * 1024),
  date: z.iso.date(),
  description: z.string().min(1).max(2000),
  amountYen: z.number().int().safe().refine(value => value !== 0),
  kind: z.enum(["expense", "income"]),
  accountName: z.string().max(2000).nullable(),
  majorCategory: z.string().max(2000),
  minorCategory: z.string().max(2000),
  memo: z.string().max(2000),
  sourceTransactionId: z.string().max(2000).nullable(),
  sourceKey: z.string().regex(/^[0-9a-f]{64}$/),
  isTransfer: z.boolean(),
  isIncludedInCalculation: z.boolean(),
  categoryNeedsReviewReason: z.string().max(2000).nullable(),
}).strict().refine(row => row.kind === (row.amountYen < 0 ? "expense" : "income"));

export const moneyForwardCategoryChoiceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("existing"), categoryId: z.string().min(1).max(128) }).strict(),
  z.object({ kind: z.literal("new"), name: z.string().trim().min(1).max(100) }).strict(),
  z.object({ kind: z.literal("unclassified") }).strict(),
  z.object({ kind: z.literal("exclude") }).strict(),
  z.object({ kind: z.literal("unresolved") }).strict(),
]);
export const moneyForwardAccountChoiceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("existing"), accountId: z.string().min(1).max(128) }).strict(),
  z.object({ kind: z.literal("new"), name: z.string().trim().min(1).max(100) }).strict(),
  z.object({ kind: z.literal("unset") }).strict(),
]);
const moneyForwardRulesSchema = z.object({
  categories: z.record(z.string().max(4096), moneyForwardCategoryChoiceSchema),
  accounts: z.record(z.string().max(2000), moneyForwardAccountChoiceSchema),
}).strict();
const moneyForwardBatchSchema = z.object({
  id: z.string().min(1).max(128),
  budgetId: z.string().min(1).max(128),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  status: z.enum(["planned", "processing", "completed", "partial", "undoing", "undone", "undo-partial"]),
  mappings: moneyForwardRulesSchema,
  rows: z.array(z.object({
    row: moneyForwardRowSchema,
    importedId: z.string().min(1).max(200),
    status: z.enum(["pending", "importing", "created", "duplicate", "excluded", "failed", "undoing", "undone"]),
    transactionSnapshot: z.array(nativeTransactionSnapshotSchema).max(102).nullable(),
    error: z.string().max(2000).nullable(),
  }).strict()).max(20_000),
}).strict();

export const moneyForwardImportSettingsSchema = z.object({
  version: z.literal(1),
  rules: moneyForwardRulesSchema,
  batches: z.array(moneyForwardBatchSchema).max(100),
}).strict();

export function rebindMoneyForwardImportSettings(value: unknown, budgetId: string): unknown {
  const parsed = moneyForwardImportSettingsSchema.safeParse(value);
  if (!parsed.success) throw new Error("Money Forwardの移行履歴を復元できません。");
  return {
    ...parsed.data,
    batches: parsed.data.batches.map(batch => ({ ...batch, budgetId })),
  };
}
