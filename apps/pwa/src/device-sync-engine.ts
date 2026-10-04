import { createHouseholdEncryptionKey, recoverHouseholdEncryptionKey } from '../../../src/lib/encrypted-household-format';
import { decryptPortableSyncVersion, prepareEncryptedSyncVersion } from '../../../src/lib/encrypted-sync-version';
import type { LocalDataRepository } from '../../../src/lib/local-data';
import { applySyncSnapshot, createSyncSnapshot, type BackupDependencies, type BackupLedger } from './local-backup';
import { hasUnsentChanges, readSyncState, writeSyncState, type SyncStorage } from './household-sync-state';
import type { HouseholdWriteGuard } from './household-write-guard';
import { SyncApiError, type DeviceSyncApi, type SyncVersion } from './device-sync-api';
import type { DeviceSyncSecretStore, DeviceSyncSecrets } from './device-sync-secrets';

// Issue #143 §4: the whole household is exchanged as one encrypted version. The server only
// orders versions; which side wins is never decided by time. See docs/DEVICE_SYNC.md.

const PENDING_PUBLISH_KEY = 'kakeimatch.sync-pending-publish.v1';

export type SyncOutcome =
  | { status: 'off' }
  | { status: 'synced' }
  | { status: 'published'; sequence: number | null }
  /** A newer version was imported; the page must reload to show it. */
  | { status: 'imported'; profileId: string }
  /** Try again later: recent or unfinished local changes, or a change appeared during import. */
  | { status: 'waiting'; retryAfterMs: number }
  | { status: 'conflict'; remote: SyncVersion }
  | { status: 'recovery_code_required' }
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
  async enable(): Promise<{ recoveryCode: string }> {
    if (await this.deps.secrets.load()) throw new Error('この端末では同期が有効です。');
    const householdId = this.makeId();
    const registration = await this.deps.api.createHousehold(householdId);
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
      secrets = { householdId: registration.householdId, generation: registration.generation, deviceId: registration.deviceId, credential: registration.credential, key: null };
      await this.deps.secrets.save(secrets);
    }
    if (!secrets.key) {
      const { generation, protectedKey } = await this.api(secrets).getKey();
      const key = await recoverHouseholdEncryptionKey(protectedKey, recoveryCode.trim(), { householdId: secrets.householdId, generation });
      secrets = { ...secrets, generation, key };
      await this.deps.secrets.save(secrets);
    }
    const current = await this.api(secrets).current();
    if (!current.current) return this.sync();
    return this.importVersion(secrets, current.current);
  }

  /** Runs one sync. Concurrent calls share the same run. */
  sync(): Promise<SyncOutcome> {
    this.running ??= this.syncOnce().catch(error => outcomeOf(error)).finally(() => { this.running = null; });
    return this.running;
  }

  /** Keeps this device's household: publishes it on top of the other device's version. */
  async keepThisDevice(): Promise<SyncOutcome> {
    return this.withSecrets(async secrets => {
      const current = await this.api(secrets).current();
      return this.publish(secrets, current.current?.versionId ?? null);
    });
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
    return { recoveryCode, outcome: await this.publish(rotated, current.current?.versionId ?? null).catch(error => outcomeOf(error)) };
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
    await this.api(secrets).deleteHousehold();
    await this.stopOnThisDevice();
  }

  async devices() {
    return (await this.api(await this.requireSecrets()).listDevices()).devices;
  }

  private async syncOnce(): Promise<SyncOutcome> {
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
    const state = readSyncState(this.profileId, this.storage);
    const bound = state.householdId === secrets.householdId;
    // A household that never synced (or was restored from a backup) has changes to send.
    const local = !bound || hasUnsentChanges(state);
    const remoteId = current.current?.versionId ?? null;
    if (bound && remoteId === state.baseVersionId) return local ? this.publish(secrets, remoteId) : { status: 'synced' };
    if (!current.current) return this.publish(secrets, null);
    if (!local) return this.importVersion(secrets, current.current);
    return { status: 'conflict', remote: current.current };
  }

  /** Publishes this device's household with compare-and-swap on `baseVersionId`. */
  private async publish(secrets: DeviceSyncSecrets, baseVersionId: string | null): Promise<SyncOutcome> {
    if (!secrets.key) return { status: 'recovery_code_required' };
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
    await api.beginUpload({ requestId: this.makeId(), versionId, baseVersionId, generation: secrets.generation, chunkCount: metadata.chunks.length, totalBytes: metadata.totalBytes });
    for (const part of metadata.chunks) await api.putChunk(versionId, part.index, chunk(part.index), part.sha256);
    const result = await api.publish(versionId, pending.requestId);
    return this.finishPublish(secrets, pending, result.outcome, result.sequence);
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
    const plain = await decryptPortableSyncVersion({ context, totalBytes: detail.totalBytes, chunks: detail.chunks }, context, secrets.key,
      index => api.chunk(detail.versionId, index));
    const state = readSyncState(this.profileId, this.storage);
    const result = await applySyncSnapshot(plain, this.deps.ledger, this.deps.guard,
      { profileId: this.profileId, changeCounter: state.changeCounter, baseVersionId: state.baseVersionId },
      { householdId: secrets.householdId, baseVersionId: detail.versionId, baseSequence: detail.sequence ?? 0 }, { ...this.deps.backup, storage: this.storage });
    return result.status === 'applied' ? { status: 'imported', profileId: result.profileId } : { status: 'waiting', retryAfterMs: 0 };
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

/** Maps failures to states the screen can explain. Unknown errors are reported, not hidden. */
export function outcomeOf(error: unknown): SyncOutcome {
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
