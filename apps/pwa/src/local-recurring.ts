import type { createActualBrowserLedger, NativeTransactionSnapshot, RecurringScheduleInput } from "../../../src/lib/actual-browser-ledger";
import type { LocalDataRepository } from "../../../src/lib/local-data";
import { recurringCatchUpAuditSchema, recurringOccurrenceDates, recurringScheduleInputSchema, type RecurringCatchUpAudit, type ScheduleAudit } from "../../../src/lib/recurring-schedule";
export type { RecurringCatchUpAudit, ScheduleAudit } from "../../../src/lib/recurring-schedule";

type Ledger = Pick<ReturnType<typeof createActualBrowserLedger>, "listRecurringSchedules" | "createRecurringSchedule" | "updateRecurringSchedule" | "deleteRecurringSchedule" | "listCategories" | "listAccounts" | "getSearchTransactions" | "getTransactionTree" | "createTransaction" | "deleteTransactionTree">;
const MAX_BATCH_OCCURRENCES = 5000;
const operationRecordId = (operationId: string) => `recurring-catch-up:${operationId}`;
const deletionRecordId = (operationId: string) => `recurring-catch-up-delete:${operationId}`;

export type RecurringCatchUpPreview = { dates: string[]; startDate: string | null; endDate: string | null; totalAmountYen: bigint };
export type RecurringCatchUpHistory = { audit: RecurringCatchUpAudit; deletedDates: Set<string>; retainedDates: Set<string> };

/** Schedule intents and every generated occurrence share one profile-scoped write lock. */
export class LocalRecurringService {
  constructor(private readonly repository: LocalDataRepository, private readonly ledger: Ledger,
    private readonly withLock: <T>(action: () => Promise<T>) => Promise<T> = <T>(action: () => Promise<T>) => {
      if (typeof navigator === "undefined" || !navigator.locks) throw new Error("このブラウザーでは安全に定期登録を保存できません。");
      return navigator.locks.request(`kakeimatch-schedules:${repository.profileId}`, { mode: "exclusive" }, action) as unknown as Promise<T>;
    }, private readonly now: () => Date = () => new Date()) {}

  async pending(): Promise<ScheduleAudit | RecurringCatchUpAudit | null> {
    const rows = await this.repository.list<ScheduleAudit | RecurringCatchUpAudit>("correction-audit");
    return rows.map(row => row.value).find(row => row.targetType === "schedule" && row.status === "pending" ||
      row.targetType === "recurring-catch-up" && (row.status === "pending" || row.status === "undoing")) ?? null;
  }

  save(input: RecurringScheduleInput, id?: string): Promise<string> {
    return this.withLock(async () => {
      await this.assertNoPending();
      const value = this.validateInput(input);
      const schedules = await this.validateMastersAndUniqueness(value, id);
      if (id && !schedules.some(schedule => schedule.id === id && schedule.editable)) throw new Error("この定期登録は編集できません。");
      const audit: ScheduleAudit = { targetType: "schedule", operationId: crypto.randomUUID(), operation: id ? "update" : "create", scheduleId: id ?? null, input: value, status: "pending", createdAt: this.timestamp(), appliedAt: null };
      await this.persistSchedule(audit);
      return this.finishSchedule(audit);
    });
  }

  remove(id: string): Promise<void> {
    return this.withLock(async () => {
      await this.assertNoPending();
      if (!(await this.ledger.listRecurringSchedules()).some(schedule => schedule.id === id)) throw new Error("定期登録が見つかりません。");
      const audit: ScheduleAudit = { targetType: "schedule", operationId: crypto.randomUUID(), operation: "delete", scheduleId: id, input: null, status: "pending", createdAt: this.timestamp(), appliedAt: null };
      await this.persistSchedule(audit);
      await this.finishSchedule(audit);
    });
  }

