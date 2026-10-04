import { ExternalStorageAuthError, ExternalStorageMissingError, type ExternalSyncStorage } from './device-sync-engine';

// Google Drive as a sync storage location (Issue #143 §1.1, Provider B).
//
// - Scope `drive.appdata` only: files go to the hidden app data folder that this app alone can
//   see. The user never creates folders or picks files, and the app cannot read other files.
// - Only encrypted chunks are uploaded, under random names. No merchant, amount or date.
// - The app uses Cross-Origin-Opener-Policy: same-origin for the household engine, which breaks
//   popup-based sign-in. Google's page is opened in this tab instead, and it returns the access
//   token in the URL fragment (OAuth 2.0 for client-side apps). The token is kept only for this
//   tab session and never sent to KakeiMatch's server. No refresh token exists anywhere.
// See https://developers.google.com/identity/protocols/oauth2/javascript-implicit-flow and
// https://developers.google.com/workspace/drive/api/guides/appdata

export const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id';
const TOKEN_KEY = 'kakeimatch.google-drive-token.v1';
const STATE_KEY = 'kakeimatch.google-drive-oauth.v1';
const FILE_PREFIX = 'kakeimatch-sync-';

type StoredToken = { accessToken: string; expiresAt: number };
/** What the settings screen was doing when it sent the user to Google. */
export type GoogleDriveIntent = 'enable' | 'switch' | 'reconnect';

function session(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  try { return sessionStorage; } catch { return null; }
}

