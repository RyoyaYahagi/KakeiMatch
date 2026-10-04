import { z } from 'zod';
import type { LocalDataRecord } from '../../../src/lib/local-data';

// Device-local bookkeeping for device sync (Issue #143). It lives in localStorage, never in
// the household stores, so `.kmb` backups and sync snapshots never carry it.

const STATE_PREFIX = 'kakeimatch.household-sync.v1:';
export const HOUSEHOLD_SWITCH_KEY = 'kakeimatch.household-switch.v1';

/** Records that describe this device rather than the household. Writing them is not a household change. */
export const DEVICE_LOCAL_RECORD_IDS: ReadonlySet<string> = new Set(['settings:budget', 'settings:backup']);

const uuid = z.string().regex(/^[0-9a-f-]{36}$/i);
const counter = z.number().int().safe().nonnegative();

const stateSchema = z.object({
  /** Increases before every household write, so a crash after the write still counts. */
  changeCounter: counter,
  /** The counter value contained in the version this device last published or imported. */
  syncedCounter: counter,
  /** Set before a write whose effect is only known afterwards; a crash leaves it set. */
  pendingWriteSince: z.iso.datetime().nullable(),
  lastChangeAt: z.iso.datetime().nullable(),
  householdId: uuid.nullable(),
  baseVersionId: uuid.nullable(),
  baseSequence: counter.nullable(),
}).strict();
export type HouseholdSyncState = z.infer<typeof stateSchema>;

export const initialSyncState: HouseholdSyncState = {
  changeCounter: 0, syncedCounter: 0, pendingWriteSince: null, lastChangeAt: null,
  householdId: null, baseVersionId: null, baseSequence: null,
};

export type SyncStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export class HouseholdSyncStateError extends Error {
  constructor() {
    super('この端末の同期状態を確認できません。家計データは変更していません。');
    this.name = 'HouseholdSyncStateError';
  }
}

export function readSyncState(profileId: string, storage: SyncStorage = localStorage): HouseholdSyncState {
  const raw = storage.getItem(STATE_PREFIX + profileId);
  if (raw === null) return initialSyncState;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new HouseholdSyncStateError(); }
  const state = stateSchema.safeParse(parsed);
  if (!state.success) throw new HouseholdSyncStateError();
  return state.data;
}

export function writeSyncState(profileId: string, state: HouseholdSyncState, storage: SyncStorage = localStorage): void {
  storage.setItem(STATE_PREFIX + profileId, JSON.stringify(stateSchema.parse(state)));
}

export function removeSyncState(profileId: string, storage: SyncStorage = localStorage): void {
  storage.removeItem(STATE_PREFIX + profileId);
}

/** True when this device has household changes that are not in its base version. */
export function hasUnsentChanges(state: HouseholdSyncState): boolean {
  return state.changeCounter !== state.syncedCounter || state.pendingWriteSince !== null;
}

const switchSchema = z.object({
  fromProfileId: uuid.nullable(),
  toProfileId: uuid,
  toDataDir: z.string().regex(/^\/kakeimatch-restore\/[0-9a-f-]{36}$/),
  next: z.object({ householdId: uuid, baseVersionId: uuid, baseSequence: counter }).strict(),
  startedAt: z.iso.datetime(),
}).strict();
/** Written before the active profile pointer moves and removed after the switch is complete. */
export type HouseholdSwitchJournal = z.infer<typeof switchSchema>;

export function readSwitchJournal(storage: SyncStorage = localStorage): HouseholdSwitchJournal | null {
  const raw = storage.getItem(HOUSEHOLD_SWITCH_KEY);
  if (raw === null) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new HouseholdSyncStateError(); }
  const journal = switchSchema.safeParse(parsed);
  if (!journal.success) throw new HouseholdSyncStateError();
  return journal.data;
}

export function writeSwitchJournal(journal: HouseholdSwitchJournal, storage: SyncStorage = localStorage): void {
  storage.setItem(HOUSEHOLD_SWITCH_KEY, JSON.stringify(switchSchema.parse(journal)));
}

export function clearSwitchJournal(storage: SyncStorage = localStorage): void {
  storage.removeItem(HOUSEHOLD_SWITCH_KEY);
}

type StatusValue = { status?: unknown; registration?: { status?: unknown } };

/**
 * Lists records of multi-step operations that are not settled yet. A version must not be
 * published mid-way: the other device would receive a half-applied edit, deletion or
 * registration whose recovery belongs to this device.
 */
export function findUnsettledOperations(records: ReadonlyArray<LocalDataRecord>): string[] {
  return records.filter(record => {
    const value = record.value as StatusValue | null;
    if (!value || typeof value !== 'object') return false;
    switch (record.kind) {
      // Receipt/transaction edits, schedule changes and deletions write the audit before Actual.
      case 'correction-audit': return value.status === 'pending' || value.status === 'restoring';
      case 'reconciliation-resolution': return value.status === 'pending' || value.status === 'processing';
      // A pending registration is an unregistered draft; only an in-flight one is unsettled.
      case 'receipt-metadata': return value.registration?.status === 'processing';
      default: return false;
    }
  }).map(record => record.id);
}
