import { accountMetadataRecordId, ActualRestoreIncompleteError, ActualRestoreTargetExistsError } from '../../../src/lib/actual-browser-ledger';
import { LOCAL_PROFILE_KEY, LocalDataRepository, type LocalDataBackupV2 } from '../../../src/lib/local-data';
import { createPortableBackup, readPortableBackup } from '../../../src/lib/local-backup-format';
import { monthlyBudgetSettingsRecordId, validateMonthlyBudgetSettings } from '../../../src/lib/monthly-budget-settings';
import { decryptPortableSyncVersion } from '../../../src/lib/encrypted-sync-version';
import type { EncryptionContext } from '../../../src/lib/encrypted-household-format';

export const PREVIOUS_PROFILE_KEY = 'kakeimatch.previous-local-profile.v1';
export const INCOMPLETE_RESTORE_KEY = 'kakeimatch.incomplete-actual-restore.v1';
const RESTORE_DIRECTORIES_KEY = 'kakeimatch.restore-directories.v1';
export type LocalBudgetSettings = { budgetId: string; dataDir?: string };
export type BackupLedger = {
  exportBackup(): Promise<Uint8Array>;
  restoreBackup(data: Uint8Array, dataDir: string): Promise<string>;
  discardDataDirectory(dataDir: string): Promise<void>;
};

type Dependencies = {
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  openRepository: (profileId: string) => Promise<LocalDataRepository>;
  makeId: () => string;
  now: () => Date;
};
const defaults = (): Dependencies => ({ storage: localStorage, openRepository: id => LocalDataRepository.open(id), makeId: () => crypto.randomUUID(), now: () => new Date() });

function directories(storage: Dependencies['storage']): string[] {
  const raw = storage.getItem(RESTORE_DIRECTORIES_KEY);
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every(dir => typeof dir === 'string' && /^\/kakeimatch-restore\/[0-9a-f-]{36}$/.test(dir))) throw new Error('復元先の保存情報を確認できません。');
  return parsed;
}

/** Called only for an explicit user export. A timestamp records generation, never file-save success. */
export async function exportLocalBackup(repository: LocalDataRepository, ledger: BackupLedger, now = new Date()): Promise<Blob> {
  const localData = await repository.serialize();
  const budgetId = (await repository.get<LocalBudgetSettings>('settings:budget'))?.value.budgetId;
  // The target budget location belongs to this device, not to a portable household snapshot.
  localData.records = localData.records.filter(record => record.id !== 'settings:budget'
    && !record.id.startsWith('settings:basic-categories:')
    && (!record.id.startsWith('settings:monthly-budgets:') || record.id === (budgetId ? monthlyBudgetSettingsRecordId(budgetId) : ''))
    && (record.kind !== 'account-metadata' || Boolean(budgetId) && (record.value as { budgetId?: unknown }).budgetId === budgetId));
  const result = await createPortableBackup({ actualBackup: await ledger.exportBackup(), localData });
  await repository.put({ id: 'settings:backup', kind: 'app-settings', value: { lastExportAt: now.toISOString() }, updatedAt: now.toISOString() });
  return result;
}

/** Validate all bytes before creating a target. Publish one profile pointer only after both stores succeed. */
export async function restoreLocalBackup(file: Blob, ledger: BackupLedger, overrides: Partial<Dependencies> = {}): Promise<string> {
  const backup = await readPortableBackup(file);
  return stageHouseholdBackup(backup, ledger, overrides);
}

/** The sync coordinator must also hold the household lock and guard profile/base-version publication. */
export async function restoreEncryptedLocalBackup(metadata: unknown, expected: EncryptionContext, key: CryptoKey,
  readChunk: (index: number) => Promise<Blob>, ledger: BackupLedger, overrides: Partial<Dependencies> = {}): Promise<string> {
  const plain = await decryptPortableSyncVersion(metadata, expected, key, readChunk);
  return restoreLocalBackup(plain, ledger, overrides);
}

