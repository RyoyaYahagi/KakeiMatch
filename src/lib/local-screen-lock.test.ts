import { describe, expect, it } from 'vitest';
import { createLocalScreenLock, verifyLocalScreenLockPin, verifyLocalScreenLockRecovery } from '../../apps/pwa/src/local-screen-lock';

describe('local screen lock credentials', () => {
  it('stores distinct salted hashes and verifies PIN and recovery code offline', async () => {
    const config = await createLocalScreenLock('246810', 'ABCDE-FGHIJ-KLMNO-PQRST');
    expect(JSON.stringify(config)).not.toContain('246810');
    expect(JSON.stringify(config)).not.toContain('ABCDEFGHIJKLMNOPQRST');
    expect(await verifyLocalScreenLockPin(config, '246810')).toBe(true);
    expect(await verifyLocalScreenLockPin(config, '000000')).toBe(false);
    expect(await verifyLocalScreenLockRecovery(config, 'abcde-fghij-klmno-pqrst')).toBe(true);
    expect(await verifyLocalScreenLockRecovery(config, 'ABCDE-FGHIJ-KLMNO-XXXXX')).toBe(false);
  });

  it('rejects PINs outside the six digit contract', async () => {
    await expect(createLocalScreenLock('12345', 'ABCDE-FGHIJ-KLMNO-PQRST')).rejects.toThrow('数字6桁');
  });
});
