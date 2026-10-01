import type { createActualBrowserLedger, RecurringScheduleInput } from "../../../src/lib/actual-browser-ledger";
import type { LocalDataRepository } from "../../../src/lib/local-data";
import { recurringScheduleInputSchema, type ScheduleAudit } from "../../../src/lib/recurring-schedule";
export type { ScheduleAudit } from "../../../src/lib/recurring-schedule";

type Ledger = Pick<ReturnType<typeof createActualBrowserLedger>, "listRecurringSchedules" | "createRecurringSchedule" | "updateRecurringSchedule" | "deleteRecurringSchedule" | "listCategories" | "listAccounts">;

/** Save immutable intent before native effects so reloads can safely finish partial saves. */
export class LocalRecurringService {
  constructor(private readonly repository: LocalDataRepository, private readonly ledger: Ledger,
    private readonly withLock: <T>(action: () => Promise<T>) => Promise<T> = <T>(action: () => Promise<T>) => {
      if (typeof navigator === "undefined" || !navigator.locks) throw new Error("このブラウザーでは安全に定期登録を保存できません。");
      return navigator.locks.request(`kakeimatch-schedules:${repository.profileId}`, { mode: "exclusive" }, action) as unknown as Promise<T>;
    }) {}

  async pending(): Promise<ScheduleAudit | null> {
    const rows = await this.repository.list<ScheduleAudit>("correction-audit");
    return rows.map(row => row.value).find(row => row.targetType === "schedule" && row.status === "pending") ?? null;
  }

  save(input: RecurringScheduleInput, id?: string): Promise<void> {
    return this.withLock(async () => {
      await this.assertNoPending();
      const parsed = recurringScheduleInputSchema.safeParse(input);
      if (!parsed.success) throw new Error("名前・金額・日付・カテゴリ・口座を確認してください。");
      const value = parsed.data;
      const [categories, accounts, schedules] = await Promise.all([this.ledger.listCategories(), this.ledger.listAccounts(), this.ledger.listRecurringSchedules()]);
      if (!categories.some(category => category.id === value.categoryId && !category.hidden && category.isIncome === (value.kind === "income"))) throw new Error("種類に合う利用中のカテゴリを選んでください。");
      if (!accounts.some(account => account.id === value.accountId && !account.closed)) throw new Error("利用中の口座を選んでください。");
      if (schedules.some(schedule => schedule.id !== id && schedule.name.trim() === value.name)) throw new Error("同じ名前の定期登録があります。既存の定期登録を編集してください。");
      if (id && !schedules.some(schedule => schedule.id === id && schedule.editable)) throw new Error("この定期登録は編集できません。");
      const audit: ScheduleAudit = { targetType: "schedule", operationId: crypto.randomUUID(), operation: id ? "update" : "create", scheduleId: id ?? null, input: value, status: "pending", createdAt: new Date().toISOString(), appliedAt: null };
      await this.persist(audit);
      await this.finish(audit);
    });
  }

  remove(id: string): Promise<void> {
    return this.withLock(async () => {
      await this.assertNoPending();
      if (!(await this.ledger.listRecurringSchedules()).some(schedule => schedule.id === id)) throw new Error("定期登録が見つかりません。");
      const audit: ScheduleAudit = { targetType: "schedule", operationId: crypto.randomUUID(), operation: "delete", scheduleId: id, input: null, status: "pending", createdAt: new Date().toISOString(), appliedAt: null };
      await this.persist(audit);
      await this.finish(audit);
    });
  }

  retry(): Promise<void> {
    return this.withLock(async () => { const audit = await this.pending(); if (audit) await this.finish(audit); });
  }

  private async assertNoPending() {
    if (await this.pending()) throw new Error("保存結果を確認中の定期登録があります。先に再試行してください。");
  }
  private async finish(audit: ScheduleAudit) {
    let scheduleId = audit.scheduleId;
    if (audit.operation === "delete") await this.ledger.deleteRecurringSchedule(scheduleId!);
    else if (audit.operation === "update") scheduleId = (await this.ledger.updateRecurringSchedule(scheduleId!, audit.input!)).id;
    else scheduleId = (await this.ledger.createRecurringSchedule(audit.input!)).id;
    await this.persist({ ...audit, scheduleId, status: "applied", appliedAt: new Date().toISOString() });
  }
  private persist(audit: ScheduleAudit) {
    return this.repository.put({ id: `schedule-operation:${audit.operationId}`, kind: "correction-audit", value: audit, updatedAt: audit.appliedAt ?? audit.createdAt });
  }
}
