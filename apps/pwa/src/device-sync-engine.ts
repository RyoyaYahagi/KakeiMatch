import { createHouseholdEncryptionKey, recoverHouseholdEncryptionKey } from '../../../src/lib/encrypted-household-format';
import { decryptPortableSyncVersion, prepareEncryptedSyncVersion } from '../../../src/lib/encrypted-sync-version';
import type { LocalDataRepository } from '../../../src/lib/local-data';
import { applySyncSnapshot, createSyncSnapshot, type BackupDependencies, type BackupLedger } from './local-backup';
import { hasUnsentChanges, readSyncState, writeSyncState, type SyncStorage } from './household-sync-state';
import type { HouseholdWriteGuard } from './household-write-guard';
import { SyncApiError, type DeviceSyncApi, type SyncStorageName, type SyncVersion, type SyncVersionDetail } from './device-sync-api';
import type { DeviceSyncSecretStore, DeviceSyncSecrets } from './device-sync-secrets';

// Issue #143 §4: the whole household is exchanged as one encrypted version. The server only
// orders versions; which side wins is never decided by time. See docs/DEVICE_SYNC.md.

const PENDING_PUBLISH_KEY = 'kakeimatch.sync-pending-publish.v1';
// Another device may have stored a chunk and not registered it yet. Routine cleanup leaves
// files this young alone; the server forgets unpublished uploads after the same period.
const EXTERNAL_PRUNE_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * A storage location the device writes to itself, such as the user's Google Drive. It receives
 * only encrypted chunks and returns an opaque reference. Location-specific code lives in its
 * implementation; this engine never branches on which location it is.
 */
export interface ExternalSyncStorage {
  readonly name: Exclude<SyncStorageName, 'kakeimatch-cloud'>;
  isConnected(): boolean;
  put(chunk: Blob): Promise<string>;
  get(ref: string): Promise<Blob>;
  delete(ref: string): Promise<void>;
  /** Every chunk this app stored there, including ones no version uses any more. */
  list(): Promise<Array<{ ref: string; createdAt: string }>>;
}
/** The external location needs the user to connect again (signed out, expired, or access removed). */
export class ExternalStorageAuthError extends Error {
  constructor() { super('external_storage_auth'); this.name = 'ExternalStorageAuthError'; }
}
/** A chunk a version refers to is missing from the external location. Never treated as an empty household. */
export class ExternalStorageMissingError extends Error {
  constructor() { super('storage_object_missing'); this.name = 'ExternalStorageMissingError'; }
}

export type SyncOutcome =
  | { status: 'off' }
  | { status: 'synced' }
  | { status: 'published'; sequence: number | null }
  /** A newer version was imported; the page must reload to show it. */
  | { status: 'imported'; profileId: string }
  /** A newer version exists but importing was held because the user may be typing. */
  | { status: 'remote_changes' }
  /** Try again later: recent or unfinished local changes, or a change appeared during import. */
  | { status: 'waiting'; retryAfterMs: number }
  | { status: 'conflict'; remote: SyncVersion }
  | { status: 'recovery_code_required' }
  /** The household is kept in a location this device must connect to (again), e.g. Google Drive. */
  | { status: 'storage_reconnect_required'; storage: SyncStorageName }
  | { status: 'rejoin_required' }
  | { status: 'sign_in_required' }
  | { status: 'offline' }
  | { status: 'failed'; code: string };

type PendingPublish = {
  profileId: string; requestId: string; versionId: string; baseVersionId: string | null;
  changeCounter: number; generation: number;
};

export type DeviceSyncDependencies = {
  api: DeviceSyncApi;
  secrets: DeviceSyncSecretStore;
  repository: LocalDataRepository;
  ledger: BackupLedger;
  guard: HouseholdWriteGuard;
  storage?: SyncStorage;
  /** The location a household may be kept in besides KakeiMatch Cloud. */
  externalStorage?: ExternalSyncStorage;
  makeId?: () => string;
  /** How staged households are opened during an import. Defaults to the browser's stores. */
  backup?: Partial<Omit<BackupDependencies, 'storage'>>;
};

export class DeviceSyncEngine {
  private readonly storage: SyncStorage;
  private readonly makeId: () => string;
  private running: Promise<SyncOutcome> | null = null;

