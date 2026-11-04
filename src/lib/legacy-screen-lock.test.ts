import { describe, expect, it, vi } from 'vitest';
import { removeLegacyScreenLockData } from '../../apps/pwa/src/legacy-screen-lock';

describe('legacy screen lock cleanup', () => {
  it('removes the lock keys and keeps unrelated device settings', () => {
    const values = new Map<string, string>([
      ['kakeimatch.screen-lock.v1', '{"pinHash":"synthetic"}'],
      ['kakeimatch.screen-lock.v1.attempts', '{"failedAttempts":5}'],
      ['kakeimatch.screen-lock.v1.event', '{"type":"lock"}'],
      ['kakeimatch.local-profile.v1', '00000000-0000-4000-8000-000000000001'],
    ]);
    removeLegacyScreenLockData({ removeItem: key => { values.delete(key); } });
    expect([...values.keys()]).toEqual(['kakeimatch.local-profile.v1']);
  });

  it('does not throw when storage refuses removal', () => {
    const removeItem = vi.fn(() => { throw new DOMException('denied', 'SecurityError'); });
    expect(() => removeLegacyScreenLockData({ removeItem })).not.toThrow();
    expect(removeItem).toHaveBeenCalledTimes(3);
  });

  it('does not throw when localStorage is unavailable', () => {
    expect(() => removeLegacyScreenLockData()).not.toThrow();
  });
});