/** Initial standalone budget import also uses a new target, never an in-place Actual import. */
export async function restoreStandaloneBudget(file: Blob, ledger: BackupLedger): Promise<string> {
  if (!file.size || file.size > 128 * 1024 * 1024) throw new Error('家計簿ファイルのサイズが上限を超えています。');
  const backup = { actualBackup: new Uint8Array(await file.arrayBuffer()), localData: { format: 'kakeimatch-local-data' as const, schemaVersion: 2 as const, exportedAt: new Date().toISOString(), records: [], blobs: [] } };
  return stageHouseholdBackup(backup, ledger);
}

async function stageHouseholdBackup(backup: {actualBackup: Uint8Array; localData: LocalDataBackupV2}, ledger: BackupLedger, overrides: Partial<Dependencies> = {}): Promise<string> {
  const deps = { ...defaults(), ...overrides };
  // An empty public budget list does not prove that an earlier partial import was removed.
  // Do not allocate further staging directories until the user has recovered the site data.
  if (deps.storage.getItem(INCOMPLETE_RESTORE_KEY) !== null) {
    throw new Error('以前の復元途中のデータが残っている可能性があるため、新しい復元を開始できません。元の家計データをバックアップしてから、ブラウザーのサイトデータ削除と復元を行ってください。');
  }
  const previous = deps.storage.getItem(LOCAL_PROFILE_KEY);
  const profileId = deps.makeId();
  const dataDir = `/kakeimatch-restore/${profileId}`;
  const known = directories(deps.storage);
  if (!/^[0-9a-f-]{36}$/i.test(profileId) || profileId === previous || profileId === deps.storage.getItem(PREVIOUS_PROFILE_KEY) || known.includes(dataDir)) throw new Error('復元先の保存領域が既存データと重複しています。');
  // Track even incomplete targets so a later full wipe can retry deleting them.
  deps.storage.setItem(RESTORE_DIRECTORIES_KEY, JSON.stringify([...known, dataDir]));
  let staging: LocalDataRepository | undefined;
  let ownsLocalTarget = false;
  try {
    staging = await deps.openRepository(profileId);
    const existing = await staging.serialize();
    if (existing.records.length || existing.blobs.length) throw new ActualRestoreTargetExistsError();
    ownsLocalTarget = true;
    const budgetId = await ledger.restoreBackup(backup.actualBackup, dataDir);
    const localData = {
      ...backup.localData,
      records: backup.localData.records.map(record => {
        if (record.kind === 'account-metadata') {
          const metadata = record.value as { budgetId: string; accountId: string };
          return { ...record, id: accountMetadataRecordId(budgetId, metadata.accountId), value: { ...metadata, budgetId } };
        }
        if (record.id.startsWith('settings:monthly-budgets:')) {
          const oldBudgetId = record.id.slice('settings:monthly-budgets:'.length);
          const settings = validateMonthlyBudgetSettings(record.value, oldBudgetId);
          return { ...record, id: monthlyBudgetSettingsRecordId(budgetId), value: { ...settings, budgetId } };
        }
        return record;
      }),
    };
    await staging.restore(localData);
    const timestamp = deps.now().toISOString();
    await staging.put({ id: 'settings:budget', kind: 'app-settings', value: { budgetId, dataDir }, updatedAt: timestamp });
    const readback = await staging.serialize();
    await verifyLocalReadback(localData, readback);
    // Write the return pointer first. Failure still leaves the active pointer unchanged.
    if (previous) deps.storage.setItem(PREVIOUS_PROFILE_KEY, previous);
    deps.storage.setItem(LOCAL_PROFILE_KEY, profileId);
    return profileId;
  } catch (error) {
    const incomplete = error instanceof ActualRestoreIncompleteError;
    if (incomplete) deps.storage.setItem(INCOMPLETE_RESTORE_KEY, JSON.stringify([...known, dataDir]));
    const cleanup = await Promise.allSettled([
      ownsLocalTarget ? staging?.restore({ format: 'kakeimatch-local-data', schemaVersion: 2, exportedAt: deps.now().toISOString(), records: [], blobs: [] }) : Promise.resolve(),
      error instanceof ActualRestoreTargetExistsError ? Promise.resolve() : ledger.discardDataDirectory(dataDir),
    ]);
    if (!incomplete && cleanup.every(result => result.status === 'fulfilled')) {
      deps.storage.setItem(RESTORE_DIRECTORIES_KEY, JSON.stringify(known));
    } else {
      throw new Error('復元に失敗しました。元の家計データは保持されています。復元途中のデータが残っている可能性があります。完全削除を保証できないため、元のデータのバックアップを保存してからブラウザーのサイトデータ削除を利用してください。', { cause: error });
    }
    throw error;
  } finally { staging?.close(); }
}