  /** Read all expected dates so the UI can report the full range/count before chunked writes. */
  async previewCatchUp(input: RecurringScheduleInput, scheduleId?: string): Promise<RecurringCatchUpPreview> {
    const parsed = this.validateInput(input);
    const through = this.today();
    const candidates = recurringOccurrenceDates(parsed, through);
    const missing = await this.findMissingOccurrences(parsed, scheduleId, candidates);
    return { dates: missing, startDate: missing[0] ?? null, endDate: missing.at(-1) ?? null,
      totalAmountYen: BigInt(parsed.amountYen) * BigInt(missing.length) };
  }

  /** Each <=5,000-row chunk has its own durable intent and stable per-date imported IDs. */
  catchUp(scheduleId: string, input: RecurringScheduleInput, dates: string[]): Promise<string[]> {
    return this.withLock(async () => {
      await this.assertNoPending();
      const parsed = this.validateInput(input);
      const schedule = (await this.ledger.listRecurringSchedules()).find(item => item.id === scheduleId);
      if (!schedule) throw new Error("定期登録が見つかりません。");
      if (!sameSchedule(schedule, parsed)) throw new Error("定期登録が別の画面で変更されました。画面を更新してから確認し直してください。");
      const allowed = new Set(recurringOccurrenceDates(parsed, this.today()));
      if (dates.some(date => !allowed.has(date)) || new Set(dates).size !== dates.length) throw new Error("定期登録の対象日が変わりました。画面を更新してください。");
      const missing = await this.findMissingOccurrences(parsed, scheduleId, dates);
      const ids: string[] = [];
      for (let offset = 0; offset < missing.length; offset += MAX_BATCH_OCCURRENCES) {
        const chunk = missing.slice(offset, offset + MAX_BATCH_OCCURRENCES);
        const operationId = crypto.randomUUID();
        const audit: RecurringCatchUpAudit = { targetType: "recurring-catch-up", operationId, operation: "create", scheduleId, input: parsed,
          occurrences: chunk.map(date => ({ date, importedId: `kakeimatch:schedule:${scheduleId}:${date}`, transactionId: null, snapshot: null, status: "pending" })),
          selectedDates: null, status: "pending", createdAt: this.timestamp(), appliedAt: null };
        await this.persistCatchUp(audit);
        await this.finishCatchUp(audit);
        ids.push(operationId);
      }
      return ids;
    });
  }

  async listCatchUps(scheduleId: string): Promise<RecurringCatchUpHistory[]> {
    const rows = await this.repository.list<RecurringCatchUpAudit>("correction-audit");
    const audits = rows.map(row => row.value).filter(row => row.targetType === "recurring-catch-up" && row.scheduleId === scheduleId);
    const deletedDates = new Set(audits.flatMap(row => row.occurrences.filter(item => item.status === "deleted").map(item => item.date)));
    const retainedDates = new Set(audits.flatMap(row => row.occurrences.filter(item => item.status === "retained").map(item => item.date)));
    return audits.filter(row => row.operation === "create").map(audit => ({ audit, deletedDates, retainedDates }))
      .sort((a, b) => b.audit.createdAt.localeCompare(a.audit.createdAt));
  }

  undoCatchUp(operationId: string): Promise<void> {
    return this.withLock(async () => {
      await this.assertNoPending();
      const audit = await this.getCatchUp(operationId);
      if (audit.operation !== "create" || audit.status !== "applied") throw new Error("取り消せる生成履歴が見つかりません。");
      const deletedDates = new Set((await this.repository.list<RecurringCatchUpAudit>("correction-audit")).map(row => row.value)
        .filter(row => row.targetType === "recurring-catch-up" && row.scheduleId === audit.scheduleId && row.operation === "delete")
        .flatMap(row => row.occurrences.filter(item => item.status === "deleted").map(item => item.date)));
      const occurrences = [] as RecurringCatchUpAudit["occurrences"];
      for (const row of audit.occurrences) {
        if (row.status !== "created" || !row.snapshot || !row.transactionId) { occurrences.push(row); continue; }
        if (deletedDates.has(row.date)) { occurrences.push({ ...row, status: "deleted" as const }); continue; }
        const current = await this.ledger.getTransactionTree(row.transactionId);
        if (!current.length) occurrences.push({ ...row, status: "deleted" as const });
        else if (sameSnapshot(current, row.snapshot)) occurrences.push(row);
        else occurrences.push({ ...row, status: "retained" as const, snapshot: current });
      }
      const undoing = { ...audit, occurrences, status: "undoing" as const };
      await this.persistCatchUp(undoing);
      await this.finishCatchUp(undoing);
    });
  }

