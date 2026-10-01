import { describe, it, expect } from 'vitest';
import { shiftMonth, monthEnd } from '../../apps/pwa/src/local-monthly-dashboard';
describe('dashboard calendar months', () => {
  it('crosses calendar years and handles Gregorian leap years without timezone conversion', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(monthEnd('2024-02')).toBe('2024-02-29');
    expect(monthEnd('2100-02')).toBe('2100-02-28');
    expect(monthEnd('2000-02')).toBe('2000-02-29');
    expect(shiftMonth('0001-01', -1)).toBe('0001-01');
    expect(shiftMonth('9999-12', 1)).toBe('9999-12');
  });
});
