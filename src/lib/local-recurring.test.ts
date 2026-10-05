import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalDataRepository } from "./local-data";
import { LocalRecurringService } from "../../apps/pwa/src/local-recurring";
import { recurringOccurrenceDates, recurringCatchUpAuditSchema, scheduleAuditSchema } from "./recurring-schedule";
import type { NativeTransactionSnapshot, RecurringSchedule, RecurringScheduleInput } from "./actual-browser-ledger";
import type { ActualTransaction } from "./actual-ledger";

const input: RecurringScheduleInput = { name: "Synthetic Rent", kind: "expense", amountYen: 50000, categoryId: "rent", accountId: "bank", frequency: "monthly", startDate: "2026-10-01", postsTransaction: true };
const repositories: LocalDataRepository[] = [];
afterEach(() => { for (const repository of repositories.splice(0)) repository.close(); });
async function setup(now = "2026-10-04T12:00:00+09:00") {
  const repository = await LocalDataRepository.open(crypto.randomUUID()); repositories.push(repository);
  const schedules: RecurringSchedule[] = [];
  const transactions: ActualTransaction[] = [];
  const scheduledTransactions = new Set<string>();
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
    getSearchTransactions: vi.fn(async () => transactions.map(transaction => ({ transaction, recurringScheduleId: scheduledTransactions.has(transaction.id) ? "native-schedule" : null, categoryIds: [], keywordValues: [] }))),
    createTransaction: vi.fn(async (value: { kind: "expense" | "income"; amountYen: number; date: string; payeeName: string; categoryId: string; accountId: string; memo: string | null; importedId: string }) => {
      const existing = transactions.find(row => row.importedId === value.importedId);
      if (existing) return existing;
      const transaction: ActualTransaction = { id: `transaction-${transactions.length + 1}`, date: value.date, amountYen: value.kind === "expense" ? -value.amountYen : value.amountYen,
        kind: value.kind, payeeName: value.payeeName, categoryName: "Synthetic", accountId: value.accountId, categoryId: value.categoryId, memo: value.memo, importedId: value.importedId, cleared: false };
      transactions.push(transaction); return transaction;
    }),
    getTransactionTree: vi.fn(async (id: string) => {
      const row = transactions.find(transaction => transaction.id === id);
      if (!row) return [];
      return [{ id: row.id, date: row.date, amount: row.amountYen, account: row.accountId, payee: "synthetic-payee", category: row.categoryId, notes: row.memo, imported_id: row.importedId, schedule: null, cleared: row.cleared } as NativeTransactionSnapshot];
    }),
    deleteTransactionTree: vi.fn(async (snapshot: NativeTransactionSnapshot[]) => {
      const ids = new Set(snapshot.map(row => row.id));
      for (const saved of snapshot) {
        const current = transactions.find(row => row.id === saved.id);
        if (!current || current.date !== saved.date || current.amountYen !== saved.amount || current.importedId !== saved.imported_id) throw new Error("取引が変更されています。");
      }
      for (let index = transactions.length - 1; index >= 0; index -= 1) if (ids.has(transactions[index]!.id)) transactions.splice(index, 1);
    }),
  };
  const service = new LocalRecurringService(repository, ledger, action => action(), () => new Date(now));
  return { repository, schedules, transactions, scheduledTransactions, ledger, service };
}

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

  it("generates missing past occurrences idempotently and undoes only its own unchanged rows", async () => {
    const { service, ledger, transactions } = await setup();
    await service.save(input);
    const preview = await service.previewCatchUp(input, "native-schedule");
    expect(preview).toMatchObject({ dates: ["2026-10-01"], startDate: "2026-10-01", endDate: "2026-10-01", totalAmountYen: BigInt(50000) });
    const [operationId] = await service.catchUp("native-schedule", input, preview.dates);
    expect(transactions.map(row => row.importedId)).toEqual(preview.dates.map(date => `kakeimatch:schedule:native-schedule:${date}`));
    expect((await service.listCatchUps("native-schedule"))[0]?.audit.occurrences.map(row => row.status)).toEqual(["created"]);
    await service.undoCatchUp(operationId!);
    expect(transactions).toHaveLength(0);
    expect(await service.previewCatchUp(input, "native-schedule")).toMatchObject({ dates: [], totalAmountYen: BigInt(0) });
    expect(ledger.deleteTransactionTree).toHaveBeenCalledTimes(1);
  });

  it("accepts the native rule attaching the originating schedule to a new catch-up transaction", async () => {
    const { service, ledger, transactions } = await setup();
    await service.save(input);
    const readTree = ledger.getTransactionTree.getMockImplementation()!;
    ledger.getTransactionTree.mockImplementation(async id => (await readTree(id)).map(row => ({ ...row, schedule: "native-schedule" })));
    const [operationId] = await service.catchUp("native-schedule", input, ["2026-10-01"]);
    expect((await service.listCatchUps("native-schedule"))[0]?.audit.occurrences[0]?.snapshot?.[0]?.schedule).toBe("native-schedule");
    await service.undoCatchUp(operationId!);
    expect(transactions).toHaveLength(0);
    expect(await service.pending()).toBeNull();
  });

  it("recognizes native schedule rows by schedule identity even after the rule inputs change", async () => {
    const { service, ledger, transactions, scheduledTransactions } = await setup();
    transactions.push({ id: "actual-native-old-rule", date: "2026-10-01", amountYen: -12345, kind: "expense", payeeName: "Old Name", categoryName: "Synthetic", accountId: "old-account", cleared: false });
    scheduledTransactions.add("actual-native-old-rule");
    await service.save(input);
    const changed = { ...input, frequency: "weekly" as const, startDate: "2026-09-10", amountYen: 12345, name: "New Name", accountId: "changed-account" };
    await expect(service.previewCatchUp(changed, "native-schedule")).resolves.toMatchObject({ dates: ["2026-09-10", "2026-09-17", "2026-09-24"] });
    expect(ledger.getTransactionTree).not.toHaveBeenCalled();
  });

  it("does not mistake an independent matching transaction for a native schedule occurrence", async () => {
    const { service, transactions } = await setup();
    transactions.push({ id: "manual-lookalike", date: "2026-10-01", amountYen: -50000, kind: "expense", payeeName: input.name, categoryName: "Synthetic", accountId: input.accountId, cleared: false });
    await service.save(input);
    await expect(service.previewCatchUp(input, "native-schedule")).resolves.toMatchObject({ dates: ["2026-10-01"] });
  });

  it("does not re-create a stable catch-up ID whose transaction was moved to another date", async () => {
    const { service, transactions } = await setup();
    transactions.push({ id: "moved-catch-up", date: "2026-10-02", amountYen: -50000, kind: "expense", payeeName: input.name, categoryName: "Synthetic", accountId: input.accountId, cleared: false,
      importedId: "kakeimatch:schedule:native-schedule:2026-10-01" });
    await service.save(input);
    await expect(service.previewCatchUp(input, "native-schedule")).resolves.toMatchObject({ dates: [] });
  });

  it("recovers an unknown create result through its stable imported ID", async () => {
    const { service, ledger, transactions, repository } = await setup();
    await service.save(input);
    const create = ledger.createTransaction.getMockImplementation()!;
    ledger.createTransaction.mockImplementationOnce(async value => { await create(value); throw new Error("synthetic response loss after write"); });
    await expect(service.catchUp("native-schedule", input, ["2026-10-01"])).rejects.toThrow("response loss");
    expect(transactions).toHaveLength(1);
    await service.retry();
    expect(transactions).toHaveLength(1);
    expect(await service.pending()).toBeNull();
    expect((await repository.list("correction-audit")).map(row => (row.value as { status?: string }).status)).toContain("applied");
  });

  it.each([{ amountYen: -49999 }, { date: "2026-11-01" }, { payeeName: "Edited Payee" }, { memo: "Edited memo" }, { categoryId: "edited-category" }, { cleared: true }])(
    "recovers a lost result without overwriting or undoing an edited transaction: %j", async patch => {
      const { service, ledger, transactions } = await setup();
      await service.save(input);
      const create = ledger.createTransaction.getMockImplementation()!;
      ledger.createTransaction.mockImplementationOnce(async value => { await create(value); throw new Error("lost response after write"); });
      await expect(service.catchUp("native-schedule", input, ["2026-10-01"])).rejects.toThrow("lost response");
      Object.assign(transactions[0]!, patch);
      await service.retry();
      expect(await service.pending()).toBeNull();
      expect(transactions).toHaveLength(1);
      expect(transactions[0]).toMatchObject(patch);
      const history = (await service.listCatchUps("native-schedule"))[0]!;
      expect(history.audit).toMatchObject({ status: "applied", occurrences: [{ status: "retained" }] });
      await service.undoCatchUp(history.audit.operationId);
      expect(transactions).toHaveLength(1);
      expect(transactions[0]).toMatchObject(patch);
      expect((await service.previewCatchUp(input, "native-schedule")).dates).toEqual([]);
    },
  );

  it("retains an edited transaction during batch undo", async () => {
    const { service, transactions } = await setup();
    await service.save(input);
    const [operationId] = await service.catchUp("native-schedule", input, ["2026-10-01"]);
    transactions[0]!.amountYen -= 1;
    await service.undoCatchUp(operationId!);
    expect(transactions).toHaveLength(1);
    expect(await service.pending()).toBeNull();
    expect((await service.listCatchUps("native-schedule"))[0]?.audit).toMatchObject({ status: "undone", occurrences: [{ status: "retained" }] });
  });

  it("undoes unchanged rows and retains an edited row without leaving a pending operation", async () => {
    const { service, transactions } = await setup("2026-10-23T12:00:00+09:00");
    const weekly = { ...input, frequency: "weekly" as const };
    await service.save(weekly);
    const preview = await service.previewCatchUp(weekly, "native-schedule");
    expect(preview.dates).toEqual(["2026-10-01", "2026-10-08", "2026-10-15", "2026-10-22"]);
    const [operationId] = await service.catchUp("native-schedule", weekly, preview.dates);
    transactions.find(row => row.date === "2026-10-08")!.amountYen -= 1;
    await service.undoCatchUp(operationId!);
    expect(transactions.map(row => row.date)).toEqual(["2026-10-08"]);
    expect((await service.listCatchUps("native-schedule"))[0]?.audit.occurrences.map(row => row.status)).toEqual(["deleted", "retained", "deleted", "deleted"]);
    expect(await service.pending()).toBeNull();
  });

  it("completes selective deletion when an external edit happens after its preflight", async () => {
    const { service, ledger, transactions, repository } = await setup();
    await service.save(input);
    const [operationId] = await service.catchUp("native-schedule", input, ["2026-10-01"]);
    const nativeDelete = ledger.deleteTransactionTree.getMockImplementation()!;
    ledger.deleteTransactionTree.mockImplementationOnce(async snapshot => {
      transactions[0]!.amountYen -= 1;
      await nativeDelete(snapshot);
    });
    await service.deleteCatchUpOccurrences(operationId!, ["2026-10-01"]);
    expect(transactions).toHaveLength(1);
    expect(await service.pending()).toBeNull();
    expect((await service.listCatchUps("native-schedule"))[0]?.retainedDates.has("2026-10-01")).toBe(true);
    const deletion = (await repository.list("correction-audit")).map(row => row.value as { operation?: string; status?: string }).find(row => row.operation === "delete");
    expect(deletion).toMatchObject({ status: "applied" });
    await service.retry();
    expect(transactions).toHaveLength(1);
  });

  it("allows later bulk undo after selective deletion and keeps an edited occurrence", async () => {
    const { service, transactions } = await setup("2026-10-23T12:00:00+09:00");
    const weekly = { ...input, frequency: "weekly" as const };
    await service.save(weekly);
    const preview = await service.previewCatchUp(weekly, "native-schedule");
    const [operationId] = await service.catchUp("native-schedule", weekly, preview.dates);
    await service.deleteCatchUpOccurrences(operationId!, ["2026-10-01"]);
    transactions.find(row => row.date === "2026-10-08")!.amountYen -= 1;
    await service.undoCatchUp(operationId!);
    expect(transactions.map(row => row.date)).toEqual(["2026-10-08"]);
    expect((await service.listCatchUps("native-schedule"))[0]?.audit).toMatchObject({ status: "undone" });
    expect((await service.listCatchUps("native-schedule"))[0]?.deletedDates.has("2026-10-01")).toBe(true);
    expect((await service.listCatchUps("native-schedule"))[0]?.retainedDates.has("2026-10-08")).toBe(true);
    expect(await service.pending()).toBeNull();
  });

  it("validates portable pending intents including operation-specific fields", () => {
    const valid = { targetType: "schedule", operationId: "synthetic-operation", operation: "create", scheduleId: null, input, status: "pending", createdAt: "2026-10-01T00:00:00Z", appliedAt: null };
    expect(scheduleAuditSchema.safeParse(valid).success).toBe(true);
    expect(scheduleAuditSchema.safeParse({ ...valid, input: { ...input, amountYen: 1.5 } }).success).toBe(false);
    expect(scheduleAuditSchema.safeParse({ ...valid, operation: "delete", input: null }).success).toBe(false);
    expect(scheduleAuditSchema.safeParse({ ...valid, input: null }).success).toBe(false);
  });
});