  deleteCatchUpOccurrences(operationId: string, dates: string[]): Promise<void> {
    return this.withLock(async () => {
      await this.assertNoPending();
      const source = await this.getCatchUp(operationId);
      if (source.operation !== "create" || source.status !== "applied" || !dates.length || new Set(dates).size !== dates.length) throw new Error("削除する生成履歴を確認してください。");
      const alreadyHandled = new Set((await this.repository.list<RecurringCatchUpAudit>("correction-audit")).map(row => row.value)
        .filter(row => row.targetType === "recurring-catch-up" && row.scheduleId === source.scheduleId)
        .flatMap(row => row.occurrences.filter(item => item.status === "deleted" || item.status === "retained").map(item => item.date)));
      if (dates.some(date => alreadyHandled.has(date))) throw new Error("削除対象の取引はすでに削除済みか、編集後に保持されています。");
      const selected = source.occurrences.filter(row => dates.includes(row.date) && row.status === "created");
      if (selected.length !== dates.length) throw new Error("削除対象の取引が見つからないか、すでに変更されています。");
      await this.assertSnapshotsUnchanged(selected.map(row => row.snapshot!));
      const audit: RecurringCatchUpAudit = { targetType: "recurring-catch-up", operationId: crypto.randomUUID(), operation: "delete", scheduleId: source.scheduleId,
        input: source.input, occurrences: selected.map(row => ({ ...row })), selectedDates: [...dates], status: "pending", createdAt: this.timestamp(), appliedAt: null };
      await this.persistCatchUp(audit);
      await this.finishCatchUp(audit);
    });
  }

  retry(): Promise<void> {
    return this.withLock(async () => {
      const pending = await this.pending();
      if (!pending) return;
      if (pending.targetType === "schedule") await this.finishSchedule(pending);
      else await this.finishCatchUp(pending);
    });
  }