  constructor(private readonly deps: DeviceSyncDependencies) {
    this.storage = deps.storage ?? localStorage;
    this.makeId = deps.makeId ?? (() => crypto.randomUUID());
  }

  private get profileId() { return this.deps.guard.profileId; }

  /** Turns sync on for this household. Returns the recovery code the user must store elsewhere. */
  async enable(storage: SyncStorageName = 'kakeimatch-cloud'): Promise<{ recoveryCode: string }> {
    if (await this.deps.secrets.load()) throw new Error('この端末では同期が有効です。');
    if (storage !== 'kakeimatch-cloud' && !this.external(storage)?.isConnected()) throw new ExternalStorageAuthError();
    const householdId = this.makeId();
    const registration = await this.deps.api.createHousehold(householdId, storage);
    const { key, recoveryCode, protectedKey } = await createHouseholdEncryptionKey(householdId, registration.generation);
    // Keep the key before telling the server about it, so a lost response never loses the key.
    const secrets = { householdId, generation: registration.generation, deviceId: registration.deviceId, credential: registration.credential, key };
    await this.deps.secrets.save(secrets);
    await this.api(secrets).putKey(registration.generation, protectedKey);
    return { recoveryCode };
  }

  /**
   * Registers this device for the user's household. The household key is recovered from the
   * recovery code; a wrong code can be retried without registering again. Local data is never
   * merged: the synced household is opened as a new household and the current one is kept as
   * "切り替え前の家計データ".
   */
  async join(recoveryCode: string): Promise<SyncOutcome> {
    let secrets = await this.deps.secrets.load();
    if (!secrets) {
      const registration = await this.deps.api.joinHousehold();
      secrets = { householdId: registration.householdId, generation: registration.generation, deviceId: registration.deviceId, credential: registration.credential, key: null, joining: true };
      await this.deps.secrets.save(secrets);
    }
    if (!secrets.key) {
      const { generation, protectedKey } = await this.api(secrets).getKey();
      const key = await recoverHouseholdEncryptionKey(protectedKey, recoveryCode.trim(), { householdId: secrets.householdId, generation });
      secrets = { ...secrets, generation, key };
      await this.deps.secrets.save(secrets);
    }
    return this.sync();
  }

  /**
   * Runs one sync. Concurrent calls share the same run. With `allowImport: false` a newer
   * version is reported as `remote_changes` instead of switching households under an open form.
   */
  sync(options: { allowImport?: boolean } = {}): Promise<SyncOutcome> {
    this.running ??= this.syncOnce(options.allowImport ?? true).catch(error => outcomeOf(error)).finally(() => { this.running = null; });
    return this.running;
  }

  /** Public settings, such as whether Google Drive can be chosen. */
  config() { return this.deps.api.config(); }

  /** True when this device has sync turned on (credential stored). */
  async isEnabled(): Promise<boolean> {
    return (await this.deps.secrets.load()) !== null;
  }

  /** Keeps this device's household: publishes it on top of the other device's version. */
  async keepThisDevice(): Promise<SyncOutcome> {
    return this.withSecrets(async secrets => {
      const current = await this.api(secrets).current();
      return this.publish(secrets, current.current?.versionId ?? null, current.storage);
    });
  }

  /**
   * Moves the household to another storage location. This device first syncs, then publishes
   * its household to the new location; the switch takes effect only when that publish succeeds,
   * so a failure leaves the old location in use. The old location's data stays until
   * `deleteOtherStorageData()`.
   */
  async switchStorage(target: SyncStorageName): Promise<SyncOutcome> {
    return this.withSecrets(async secrets => {
      const before = await this.api(secrets).current();
      if (before.storage === target) return { status: 'synced' };
      const synced = await this.syncOnce(true);
      if (synced.status !== 'synced' && synced.status !== 'published') return synced;
      const current = await this.api(secrets).current();
      return this.publish(secrets, current.current?.versionId ?? null, target);
    });
  }

  /** Deletes the data kept in the storage location the household no longer uses. */
  async deleteOtherStorageData(): Promise<void> {
    const secrets = await this.requireSecrets();
    const api = this.api(secrets);
    await api.deleteOtherStorageVersions();
    const current = await api.current();
    const external = this.deps.externalStorage;
    if (!external || !external.isConnected()) return;
    // Every file the household no longer refers to is removed, including unfinished uploads.
    await this.pruneExternal(current.storage === external.name ? await this.externalRefs(secrets) : new Set(), 0);
  }

