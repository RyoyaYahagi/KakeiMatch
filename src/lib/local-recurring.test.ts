import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalDataRepository } from "./local-data";
import { LocalRecurringService } from "../../apps/pwa/src/local-recurring";
import { scheduleAuditSchema } from "./recurring-schedule";
import type { RecurringSchedule, RecurringScheduleInput } from "./actual-browser-ledger";

const input: RecurringScheduleInput = { name: "Synthetic Rent", kind: "expense", amountYen: 50000, categoryId: "rent", accountId: "bank", frequency: "monthly", startDate: "2026-10-01", postsTransaction: true };
const repositories: LocalDataRepository[] = [];
afterEach(() => { for (const repository of repositories.splice(0)) repository.close(); });
async function setup() {
  const repository = await LocalDataRepository.open(crypto.randomUUID()); repositories.push(repository);
  const schedules: RecurringSchedule[] = [];
  const ledger = {
    listCategories: vi.fn(async () => [{ id: "rent", name: "Synthetic Rent", isIncome: false, hidden: false, groupName: "Synthetic" }]),
    listAccounts: vi.fn(async () => [{ id: "bank", name: "Synthetic Bank", closed: false, accountType: "bank" as const }]),
    listRecurringSchedules: vi.fn(async () => schedules),
    createRecurringSchedule: vi.fn(async (value: RecurringScheduleInput) => {
      let schedule = schedules.find(row => row.name === value.name);
      if (!schedule) { schedule = { ...value, id: "native-schedule", nextDate: value.startDate, completed: false, editable: true }; schedules.push(schedule); }
      return schedule;
    }),
    updateRecurringSchedule: vi.fn(async (id: string, value: RecurringScheduleInput) => ({ ...value, id, nextDate: value.startDate, completed: false, editable: true })),
    deleteRecurringSchedule: vi.fn(async (id: string) => { const index = schedules.findIndex(row => row.id === id); if (index >= 0) schedules.splice(index, 1); }),
  };
  const service = new LocalRecurringService(repository, ledger, action => action());
  return { repository, schedules, ledger, service };
}

describe("durable recurring operations", () => {
  it("rejects a new duplicate name without persisting an intent or altering the existing schedule", async () => {
    const { service, ledger, repository } = await setup();
    await service.save(input);
    await expect(service.save({ ...input, amountYen: 60000 })).rejects.toThrow("同じ名前");
    expect(ledger.createRecurringSchedule).toHaveBeenCalledTimes(1);
    expect(await service.pending()).toBeNull();
    expect(await repository.list("correction-audit")).toHaveLength(1);
  });

  it("retains the original intent when native creation succeeds but local completion fails", async () => {
    const { service, repository, ledger, schedules } = await setup();
    const put = repository.put.bind(repository);
    let failCompletion = true;
    vi.spyOn(repository, "put").mockImplementation(async record => {
      if (failCompletion && (record.value as { status?: string }).status === "applied") { failCompletion = false; throw new Error("disk synthetic failure"); }
      await put(record);
    });
    await expect(service.save(input)).rejects.toThrow("disk");
    expect((await service.pending())?.input).toEqual(input);
    await expect(service.save({ ...input, name: "Another" })).rejects.toThrow("再試行");
    const reloaded = new LocalRecurringService(repository, ledger, action => action());
    await reloaded.retry();
    expect(schedules).toHaveLength(1);
    expect(ledger.createRecurringSchedule).toHaveBeenLastCalledWith(input);
    expect(await reloaded.pending()).toBeNull();
  });

  it("retries deletion after the native schedule has already disappeared", async () => {
    const { service, ledger, schedules } = await setup();
    await service.save(input);
    const nativeDelete = ledger.deleteRecurringSchedule.getMockImplementation()!;
    ledger.deleteRecurringSchedule.mockImplementationOnce(async id => { await nativeDelete(id); throw new Error("lost response"); });
    await expect(service.remove("native-schedule")).rejects.toThrow("lost response");
    expect(schedules).toHaveLength(0);
    await service.retry();
    expect(await service.pending()).toBeNull();
  });

  it("checks category kind and closed accounts before saving any operation", async () => {
    const { service, ledger, repository } = await setup();
    await expect(service.save({ ...input, kind: "income" })).rejects.toThrow("種類");
    ledger.listAccounts.mockResolvedValue([{ id: "bank", name: "Synthetic Bank", closed: true, accountType: "bank" }]);
    await expect(service.save(input)).rejects.toThrow("利用中");
    expect(await repository.list("correction-audit")).toHaveLength(0);
    expect(ledger.createRecurringSchedule).not.toHaveBeenCalled();
  });

  it("validates portable pending intents including operation-specific fields", () => {
    const valid = { targetType: "schedule", operationId: "synthetic-operation", operation: "create", scheduleId: null, input, status: "pending", createdAt: "2026-10-01T00:00:00Z", appliedAt: null };
    expect(scheduleAuditSchema.safeParse(valid).success).toBe(true);
    expect(scheduleAuditSchema.safeParse({ ...valid, input: { ...input, amountYen: 1.5 } }).success).toBe(false);
    expect(scheduleAuditSchema.safeParse({ ...valid, operation: "delete", input: null }).success).toBe(false);
    expect(scheduleAuditSchema.safeParse({ ...valid, input: null }).success).toBe(false);
  });
});