async function verifyLocalReadback(expected: LocalDataBackupV2, actual: LocalDataBackupV2): Promise<void> {
  const records = actual.records.filter(record => record.id !== 'settings:budget');
  const source = expected.records.filter(record => record.id !== 'settings:budget');
  const sort = (rows: typeof records) => rows.toSorted((a, b) => a.id.localeCompare(b.id));
  if (JSON.stringify(sort(records)) !== JSON.stringify(sort(source)) || actual.blobs.length !== expected.blobs.length || expected.blobs.some(blob => !actual.blobs.some(item => item.id === blob.id && item.blob.size === blob.blob.size && item.ownerId === blob.ownerId))) {
    throw new Error('復元したデータの読み戻しに失敗しました。');
  }
  for (const source of expected.blobs) {
    const restored = actual.blobs.find(item => item.id === source.id)!;
    const { blob: sourceBlob, ...sourceMetadata } = source;
    const { blob: restoredBlob, ...restoredMetadata } = restored;
    const left = new Uint8Array(await crypto.subtle.digest('SHA-256', await sourceBlob.arrayBuffer()));
    const right = new Uint8Array(await crypto.subtle.digest('SHA-256', await restoredBlob.arrayBuffer()));
    if (JSON.stringify(sourceMetadata) !== JSON.stringify(restoredMetadata) || !left.every((byte, index) => byte === right[index])) throw new Error('復元した原本の読み戻しに失敗しました。');
  }
}

export async function returnToPreviousProfile(overrides: Partial<Dependencies> = {}): Promise<void> {
  const deps = { ...defaults(), ...overrides };
  const previous = deps.storage.getItem(PREVIOUS_PROFILE_KEY);
  if (!previous || !/^[0-9a-f-]{36}$/i.test(previous)) throw new Error('元の家計データが見つかりません。');
  const repository = await deps.openRepository(previous);
  try {
    if (!(await repository.get<LocalBudgetSettings>('settings:budget'))?.value.budgetId) throw new Error('元の家計簿を確認できません。');
    const current = deps.storage.getItem(LOCAL_PROFILE_KEY);
    deps.storage.setItem(LOCAL_PROFILE_KEY, previous);
    if (current) deps.storage.setItem(PREVIOUS_PROFILE_KEY, current);
  } finally { repository.close(); }
}

/** The explicit full wipe uses only the household API/stores; it never calls an auth endpoint. */
export async function wipeLocalHousehold(repository: LocalDataRepository, ledger: BackupLedger, overrides: Partial<Dependencies> = {}): Promise<void> {
  const deps = { ...defaults(), ...overrides };
  if (deps.storage.getItem(INCOMPLETE_RESTORE_KEY) !== null) throw new Error('復元途中の家計簿データをアプリから完全に削除できるか確認できません。元のデータのバックアップを保存してから、ブラウザーのサイトデータ削除を利用してください。');
  for (const dir of new Set(['/documents', ...directories(deps.storage)])) await ledger.discardDataDirectory(dir);
  await repository.clearAllDeviceProfiles();
  for (const key of [LOCAL_PROFILE_KEY, PREVIOUS_PROFILE_KEY, RESTORE_DIRECTORIES_KEY, INCOMPLETE_RESTORE_KEY]) deps.storage.removeItem(key);
}
