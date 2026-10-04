// Same-origin client for `/api/sync/*` (server: workers/ai-gateway/src/device-sync-api.ts).
// It only moves ciphertext and sync metadata; it never sees plaintext household data.

import type { ProtectedHouseholdKey } from '../../../src/lib/encrypted-household-format';

export class SyncApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly details: Record<string, unknown> = {}) {
    super(code);
    this.name = 'SyncApiError';
  }
}

/** Where encrypted versions are kept. Google Drive is written by the device itself. */
export type SyncStorageName = 'kakeimatch-cloud' | 'google-drive';
export type SyncVersion = {
  versionId: string; parentVersionId: string | null; generation: number; sequence: number | null; storage: SyncStorageName;
  state: 'published' | 'conflict'; chunkCount: number; totalBytes: number; createdAt: string; publishedAt: string | null;
  createdByDeviceId: string;
  /** Set on a published version kept because the user chose another one over it. */
  keptAt: string | null;
};
export type SyncVersionDetail = SyncVersion & { chunks: Array<{ index: number; size: number; sha256: string; ref?: string }> };
export type SyncCurrent = { householdId: string; generation: number; storage: SyncStorageName; status: string; currentSequence: number; current: SyncVersion | null };
export type SyncConfig = { googleDrive: { clientId: string } | null };
export type DeviceRegistration = { householdId: string; generation: number; storage: SyncStorageName; deviceId: string; credential: string };
export type PublishResult = { outcome: 'published' | 'conflict'; versionId: string; sequence: number | null; currentVersionId: string | null };
export type SyncDevice = { deviceId: string; generation: number; createdAt: string; revokedAt: string | null; current: boolean };

type Fetch = typeof fetch;

export class DeviceSyncApi {
  constructor(private readonly fetchImpl: Fetch = (...args) => fetch(...args), private readonly credential: string | null = null) {}

  /** The same client, authenticating as this device for device-scoped requests. */
  withCredential(credential: string): DeviceSyncApi { return new DeviceSyncApi(this.fetchImpl, credential); }

  config() { return this.json<SyncConfig>('GET', '/config', undefined, false); }
  createHousehold(householdId: string, storage: SyncStorageName) { return this.json<DeviceRegistration>('POST', '/households', { householdId, storage }, false); }
  joinHousehold() { return this.json<DeviceRegistration>('POST', '/devices', undefined, false); }
  current() { return this.json<SyncCurrent>('GET', '/current'); }
  putKey(generation: number, protectedKey: ProtectedHouseholdKey) { return this.json<{ generation: number }>('PUT', '/key', { generation, protectedKey }); }
  getKey() { return this.json<{ generation: number; protectedKey: unknown }>('GET', '/key'); }
  listDevices() { return this.json<{ devices: SyncDevice[] }>('GET', '/devices'); }
  revokeDevice(deviceId: string) { return this.json<{ generation: number }>('POST', `/devices/${deviceId}/revoke`); }
  deleteHousehold() { return this.json<{ deleted: true }>('DELETE', '/household', undefined, false); }
  beginUpload(input: { requestId: string; versionId: string; baseVersionId: string | null; generation: number; chunkCount: number; totalBytes: number; storage: SyncStorageName }) {
    return this.json<{ versionId: string }>('POST', '/uploads', input);
  }
  version(versionId: string) { return this.json<SyncVersionDetail>('GET', `/versions/${versionId}`); }
  registerExternalChunk(versionId: string, index: number, input: { size: number; sha256: string; ref: string }) {
    return this.json<{ index: number }>('PUT', `/versions/${versionId}/chunks/${index}/external`, input);
  }
  /** Removes versions kept in a storage location the household no longer uses. */
  deleteOtherStorageVersions() { return this.json<{ removedVersions: number }>('DELETE', '/versions?storage=other'); }
  /** Versions the user did not choose: never cleaned up automatically. */
  keptVersions() { return this.json<{ versions: SyncVersion[] }>('GET', '/versions?state=kept'); }
  keepVersion(versionId: string) { return this.json<SyncVersion>('POST', `/versions/${versionId}/keep`); }
  /** File references in the device's own storage that some version still uses. */
  externalRefs() { return this.json<{ refs: string[] }>('GET', '/external-refs'); }
  deleteVersion(versionId: string) { return this.json<{ deleted: true }>('DELETE', `/versions/${versionId}`); }
  request(requestId: string) { return this.json<{ outcome: string; versionId: string; sequence: number | null }>('GET', `/requests/${requestId}`); }

  /** A 409 conflict is an expected outcome of compare-and-swap, not an error. */
  async publish(versionId: string, requestId: string): Promise<PublishResult> {
    try {
      return await this.json<PublishResult>('POST', `/versions/${versionId}/publish`, { requestId });
    } catch (error) {
      if (error instanceof SyncApiError && error.status === 409 && error.code === 'conflict') return error.details as PublishResult;
      throw error;
    }
  }

  async putChunk(versionId: string, index: number, chunk: Blob, sha256: string): Promise<void> {
    await this.send('PUT', `/versions/${versionId}/chunks/${index}`, { body: chunk, headers: { 'content-type': 'application/octet-stream', 'x-chunk-sha256': sha256 } });
  }

  async chunk(versionId: string, index: number): Promise<Blob> {
    return (await this.send('GET', `/versions/${versionId}/chunks/${index}`)).blob();
  }

  private async json<T>(method: string, path: string, body?: unknown, withDevice = true): Promise<T> {
    const init: { body?: string; headers: Record<string, string> } = { headers: {} };
    if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
    return (await this.send(method, path, init, withDevice)).json() as Promise<T>;
  }

  private async send(method: string, path: string, init: { body?: BodyInit; headers?: Record<string, string> } = {}, withDevice = true): Promise<Response> {
    const headers: Record<string, string> = { ...init.headers };
    const credential = withDevice ? this.credential : null;
    // Joining or deleting authenticates with the session; the device credential is not sent.
    if (credential) headers['x-sync-device-credential'] = credential;
    let response: Response;
    try {
      response = await this.fetchImpl(`/api/sync${path}`, { method, body: init.body, headers, credentials: 'same-origin', cache: 'no-store' });
    } catch {
      throw new SyncApiError(0, navigator.onLine === false ? 'offline' : 'network_error');
    }
    if (response.ok) return response;
    const error = await response.json().catch(() => null) as { error?: unknown } & Record<string, unknown> | null;
    const { error: code, ...details } = error ?? {};
    throw new SyncApiError(response.status, typeof code === 'string' ? code : 'temporarily_unavailable', details);
  }
}