  /** Uses the other device's version. This device's household stays as "切り替え前の家計データ". */
  async useOtherDevice(): Promise<SyncOutcome> {
    return this.withSecrets(async secrets => {
      const current = await this.api(secrets).current();
      if (!current.current) return { status: 'synced' };
      return this.importVersion(secrets, current.current);
    });
  }

  /**
   * Revokes another device. The household moves to a new key generation, so this device creates
   * a new key and recovery code and republishes. Other devices must join again with the new code.
   */
  async revokeDevice(deviceId: string): Promise<{ recoveryCode: string; outcome: SyncOutcome }> {
    const secrets = await this.requireSecrets();
    if (deviceId === secrets.deviceId) throw new Error('この端末は「この端末の同期を停止」で止めてください。');
    const { generation } = await this.api(secrets).revokeDevice(deviceId);
    const { key, recoveryCode, protectedKey } = await createHouseholdEncryptionKey(secrets.householdId, generation);
    const rotated = { ...secrets, generation, key };
    await this.deps.secrets.save(rotated);
    await this.api(rotated).putKey(generation, protectedKey);
    const current = await this.api(rotated).current();
    return { recoveryCode, outcome: await this.publish(rotated, current.current?.versionId ?? null, current.storage).catch(error => outcomeOf(error)) };
  }

  /** Stops sending and receiving on this device. Household data on this device is kept. */
  async stopOnThisDevice(): Promise<void> {
    await this.deps.secrets.clear();
    this.storage.removeItem(PENDING_PUBLISH_KEY);
    const state = readSyncState(this.profileId, this.storage);
    writeSyncState(this.profileId, { ...state, householdId: null, baseVersionId: null, baseSequence: null }, this.storage);
  }

  /** Deletes all synced data in the cloud, then stops sync here. Data on devices is not deleted. */
  async deleteCloudData(): Promise<void> {
    const secrets = await this.requireSecrets();
    const current = await this.api(secrets).current();
    const external = this.deps.externalStorage;
    if (current.storage !== 'kakeimatch-cloud' && !this.external(current.storage)?.isConnected()) throw new ExternalStorageAuthError();
    // Files in the user's own storage can only be removed from this device.
    if (external?.isConnected()) await this.pruneExternal(new Set(), 0);
    await this.api(secrets).deleteHousehold();
    await this.stopOnThisDevice();
  }

  /** The household's storage location, for display. */
  async storageLocation(): Promise<SyncStorageName> {
    return (await this.api(await this.requireSecrets()).current()).storage;
  }

  async devices() {
    return (await this.api(await this.requireSecrets()).listDevices()).devices;
  }

  private async syncOnce(allowImport: boolean): Promise<SyncOutcome> {
    const secrets = await this.deps.secrets.load();
    if (!secrets) return { status: 'off' };
    if (!secrets.key) return { status: 'recovery_code_required' };
    const pending = this.readPending();
    if (pending) {
      const resumed = await this.resumePublish(secrets, pending);
      if (resumed) return resumed;
    }
    const current = await this.api(secrets).current();
    if (current.generation !== secrets.generation) return { status: 'rejoin_required' };
    // Until a joining device opens the synced household, it only imports.
    if (secrets.joining && current.current) return allowImport ? this.importVersion(secrets, current.current) : { status: 'remote_changes' };
    const state = readSyncState(this.profileId, this.storage);
    const bound = state.householdId === secrets.householdId;
    // A household that never synced (or was restored from a backup) has changes to send.
    const local = !bound || hasUnsentChanges(state);
    const remoteId = current.current?.versionId ?? null;
    if (bound && remoteId === state.baseVersionId) return local ? this.publish(secrets, remoteId, current.storage) : { status: 'synced' };
    if (!current.current) return this.publish(secrets, null, current.storage);
    if (!local) return allowImport ? this.importVersion(secrets, current.current) : { status: 'remote_changes' };
    return { status: 'conflict', remote: current.current };
  }