function randomState(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Leaves the app for Google's consent page. Google sends the user back to this origin. */
export function startGoogleDriveConnection(clientId: string, intent: GoogleDriveIntent): void {
  const state = randomState();
  session()?.setItem(STATE_KEY, JSON.stringify({ state, intent }));
  const params = new URLSearchParams({
    client_id: clientId, redirect_uri: `${location.origin}/`, response_type: 'token', scope: GOOGLE_DRIVE_SCOPE,
    state, include_granted_scopes: 'true', prompt: 'select_account',
  });
  location.assign(`${AUTHORIZE_URL}?${params}`);
}

export type GoogleDriveReturn = { connected: true; intent: GoogleDriveIntent } | { connected: false; intent: GoogleDriveIntent | null };

/**
 * Reads Google's reply from the URL fragment once, at startup, and removes it from the address
 * bar. A reply without the state this tab sent is ignored, so another site cannot plant a token.
 */
export function captureGoogleDriveReturn(): GoogleDriveReturn | null {
  if (!location.hash.includes('state=')) return null;
  const reply = new URLSearchParams(location.hash.slice(1));
  const storage = session();
  const raw = storage?.getItem(STATE_KEY);
  let expected: { state: string; intent: GoogleDriveIntent } | null = null;
  try { expected = raw ? JSON.parse(raw) as { state: string; intent: GoogleDriveIntent } : null; } catch { expected = null; }
  if (!expected || reply.get('state') !== expected.state) return null;
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  storage?.removeItem(STATE_KEY);
  const accessToken = reply.get('access_token');
  const expiresIn = Number(reply.get('expires_in'));
  const scopes = (reply.get('scope') ?? '').split(' ');
  if (!accessToken || !Number.isFinite(expiresIn) || !scopes.includes(GOOGLE_DRIVE_SCOPE)) return { connected: false, intent: expected.intent };
  storage?.setItem(TOKEN_KEY, JSON.stringify({ accessToken, expiresAt: Date.now() + Math.max(0, expiresIn - 60) * 1000 } satisfies StoredToken));
  return { connected: true, intent: expected.intent };
}

/** Drive also answers 403 when a rate limit is hit; that is not a reason to disconnect. */
async function isRateLimit(response: Response): Promise<boolean> {
  const body = await response.json().catch(() => null) as { error?: { errors?: Array<{ reason?: unknown }> } } | null;
  return (body?.error?.errors ?? []).some(error => typeof error.reason === 'string' && /rateLimit/i.test(error.reason));
}

export class GoogleDriveStorage implements ExternalSyncStorage {
  readonly name = 'google-drive' as const;

  constructor(private readonly fetchImpl: typeof fetch = (...args) => fetch(...args)) {}

  isConnected(): boolean { return this.token() !== null; }

  /** The connected Google account's email address, for the settings screen only. Not stored. */
  async account(): Promise<string | null> {
    const response = await this.request(`${DRIVE_API}/about?fields=user(emailAddress)`);
    const about = await response.json() as { user?: { emailAddress?: unknown } };
    return typeof about.user?.emailAddress === 'string' ? about.user.emailAddress : null;
  }

  /** Forgets the connection on this device and asks Google to revoke it. Drive files are kept. */
  async disconnect(): Promise<void> {
    const token = this.token();
    session()?.removeItem(TOKEN_KEY);
    if (token) {
      await this.fetchImpl('https://oauth2.googleapis.com/revoke', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: token.accessToken }),
      }).catch(() => undefined);
    }
  }

  async put(chunk: Blob): Promise<string> {
    const boundary = `kakeimatch-${randomState()}`;
    const metadata = JSON.stringify({ name: `${FILE_PREFIX}${crypto.randomUUID()}`, parents: ['appDataFolder'] });
    const body = new Blob([
      `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
      `--${boundary}\r\ncontent-type: application/octet-stream\r\n\r\n`, chunk, `\r\n--${boundary}--`,
    ]);
    const response = await this.request(UPLOAD_API, { method: 'POST', headers: { 'content-type': `multipart/related; boundary=${boundary}` }, body });
    const created = await response.json() as { id?: unknown };
    if (typeof created.id !== 'string' || !/^[A-Za-z0-9_-]{8,200}$/.test(created.id)) throw new Error('google_drive_invalid_response');
    return created.id;
  }

  async get(ref: string): Promise<Blob> {
    return (await this.request(`${DRIVE_API}/files/${encodeURIComponent(ref)}?alt=media`)).blob();
  }

  async delete(ref: string): Promise<void> {
    await this.request(`${DRIVE_API}/files/${encodeURIComponent(ref)}`, { method: 'DELETE' }, true);
  }

  async list(): Promise<Array<{ ref: string; createdAt: string }>> {
    const files: Array<{ ref: string; createdAt: string }> = [];
    let pageToken = '';
    do {
      const params = new URLSearchParams({ spaces: 'appDataFolder', pageSize: '1000', fields: 'nextPageToken,files(id,name,createdTime)', q: `name contains '${FILE_PREFIX}'` });
      if (pageToken) params.set('pageToken', pageToken);
      const page = await (await this.request(`${DRIVE_API}/files?${params}`)).json() as {
        nextPageToken?: string; files?: Array<{ id?: unknown; name?: unknown; createdTime?: unknown }>;
      };
      for (const file of page.files ?? []) {
        if (typeof file.id === 'string' && typeof file.name === 'string' && file.name.startsWith(FILE_PREFIX) && typeof file.createdTime === 'string') {
          files.push({ ref: file.id, createdAt: file.createdTime });
        }
      }
      pageToken = page.nextPageToken ?? '';
    } while (pageToken);
    return files;
  }

  private token(): StoredToken | null {
    const raw = session()?.getItem(TOKEN_KEY);
    if (!raw) return null;
    try {
      const token = JSON.parse(raw) as StoredToken;
      return typeof token.accessToken === 'string' && token.expiresAt > Date.now() ? token : null;
    } catch { return null; }
  }

  /** Calls Drive. An expired or revoked token clears the connection; a missing file is never "empty". */
  private async request(url: string, init: RequestInit = {}, allowMissing = false): Promise<Response> {
    const token = this.token();
    if (!token) throw new ExternalStorageAuthError();
    const response = await this.fetchImpl(url, { ...init, headers: { ...init.headers as Record<string, string>, authorization: `Bearer ${token.accessToken}` } });
    if (response.status === 401 || response.status === 403 && !await isRateLimit(response.clone())) {
      session()?.removeItem(TOKEN_KEY);
      throw new ExternalStorageAuthError();
    }
    if (response.status === 404) {
      if (allowMissing) return response;
      throw new ExternalStorageMissingError();
    }
    if (!response.ok) throw new Error(`google_drive_${response.status}`);
    return response;
  }
}
