import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureGoogleDriveReturn, GoogleDriveStorage, GOOGLE_DRIVE_SCOPE, startGoogleDriveConnection } from '../../apps/pwa/src/google-drive-storage';
import { ExternalStorageAuthError, ExternalStorageMissingError } from '../../apps/pwa/src/device-sync-engine';

// Google endpoints are synthetic. Only the browser-side contract is checked here.
let session: Map<string, string>;
let location: { origin: string; pathname: string; search: string; hash: string; assign: ReturnType<typeof vi.fn> };
const replaceState = vi.fn((_state: unknown, _title: string, url: string) => { location.hash = ''; void url; });

beforeEach(() => {
  session = new Map();
  location = { origin: 'https://kakeimatch.example', pathname: '/', search: '', hash: '', assign: vi.fn() };
  vi.stubGlobal('sessionStorage', { getItem: (k: string) => session.get(k) ?? null, setItem: (k: string, v: string) => { session.set(k, v); }, removeItem: (k: string) => { session.delete(k); } });
  vi.stubGlobal('location', location);
  vi.stubGlobal('history', { replaceState });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function connect(scope = GOOGLE_DRIVE_SCOPE) {
  startGoogleDriveConnection('synthetic-client.apps.googleusercontent.com', 'enable');
  const target = new URL(location.assign.mock.calls[0][0] as string);
  location.hash = `#access_token=synthetic-token&token_type=Bearer&expires_in=3600&scope=${encodeURIComponent(scope)}&state=${target.searchParams.get('state')}`;
  return target;
}

describe('Google Drive connection', () => {
  it('asks only for the app data folder and returns to this origin', () => {
    const target = connect();
    expect(`${target.origin}${target.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(target.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive.appdata');
    expect(target.searchParams.get('redirect_uri')).toBe('https://kakeimatch.example/');
    expect(target.searchParams.get('response_type')).toBe('token');
    expect(captureGoogleDriveReturn()).toEqual({ connected: true, intent: 'enable' });
    expect(location.hash).toBe('');
    expect(new GoogleDriveStorage().isConnected()).toBe(true);
  });

  it('ignores a reply without this tab\'s state, and refuses one without the Drive scope', () => {
    location.hash = '#access_token=planted&expires_in=3600&scope=x&state=forged';
    expect(captureGoogleDriveReturn()).toBeNull();
    expect(new GoogleDriveStorage().isConnected()).toBe(false);
    connect('https://www.googleapis.com/auth/userinfo.email');
    expect(captureGoogleDriveReturn()).toEqual({ connected: false, intent: 'enable' });
    expect(new GoogleDriveStorage().isConnected()).toBe(false);
  });
});

describe('Google Drive storage', () => {
  const respond = (status: number, body: unknown) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  beforeEach(() => { connect(); captureGoogleDriveReturn(); });

  it('uploads encrypted chunks to the app data folder under random names', async () => {
    const fetchImpl = vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => respond(200, { id: 'synthetic-file-id-1' }));
    const drive = new GoogleDriveStorage(fetchImpl as unknown as typeof fetch);
    expect(await drive.put(new Blob([new Uint8Array([1, 2, 3])]))).toBe('synthetic-file-id-1');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain('/upload/drive/v3/files?uploadType=multipart');
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer synthetic-token');
    const body = await (init!.body as Blob).text();
    expect(body).toContain('"parents":["appDataFolder"]');
    expect(body).toMatch(/"name":"kakeimatch-sync-[0-9a-f-]{36}"/);
  });

  it('disconnects on an expired token but not on a rate limit, and never treats a missing file as empty', async () => {
    const rateLimited = new GoogleDriveStorage((async () => respond(403, { error: { errors: [{ reason: 'userRateLimitExceeded' }] } })) as unknown as typeof fetch);
    await expect(rateLimited.get('synthetic-file')).rejects.toThrow('google_drive_403');
    expect(rateLimited.isConnected()).toBe(true);
    const missing = new GoogleDriveStorage((async () => respond(404, {})) as unknown as typeof fetch);
    await expect(missing.get('synthetic-file')).rejects.toBeInstanceOf(ExternalStorageMissingError);
    await expect(missing.delete('synthetic-file')).resolves.toBeUndefined();
    const expired = new GoogleDriveStorage((async () => respond(401, {})) as unknown as typeof fetch);
    await expect(expired.get('synthetic-file')).rejects.toBeInstanceOf(ExternalStorageAuthError);
    expect(expired.isConnected()).toBe(false);
  });

  it('lists only this app\'s sync files across pages', async () => {
    const pages = [
      { nextPageToken: 'next', files: [{ id: 'f1', name: 'kakeimatch-sync-a', createdTime: '2026-10-04T00:00:00Z' }, { id: 'f2', name: 'other-file', createdTime: '2026-10-04T00:00:00Z' }] },
      { files: [{ id: 'f3', name: 'kakeimatch-sync-b', createdTime: '2026-10-04T01:00:00Z' }] },
    ];
    const fetchImpl = vi.fn(async () => respond(200, pages.shift()));
    const files = await new GoogleDriveStorage(fetchImpl as unknown as typeof fetch).list();
    expect(files).toEqual([{ ref: 'f1', createdAt: '2026-10-04T00:00:00Z' }, { ref: 'f3', createdAt: '2026-10-04T01:00:00Z' }]);
    expect(String((fetchImpl.mock.calls as unknown[][])[0][0])).toContain('spaces=appDataFolder');
  });
});
