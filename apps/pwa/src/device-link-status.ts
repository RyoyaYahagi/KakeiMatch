// docs/UX.md 端末間の同期: what this device last did, and whether its household changed since.
// Kept per device in localStorage: it is about this device, so it is not part of a backup.

const LAST_SYNC_KEY = 'kakeimatch.deviceLink.lastSync';
const JUST_RECEIVED_KEY = 'kakeimatch.deviceLink.justReceived';

export type LastSync = {
  at: string;
  peerDevice: string;
  direction: 'sent' | 'received';
  transactions: number;
  latestDate: string | null;
  /** Null right after receiving: the reloaded household becomes the baseline on first look. */
  fingerprint: string | null;
};

export function readLastSync(storage: Pick<Storage, 'getItem'> = localStorage): LastSync | null {
  try {
    const value = JSON.parse(storage.getItem(LAST_SYNC_KEY) ?? 'null') as LastSync | null;
    if (!value || typeof value.at !== 'string' || Number.isNaN(Date.parse(value.at)) || (value.direction !== 'sent' && value.direction !== 'received')) return null;
    return value;
  } catch {
    return null;
  }
}
export function saveLastSync(value: LastSync, storage: Pick<Storage, 'setItem'> = localStorage) {
  try { storage.setItem(LAST_SYNC_KEY, JSON.stringify(value)); } catch { /* The status line simply stays unknown. */ }
}

/** After switching, the page reloads; this lets the reloaded page say what happened. */
export function markJustReceived(message: string) {
  try { sessionStorage.setItem(JUST_RECEIVED_KEY, message); } catch { /* Nothing to show after reload. */ }
}
export function takeJustReceived(): string | null {
  try {
    const value = sessionStorage.getItem(JUST_RECEIVED_KEY);
    sessionStorage.removeItem(JUST_RECEIVED_KEY);
    return value;
  } catch {
    return null;
  }
}

// Japan has a fixed UTC+09:00 offset, so the Tokyo date and time are read from a shifted ISO string.
const tokyo = (iso: string) => new Date(Date.parse(iso) + 9 * 60 * 60 * 1000).toISOString();
const day = (iso: string) => { const value = tokyo(iso); return `${Number(value.slice(5, 7))}月${Number(value.slice(8, 10))}日`; };
const dayTime = (iso: string) => `${day(iso)} ${tokyo(iso).slice(11, 16)}`;

export type SyncState = { kind: 'never' } | { kind: 'same'; last: LastSync } | { kind: 'changed'; last: LastSync };

export function syncState(last: LastSync | null, currentFingerprint: string): SyncState {
  if (!last) return { kind: 'never' };
  return last.fingerprint === null || last.fingerprint === currentFingerprint ? { kind: 'same', last } : { kind: 'changed', last };
}
/** The short text on the settings row. */
export function syncRowText(state: SyncState): string {
  if (state.kind === 'never') return '未同期';
  return state.kind === 'same' ? `${day(state.last.at)}にそろえました` : `${day(state.last.at)}のあと変更あり`;
}
/** The lines at the top of the dialog. */
export function syncDetailText(state: SyncState): string[] {
  if (state.kind === 'never') return ['まだほかの端末と同期していません。'];
  const peer = state.last.peerDevice || '相手の端末';
  const how = state.last.direction === 'sent' ? `${peer}を、この端末の家計簿にそろえました` : `この端末を、${peer}の家計簿にそろえました`;
  return [`最後の同期：${dayTime(state.last.at)}（${how}）`,
    state.kind === 'same' ? 'そのあと、この端末の家計簿は変わっていません。' : 'そのあと、この端末の家計簿が変わっています。もう一度同期すると、2台がそろいます。'];
}
