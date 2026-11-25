import { describe, expect, it } from "vitest";
import { recurringOccurrenceDates, recurringCatchUpAuditSchema, scheduleAuditSchema } from "./recurring-schedule";
import type { RecurringScheduleInput } from "./actual-browser-ledger";

const input: RecurringScheduleInput = { name: "Synthetic Rent", kind: "expense", amountYen: 50000, categoryId: "rent", accountId: "bank", frequency: "monthly", startDate: "2026-10-01", postsTransaction: true };
describe("durable recurring operations", () => {
  it("uses Actual calendar recurrence semantics for month ends and leap days", () => {
    expect(recurringOccurrenceDates({ frequency: "monthly", startDate: "2026-01-31" }, "2026-05-31"))
      .toEqual(["2026-01-31", "2026-03-31", "2026-05-31"]);
    expect(recurringOccurrenceDates({ frequency: "yearly", startDate: "2024-02-29" }, "2032-03-01"))
      .toEqual(["2024-02-29", "2028-02-29", "2032-02-29"]);
    expect(recurringOccurrenceDates({ frequency: "monthly", startDate: "0099-01-31" }, "0100-03-31"))
      .toEqual(["0099-01-31", "0099-03-31", "0099-05-31", "0099-07-31", "0099-08-31", "0099-10-31", "0099-12-31", "0100-01-31", "0100-03-31"]);
    expect(recurringOccurrenceDates({ frequency: "weekly", startDate: "2026-10-02" }, "2026-10-23"))
      .toEqual(["2026-10-02", "2026-10-09", "2026-10-16", "2026-10-23"]);
    expect(recurringOccurrenceDates({ frequency: "weekly", startDate: "1900-01-06" }, "2026-10-01")).toHaveLength(6613);
  });

  it("strictly validates catch-up audit state while retaining prior schedule audit shapes", () => {
    const audit = { targetType: "recurring-catch-up", operationId: "synthetic-catch-up", operation: "create", scheduleId: "native-schedule", input,
      occurrences: [{ date: "2026-10-01", importedId: "kakeimatch:schedule:native-schedule:2026-10-01", transactionId: null, snapshot: null, status: "pending" }],
      selectedDates: null, status: "pending", createdAt: "2026-10-01T00:00:00Z", appliedAt: null };
    expect(recurringCatchUpAuditSchema.safeParse(audit).success).toBe(true);
    expect(recurringCatchUpAuditSchema.safeParse({ ...audit, futureField: "secret" }).success).toBe(false);
    expect(scheduleAuditSchema.safeParse({ targetType: "schedule", operationId: "synthetic-operation", operation: "create", scheduleId: "native-schedule", input,
      status: "applied", createdAt: "2026-10-01T00:00:00Z", appliedAt: "2026-10-01T00:00:00Z" }).success).toBe(true);
  });

  it("validates portable pending intents including operation-specific fields", () => {
    const valid = { targetType: "schedule", operationId: "synthetic-operation", operation: "create", scheduleId: null, input, status: "pending", createdAt: "2026-10-01T00:00:00Z", appliedAt: null };
    expect(scheduleAuditSchema.safeParse(valid).success).toBe(true);
    expect(scheduleAuditSchema.safeParse({ ...valid, input: { ...input, amountYen: 1.5 } }).success).toBe(false);
    expect(scheduleAuditSchema.safeParse({ ...valid, operation: "delete", input: null }).success).toBe(false);
    expect(scheduleAuditSchema.safeParse({ ...valid, input: null }).success).toBe(false);
  });
});