  /** Publishes this device's household with compare-and-swap on `baseVersionId`. */
  private async publish(secrets: DeviceSyncSecrets, baseVersionId: string | null, storage: SyncStorageName): Promise<SyncOutcome> {
    if (!secrets.key) return { status: 'recovery_code_required' };
    const external = storage === 'kakeimatch-cloud' ? null : this.external(storage);
    if (storage !== 'kakeimatch-cloud' && !external?.isConnected()) return { status: 'storage_reconnect_required', storage };
    const snapshot = await createSyncSnapshot(this.deps.repository, this.deps.ledger, this.deps.guard, { storage: this.storage });
    if (snapshot.status === 'deferred') return { status: 'waiting', retryAfterMs: snapshot.retryAfterMs };
    const versionId = this.makeId();
    const context = { householdId: secrets.householdId, generation: secrets.generation, versionId, parentVersionId: baseVersionId };
    const { metadata, chunk } = await prepareEncryptedSyncVersion(snapshot.blob, secrets.key, context);
    const pending: PendingPublish = {
      profileId: this.profileId, requestId: this.makeId(), versionId, baseVersionId,
      changeCounter: snapshot.changeCounter, generation: secrets.generation,
    };
    // Recorded before the first request: a lost publish response is resolved by its request ID.
    this.storage.setItem(PENDING_PUBLISH_KEY, JSON.stringify(pending));
    const api = this.api(secrets);
    await api.beginUpload({ requestId: this.makeId(), versionId, baseVersionId, generation: secrets.generation, chunkCount: metadata.chunks.length, totalBytes: metadata.totalBytes, storage });
    for (const part of metadata.chunks) {
      if (!external) { await api.putChunk(versionId, part.index, chunk(part.index), part.sha256); continue; }
      const ref = await external.put(chunk(part.index));
      await api.registerExternalChunk(versionId, part.index, { size: part.size, sha256: part.sha256, ref });
    }
    const result = await api.publish(versionId, pending.requestId);
    const outcome = await this.finishPublish(secrets, pending, result.outcome, result.sequence);
    // Older versions beyond the retained history no longer need their external files. Cleanup is
    // retried after the next publish, so its failure does not turn a successful publish into an error.
    if (outcome.status === 'published' && external) {
      await this.pruneExternal(await this.externalRefs(secrets), EXTERNAL_PRUNE_AGE_MS).catch(() => console.warn('sync_external_cleanup_failed'));
    }
    return outcome;
  }

  private async resumePublish(secrets: DeviceSyncSecrets, pending: PendingPublish): Promise<SyncOutcome | null> {
    if (pending.profileId !== this.profileId || pending.generation !== secrets.generation) {
      this.storage.removeItem(PENDING_PUBLISH_KEY);
      return null;
    }
    try {
      const recorded = await this.api(secrets).request(pending.requestId);
      return this.finishPublish(secrets, pending, recorded.outcome === 'published' ? 'published' : 'conflict', recorded.sequence);
    } catch (error) {
      // The publish never reached the server; the unfinished upload expires there on its own.
      if (error instanceof SyncApiError && error.status === 404 && error.code === 'request_not_found') {
        this.storage.removeItem(PENDING_PUBLISH_KEY);
        return null;
      }
      throw error;
    }
  }

  private async finishPublish(secrets: DeviceSyncSecrets, pending: PendingPublish, outcome: 'published' | 'conflict', sequence: number | null): Promise<SyncOutcome> {
    this.storage.removeItem(PENDING_PUBLISH_KEY);
    if (outcome === 'conflict') {
      const current = await this.api(secrets).current();
      return current.current ? { status: 'conflict', remote: current.current } : { status: 'failed', code: 'conflict' };
    }
    // Changes saved while uploading are newer than the snapshot and stay unsent.
    const state = readSyncState(pending.profileId, this.storage);
    writeSyncState(pending.profileId, {
      ...state, householdId: secrets.householdId, baseVersionId: pending.versionId, baseSequence: sequence,
      syncedCounter: pending.changeCounter,
    }, this.storage);
    return { status: 'published', sequence };
  }