  private validateInput(input: RecurringScheduleInput): RecurringScheduleInput {
    const parsed = recurringScheduleInputSchema.safeParse(input);
    if (!parsed.success) throw new Error("名前・金額・日付・カテゴリ・口座を確認してください。");
    return parsed.data;
  }
  private async validateMastersAndUniqueness(value: RecurringScheduleInput, id?: string) {
    const [categories, accounts, schedules] = await Promise.all([this.ledger.listCategories(), this.ledger.listAccounts(), this.ledger.listRecurringSchedules()]);
    if (!categories.some(category => category.id === value.categoryId && !category.hidden && category.isIncome === (value.kind === "income"))) throw new Error("種類に合う利用中のカテゴリを選んでください。");
    if (!accounts.some(account => account.id === value.accountId && !account.closed)) throw new Error("利用中の口座を選んでください。");
    if (schedules.some(schedule => schedule.id !== id && schedule.name.trim() === value.name)) throw new Error("同じ名前の定期登録があります。既存の定期登録を編集してください。");
    return schedules;
  }
  private today(): string { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(this.now()); }
  private timestamp(): string { return this.now().toISOString(); }
  private async assertNoPending() {
    if (await this.pending()) throw new Error("保存結果を確認中の定期登録があります。先に再試行してください。");
  }
  private async finishSchedule(audit: ScheduleAudit): Promise<string> {
    let scheduleId = audit.scheduleId;
    if (audit.operation === "delete") await this.ledger.deleteRecurringSchedule(scheduleId!);
    else if (audit.operation === "update") scheduleId = (await this.ledger.updateRecurringSchedule(scheduleId!, audit.input!)).id;
    else scheduleId = (await this.ledger.createRecurringSchedule(audit.input!)).id;
    await this.persistSchedule({ ...audit, scheduleId, status: "applied", appliedAt: this.timestamp() });
    return scheduleId!;
  }
  private async finishCatchUp(audit: RecurringCatchUpAudit) {
    let current = audit;
    if (audit.operation === "create" && audit.status !== "undoing") {
      for (let index = 0; index < current.occurrences.length; index += 1) {
        const occurrence = current.occurrences[index]!;
        if (occurrence.status !== "pending") continue;
        const transaction = await this.ledger.createTransaction({ kind: current.input.kind, amountYen: current.input.amountYen, date: occurrence.date,
          payeeName: current.input.name, categoryId: current.input.categoryId, accountId: current.input.accountId, memo: null, importedId: occurrence.importedId });
        const snapshot = await this.ledger.getTransactionTree(transaction.id);
        if (!snapshot.length || !matchesGeneratedSnapshot(snapshot, current, occurrence.date)) throw new Error("生成した定期取引を確認できません。保留中の処理から再試行してください。");
        const occurrences = current.occurrences.map(row => row.date === occurrence.date ? { ...row, transactionId: snapshot[0]!.id, snapshot, status: "created" as const } : row);
        current = { ...current, occurrences };
        await this.persistCatchUp(current);
      }
      current = { ...current, status: "applied", appliedAt: this.timestamp() };
      await this.persistCatchUp(current);
      return;
    }
    for (let index = 0; index < current.occurrences.length; index += 1) {
      const occurrence = current.occurrences[index]!;
      if (occurrence.status !== "created" || !occurrence.snapshot) continue;
      let status: "deleted" | "retained" = "deleted";
      let snapshot = occurrence.snapshot;
      try { await this.ledger.deleteTransactionTree(occurrence.snapshot); }
      catch (error) {
        const stillExists = (await this.ledger.getSearchTransactions()).some(row => row.transaction.id === occurrence.transactionId);
        if (!stillExists) status = "deleted";
        else {
          const latest = await this.ledger.getTransactionTree(occurrence.transactionId!);
          if (!sameSnapshot(latest, occurrence.snapshot)) { status = "retained"; snapshot = latest; }
          else throw error;
        }
      }
      const occurrences = current.occurrences.map(row => row.date === occurrence.date ? { ...row, snapshot, status } : row);
      current = { ...current, occurrences };
      await this.persistCatchUp(current);
    }
    const finalStatus = current.operation === "create" ? "undone" : "applied";
    await this.persistCatchUp({ ...current, status: finalStatus, appliedAt: this.timestamp() });
  }
  private async findMissingOccurrences(input: RecurringScheduleInput, scheduleId: string | undefined, dates: string[]): Promise<string[]> {
    if (!dates.length) return [];
    const rows = await this.repository.list<RecurringCatchUpAudit>("correction-audit");
    const consumedDates = new Set(rows.map(row => row.value).filter((value): value is RecurringCatchUpAudit =>
      value?.targetType === "recurring-catch-up" && value.operation === "create" && value.scheduleId === scheduleId)
      .flatMap(audit => audit.occurrences.map(row => row.date)));
    const actual = await this.ledger.getSearchTransactions();
    const byImportedId = new Map(actual.map(row => [row.transaction.importedId, row.transaction]));
    const startDate = dates.reduce((min, value) => value < min ? value : min);
    const endDate = dates.reduce((max, value) => value > max ? value : max);
    const candidates = await this.ledger.getSearchTransactions({ startDate, endDate });
    const byDate = new Map<string, typeof candidates>();
    for (const row of candidates) {
      const rowsForDate = byDate.get(row.transaction.date);
      if (rowsForDate) rowsForDate.push(row);
      else byDate.set(row.transaction.date, [row]);
    }
    const missing: string[] = [];
    for (const date of dates) {
      const importedId = scheduleId ? `kakeimatch:schedule:${scheduleId}:${date}` : null;
      if (consumedDates.has(date) || importedId && byImportedId.has(importedId)) continue;
      const nativeExists = Boolean(scheduleId && (byDate.get(date) ?? []).some(row => row.recurringScheduleId === scheduleId));
      if (!nativeExists) missing.push(date);
    }
    return missing;
  }
  private async getCatchUp(operationId: string): Promise<RecurringCatchUpAudit> {
    const record = await this.repository.get<RecurringCatchUpAudit>(operationRecordId(operationId)) ?? await this.repository.get<RecurringCatchUpAudit>(deletionRecordId(operationId));
    if (!record || record.value.targetType !== "recurring-catch-up") throw new Error("定期登録の生成履歴が見つかりません。");
    return recurringCatchUpAuditSchema.parse(record.value);
  }
  private async assertSnapshotsUnchanged(snapshots: NativeTransactionSnapshot[][]) {
    for (const expected of snapshots) {
      const current = await this.ledger.getTransactionTree(expected[0]!.id);
      if (!sameSnapshot(current, expected)) throw new Error("一部の取引が編集されています。編集済みの取引を残すため、未編集分を選び直してください。");
    }
  }
  private async persistSchedule(audit: ScheduleAudit) {
    await this.repository.put({ id: `schedule-operation:${audit.operationId}`, kind: "correction-audit", value: audit, updatedAt: audit.appliedAt ?? audit.createdAt });
  }
  private async persistCatchUp(audit: RecurringCatchUpAudit) {
    const id = audit.operation === "delete" ? deletionRecordId(audit.operationId) : operationRecordId(audit.operationId);
    await this.repository.put({ id, kind: "correction-audit", value: recurringCatchUpAuditSchema.parse(audit), updatedAt: audit.appliedAt ?? audit.createdAt });
  }
}

