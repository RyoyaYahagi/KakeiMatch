import { z } from "zod";
import { nativeTransactionSnapshotSchema } from "./actual-browser-ledger";

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
export type RecurringScheduleInput = z.infer<typeof recurringScheduleInputSchema>;

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

const catchUpOccurrenceSchema = z.object({
  date: z.iso.date(),
  importedId: z.string().min(1).max(200),
  transactionId: z.string().min(1).nullable(),
  snapshot: z.array(nativeTransactionSnapshotSchema).min(1).nullable(),
  status: z.enum(["pending", "created", "deleted", "retained"]),
}).strict().refine(row => row.status === "pending"
  ? row.transactionId === null && row.snapshot === null
  : row.status === "created" || row.status === "retained" ? row.transactionId !== null && row.snapshot !== null
    : row.transactionId !== null && row.snapshot !== null);

/** Durable per-occurrence state for idempotent catch-up, undo, and later deletion. */
export const recurringCatchUpAuditSchema = z.object({
  targetType: z.literal("recurring-catch-up"),
  operationId: z.string().min(1),
  operation: z.enum(["create", "delete"]),
  scheduleId: z.string().min(1),
  input: recurringScheduleInputSchema,
  occurrences: z.array(catchUpOccurrenceSchema).min(1).max(5000),
  selectedDates: z.array(z.iso.date()).max(5000).nullable(),
  status: z.enum(["pending", "applied", "undoing", "undone"]),
  createdAt: z.string().datetime({ offset: true }),
  appliedAt: z.string().datetime({ offset: true }).nullable(),
}).strict().superRefine((value, context) => {
  const dates = value.occurrences.map(row => row.date);
  const importedIds = value.occurrences.map(row => row.importedId);
  if (new Set(dates).size !== dates.length || new Set(importedIds).size !== importedIds.length) {
    context.addIssue({ code: "custom", message: "定期登録の対象日または識別子が重複しています。" });
  }
  if (value.occurrences.some(row => row.importedId !== `kakeimatch:schedule:${value.scheduleId}:${row.date}`)) {
    context.addIssue({ code: "custom", message: "定期登録の対象日と識別子が一致しません。" });
  }
  if (value.occurrences.some(row => row.snapshot && (row.snapshot[0]?.id !== row.transactionId || row.snapshot[0]?.imported_id !== row.importedId))) {
    context.addIssue({ code: "custom", message: "定期登録の監査記録と取引内容が一致しません。" });
  }
  if (value.operation === "create") {
    if (value.selectedDates !== null) context.addIssue({ code: "custom", message: "生成記録に削除対象日は指定できません。" });
    if (value.status === "pending" && value.occurrences.some(row => row.status === "deleted" || row.status === "retained")) context.addIssue({ code: "custom", message: "生成中の記録に取り消し済みの行があります。" });
    if (value.status === "applied" && value.occurrences.some(row => row.status !== "created")) context.addIssue({ code: "custom", message: "完了した生成記録に未処理の行があります。" });
    if (value.status === "undoing" && value.occurrences.some(row => row.status === "pending")) context.addIssue({ code: "custom", message: "取り消し中の記録に未生成の行があります。" });
    if (value.status === "undone" && value.occurrences.some(row => row.status !== "deleted" && row.status !== "retained")) context.addIssue({ code: "custom", message: "取り消し済みの生成記録に未処理の行があります。" });
  } else {
    const selected = value.selectedDates ?? [];
    if (!selected.length || new Set(selected).size !== selected.length || selected.length !== dates.length || selected.some(date => !dates.includes(date))) {
      context.addIssue({ code: "custom", message: "定期登録の削除対象が不正です。" });
    }
    if (value.status === "undoing" || value.status === "undone" || value.occurrences.some(row => row.status === "pending") ||
      value.status === "applied" && value.occurrences.some(row => row.status !== "deleted" && row.status !== "retained")) {
      context.addIssue({ code: "custom", message: "削除記録の状態が不正です。" });
    }
  }
});

export type RecurringCatchUpAudit = z.infer<typeof recurringCatchUpAuditSchema>;

/** Generate the simple date rules exposed by this app using calendar dates, never local-time arithmetic. */
export function recurringOccurrenceDates(input: Pick<RecurringScheduleInput, "frequency" | "startDate">, throughDate: string): string[] {
  const start = new Date(`${input.startDate}T00:00:00.000Z`);
  const through = new Date(`${throughDate}T00:00:00.000Z`);
  if (Number.isNaN(start.valueOf()) || Number.isNaN(through.valueOf()) || through < start) return [];
  const dates: string[] = [];
  const append = (date: Date) => {
    if (date > through) return false;
    dates.push(date.toISOString().slice(0, 10));
    return true;
  };
  if (input.frequency === "weekly") {
    for (let date = new Date(start); append(date); date.setUTCDate(date.getUTCDate() + 7)) { /* calendar interval */ }
  } else if (input.frequency === "monthly") {
    const day = start.getUTCDate();
    for (let year = start.getUTCFullYear(), month = start.getUTCMonth(); ; month += 1) {
      const currentYear = year + Math.floor(month / 12);
      const currentMonth = month % 12;
      const candidate = new Date(0);
      candidate.setUTCHours(0, 0, 0, 0);
      candidate.setUTCFullYear(currentYear, currentMonth, day);
      if (candidate.getUTCMonth() === currentMonth && candidate.getUTCDate() === day && candidate >= start && !append(candidate)) break;
      if (candidate > through) break;
    }
  } else {
    const month = start.getUTCMonth(), day = start.getUTCDate();
    for (let year = start.getUTCFullYear(); ; year += 1) {
      const candidate = new Date(0);
      candidate.setUTCHours(0, 0, 0, 0);
      candidate.setUTCFullYear(year, month, day);
      if (candidate.getUTCMonth() === month && candidate.getUTCDate() === day && candidate >= start && !append(candidate)) break;
      if (candidate > through) break;
    }
  }
  return dates;
}
