import { LOCAL_PROFILE_KEY, StaleHouseholdProfileError, type LocalWriteGate } from '../../../src/lib/local-data';
import {
  DEVICE_LOCAL_RECORD_IDS, readSwitchJournal, readSyncState, writeSyncState,
  type HouseholdSyncState, type SyncStorage,
} from './household-sync-state';

// One gate for every household write in this tab (Issue #143 §5).
//
// Lock order: the household lock `kakeimatch-household:<profileId>` is always the innermost
// lock. Services take their per-kind locks first; each write then joins this tab's shared
// hold of the household lock. Snapshot creation and import switching take it exclusively
// and never take a per-kind lock or write through this gate, so they cannot deadlock.

export type HouseholdLocks = Pick<LockManager, 'request'>;
type Dependencies = { storage: SyncStorage; locks: HouseholdLocks | undefined; now: () => Date };


export class HouseholdLocksUnavailableError extends Error {
  constructor() {
    super('このブラウザーでは家計データを安全に同期できません。端末内の家計簿はそのまま使えます。');
    this.name = 'HouseholdLocksUnavailableError';
  }
}

export class HouseholdWriteGuard {
  private readonly deps: Dependencies;
  private active = 0;
  private held: Promise<() => void> | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(readonly profileId: string, overrides: Partial<Dependencies> = {}) {
    // Browser globals are read only when no override is given.
    this.deps = {
      storage: overrides.storage ?? localStorage,
      locks: 'locks' in overrides ? overrides.locks : typeof navigator !== 'undefined' ? navigator.locks : undefined,
      now: overrides.now ?? (() => new Date()),
    };
  }

  get lockName(): string { return `kakeimatch-household:${this.profileId}`; }

  /** The LocalDataRepository hook. Device-only records are written without counting a change. */
  readonly repositoryGate: LocalWriteGate = (recordIds, write) => {
    if (recordIds !== null && recordIds.every(id => DEVICE_LOCAL_RECORD_IDS.has(id))) {
      this.assertActive();
      return write();
    }
    return this.write(write);
  };

  /** Called after each counted household write, e.g. to schedule a sync. Returns an unsubscribe function. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Counts a household change before running it, then runs it under the shared lock. */
  async write<T>(operation: () => Promise<T>): Promise<T> {
    await this.enter();
    try {
      this.assertActive();
      this.update(state => ({ ...state, changeCounter: state.changeCounter + 1, lastChangeAt: this.deps.now().toISOString() }));
      return await operation();
    } finally {
      this.leave();
      this.notify();
    }
  }

  /**
   * For writes that often change nothing, such as running due schedules on startup. A marker
   * is kept until the result is known, so a crash still counts as a change; otherwise only a
   * changed fingerprint counts. This prevents "imported, reloaded, counted, published" loops.
   */
  async writeIfChanged<T>(operation: () => Promise<T>, fingerprint: () => Promise<string>): Promise<T> {
    await this.enter();
    try {
      this.assertActive();
      const before = await fingerprint();
      const startedAt = this.deps.now().toISOString();
      this.update(state => ({ ...state, pendingWriteSince: state.pendingWriteSince ?? startedAt }));
      const result = await operation();
      const changed = await fingerprint() !== before;
      this.update(state => ({
        ...state, pendingWriteSince: null,
        ...(changed ? { changeCounter: state.changeCounter + 1, lastChangeAt: this.deps.now().toISOString() } : {}),
      }));
      if (changed) this.notify();
      return result;
    } finally { this.leave(); }
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  /** Runs with every household write in every tab stopped. Never call it from inside a write. */
  exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const locks = this.deps.locks;
    if (!locks) return Promise.reject(new HouseholdLocksUnavailableError());
    return locks.request(this.lockName, { mode: 'exclusive' }, () => operation()) as Promise<T>;
  }

  /** Throws instead of writing when another tab switched the household or a switch is unfinished. */
  assertActive(): void {
    if (this.deps.storage.getItem(LOCAL_PROFILE_KEY) !== this.profileId || readSwitchJournal(this.deps.storage) !== null) {
      throw new StaleHouseholdProfileError();
    }
  }

  private update(change: (state: HouseholdSyncState) => HouseholdSyncState): void {
    writeSyncState(this.profileId, change(readSyncState(this.profileId, this.deps.storage)), this.deps.storage);
  }

  // Concurrent and nested writes in this tab share one hold of the lock. Requesting it per
  // nested write would deadlock behind a queued exclusive request from another tab.
  private async enter(): Promise<void> {
    this.active += 1;
    const locks = this.deps.locks;
    if (!locks) return;
    this.held ??= new Promise(granted => {
      void locks.request(this.lockName, { mode: 'shared' }, () => new Promise<void>(release => granted(release)));
    });
    await this.held;
  }

  private leave(): void {
    this.active -= 1;
    if (this.active > 0 || !this.held) return;
    const held = this.held;
    this.held = null;
    void held.then(release => release());
  }
}

/** Methods that change the active household. Every public ledger method must be in one list. */
export const LEDGER_WRITE_METHODS = [
  'setMonthlyBudget', 'createRecurringSchedule', 'updateRecurringSchedule', 'deleteRecurringSchedule',
  'skipDeletedScheduleOccurrences', 'createTransaction', 'updateTransaction', 'createTransfer', 'updateTransfer',
  'addCategory', 'setCategoryHidden', 'deleteCategory', 'addAccount', 'setAccountType', 'renameAccount',
  'closeAccount', 'reopenAccount', 'deleteAccount', 'createExpenseCategory', 'renameCategory',
  'importReceipt', 'editReceipt', 'deleteTransactionTree', 'restoreTransactionTree', 'updateReceipt',
  'applyTransactionUpdates',
] as const;
/** Changes the household only when something is due. */
export const LEDGER_CONDITIONAL_WRITE_METHODS = ['runDueSchedules'] as const;
export const LEDGER_READ_METHODS = [
  'exportBackup', 'listLocalBudgets', 'getRecentTransactions', 'getTransactions', 'getSearchTransactions',
  'getTransactionById', 'getMonthlySummary', 'getMonthlyBudgets', 'listRecurringSchedules', 'getMonthlySpending',
  'listOpenAccounts', 'listExpenseCategories', 'listIncomeCategories', 'listCategories', 'getCategoryUsage',
  'listAccounts', 'getAccountBalances', 'getAccountUsage', 'getTransactionTree',
] as const;
/** Work on staging or superseded data directories, never on the active household. */
export const LEDGER_OUTSIDE_HOUSEHOLD_METHODS = ['restoreBackup', 'discardDataDirectory', 'deleteLocalBudget'] as const;

type Method = (...args: unknown[]) => Promise<unknown>;

/** Returns a ledger whose household writes go through the guard. Reads are unchanged. */
export function guardLedger<L extends { runDueSchedules(): Promise<void>; listRecurringSchedules(): Promise<unknown> }>(ledger: L, guard: HouseholdWriteGuard): L {
  const methods = ledger as unknown as Record<string, Method>;
  const wrapped: Record<string, unknown> = { ...ledger };
  for (const name of LEDGER_WRITE_METHODS) {
    const method = methods[name];
    if (typeof method === 'function') wrapped[name] = (...args: unknown[]) => guard.write(() => method(...args));
  }
  wrapped.runDueSchedules = () => guard.writeIfChanged(() => ledger.runDueSchedules(),
    async () => JSON.stringify(await ledger.listRecurringSchedules()));
  return wrapped as L;
}
