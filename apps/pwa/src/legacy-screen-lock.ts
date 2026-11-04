// The PWA no longer offers a screen lock. Older versions kept the PIN hash,
// recovery hash, and optional biometric credential in localStorage. They are
// deleted at startup so the unused secrets do not stay on the device and no
// stale configuration can block the household UI from opening.
const LEGACY_SCREEN_LOCK_KEYS = [
  'kakeimatch.screen-lock.v1',
  'kakeimatch.screen-lock.v1.attempts',
  'kakeimatch.screen-lock.v1.event',
] as const;

type RemovableStorage = Pick<Storage, 'removeItem'>;

/**
 * Best-effort cleanup. A storage that is blocked or throws must not stop the app
 * from starting, so every failure is ignored.
 */
export function removeLegacyScreenLockData(storage?: RemovableStorage): void {
  let target: RemovableStorage | null = storage ?? null;
  if (!target && typeof window !== 'undefined') {
    try { target = window.localStorage; } catch { return; }
  }
  if (!target) return;
  for (const key of LEGACY_SCREEN_LOCK_KEYS) {
    try { target.removeItem(key); } catch { /* Keep starting without the cleanup. */ }
  }
}