  private async importVersion(secrets: DeviceSyncSecrets, version: SyncVersion): Promise<SyncOutcome> {
    if (!secrets.key) return { status: 'recovery_code_required' };
    if (version.generation !== secrets.generation) return { status: 'rejoin_required' };
    const api = this.api(secrets);
    const detail = await api.version(version.versionId);
    const context = { householdId: secrets.householdId, generation: detail.generation, versionId: detail.versionId, parentVersionId: detail.parentVersionId };
    const external = detail.storage === 'kakeimatch-cloud' ? null : this.external(detail.storage);
    if (detail.storage !== 'kakeimatch-cloud' && !external?.isConnected()) return { status: 'storage_reconnect_required', storage: detail.storage };
    const chunks = detail.chunks.map(({ index, size, sha256 }) => ({ index, size, sha256 }));
    const plain = await decryptPortableSyncVersion({ context, totalBytes: detail.totalBytes, chunks }, context, secrets.key,
      index => external ? external.get(chunkRef(detail, index)) : api.chunk(detail.versionId, index));
    const state = readSyncState(this.profileId, this.storage);
    const result = await applySyncSnapshot(plain, this.deps.ledger, this.deps.guard,
      { profileId: this.profileId, changeCounter: state.changeCounter, baseVersionId: state.baseVersionId },
      { householdId: secrets.householdId, baseVersionId: detail.versionId, baseSequence: detail.sequence ?? 0 }, { ...this.deps.backup, storage: this.storage });
    if (result.status !== 'applied') return { status: 'waiting', retryAfterMs: 0 };
    if (secrets.joining) await this.deps.secrets.save({ ...secrets, joining: false });
    return { status: 'imported', profileId: result.profileId };
  }

  private external(storage: SyncStorageName): ExternalSyncStorage | null {
    const external = this.deps.externalStorage;
    return external && external.name === storage ? external : null;
  }

  /** External file references of every version the server still keeps. */
  private async externalRefs(secrets: DeviceSyncSecrets): Promise<Set<string>> {
    const api = this.api(secrets);
    const refs = new Set<string>();
    for (const version of (await api.versions()).versions) {
      if (version.storage === 'kakeimatch-cloud') continue;
      for (const chunk of (await api.version(version.versionId)).chunks) if (chunk.ref) refs.add(chunk.ref);
    }
    return refs;
  }

  /** Deletes this app's external files that no kept version refers to and that are at least `minAgeMs` old. */
  private async pruneExternal(keep: Set<string>, minAgeMs: number): Promise<void> {
    const external = this.deps.externalStorage;
    if (!external) return;
    const cutoff = Date.now() - minAgeMs;
    for (const file of await external.list()) {
      if (!keep.has(file.ref) && Date.parse(file.createdAt) <= cutoff) await external.delete(file.ref);
    }
  }

  private async withSecrets(action: (secrets: DeviceSyncSecrets) => Promise<SyncOutcome>): Promise<SyncOutcome> {
    try { return await action(await this.requireSecrets()); } catch (error) { return outcomeOf(error); }
  }

  private async requireSecrets(): Promise<DeviceSyncSecrets> {
    const secrets = await this.deps.secrets.load();
    if (!secrets) throw new Error('この端末では同期が有効ではありません。');
    return secrets;
  }

  private api(secrets: DeviceSyncSecrets): DeviceSyncApi {
    return this.deps.api.withCredential(secrets.credential);
  }

  private readPending(): PendingPublish | null {
    const raw = this.storage.getItem(PENDING_PUBLISH_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw) as PendingPublish; } catch { this.storage.removeItem(PENDING_PUBLISH_KEY); return null; }
  }
}

function chunkRef(detail: SyncVersionDetail, index: number): string {
  const ref = detail.chunks.find(chunk => chunk.index === index)?.ref;
  if (!ref) throw new ExternalStorageMissingError();
  return ref;
}

/** Maps failures to states the screen can explain. Unknown errors are reported, not hidden. */
export function outcomeOf(error: unknown): SyncOutcome {
  if (error instanceof ExternalStorageAuthError) return { status: 'storage_reconnect_required', storage: 'google-drive' };
  if (error instanceof SyncApiError) {
    if (error.status === 0) return { status: 'offline' };
    if (error.status === 401 || error.code === 'recent_sign_in_required') return { status: 'sign_in_required' };
    if (['device_revoked', 'device_generation_stale', 'invalid_device_credential', 'household_not_found', 'household_deleted'].includes(error.code)) {
      return { status: 'rejoin_required' };
    }
    return { status: 'failed', code: error.code };
  }
  return { status: 'failed', code: error instanceof Error ? error.name : 'unknown' };
}
