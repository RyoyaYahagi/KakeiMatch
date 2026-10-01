import { z } from "zod";

/** Portable operation intent; schedule definitions remain in the native ledger. */
export const recurringScheduleInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  kind: z.enum(["expense", "income"]),
  amountYen: z.number().int().safe().positive(),
  categoryId: z.string().min(1).max(128),
  accountId: z.string().min(1).max(128),
  frequency: z.enum(["monthly", "weekly", "yearly"]),
  startDate: z.iso.date(),
  postsTransaction: z.boolean(),
}).strict();

export const scheduleAuditSchema = z.object({
  targetType: z.literal("schedule"),
  operationId: z.string().min(1),
  operation: z.enum(["create", "update", "delete"]),
  scheduleId: z.string().min(1).nullable(),
  input: recurringScheduleInputSchema.nullable(),
  status: z.enum(["pending", "applied"]),
  createdAt: z.string().datetime({ offset: true }),
  appliedAt: z.string().datetime({ offset: true }).nullable(),
}).strict().refine(value => value.operation === "create"
  ? value.input !== null
  : value.scheduleId !== null && (value.operation === "delete" ? value.input === null : value.input !== null));

export type ScheduleAudit = z.infer<typeof scheduleAuditSchema>;