function matchesGeneratedSnapshot(snapshot: NativeTransactionSnapshot[], audit: RecurringCatchUpAudit, date: string): boolean {
  const root = snapshot[0];
  const amount = audit.input.kind === "expense" ? -audit.input.amountYen : audit.input.amountYen;
  return snapshot.length === 1 && Boolean(root) && root!.date === date && root!.amount === amount && root!.account === audit.input.accountId &&
    // Actual's native rules may attach the originating schedule to a newly added row.
    root!.imported_id === `kakeimatch:schedule:${audit.scheduleId}:${date}` && (root!.schedule == null || root!.schedule === audit.scheduleId) &&
    !root!.is_parent && !root!.is_child && !root!.parent_id && !root!.transfer_id;
}
function sameSchedule(schedule: Awaited<ReturnType<Ledger["listRecurringSchedules"]>>[number], input: RecurringScheduleInput): boolean {
  return schedule.name === input.name && schedule.kind === input.kind && schedule.amountYen === input.amountYen &&
    schedule.categoryId === input.categoryId && schedule.accountId === input.accountId && schedule.frequency === input.frequency &&
    schedule.startDate === input.startDate && schedule.postsTransaction === input.postsTransaction;
}
function sameSnapshot(current: NativeTransactionSnapshot[], expected: NativeTransactionSnapshot[]): boolean {
  if (current.length !== expected.length) return false;
  const byId = new Map(current.map(row => [row.id, row]));
  return expected.every(saved => {
    const actual = byId.get(saved.id);
    if (!actual) return false;
    const keys = new Set([...Object.keys(saved), ...Object.keys(actual)]);
    return [...keys].every(key => (saved as Record<string, unknown>)[key] === (actual as Record<string, unknown>)[key]);
  });
}
