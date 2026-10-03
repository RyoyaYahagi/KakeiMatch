import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearLocalDiagnostics, getLocalDiagnosticReport, localDiagnosticReportSchema, recordLocalDiagnostic } from '../../apps/pwa/src/local-diagnostics';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-03T00:00:00Z')); clearLocalDiagnostics(); });
afterEach(() => vi.useRealTimers());
const report = () => getLocalDiagnosticReport('c62ab8e12345', false);

describe('端末内診断の許可リスト', () => {
  it('家計内容・secret・エラー文・未知のコードを取り込まない', () => {
    const secret = 'synthetic-private-merchant-token';
    recordLocalDiagnostic('ai', { code: 'auth_required', message: secret, token: secret, merchant: secret, stack: secret });
    recordLocalDiagnostic('save', { code: secret, amount: 4567, cause: { token: secret } });
    recordLocalDiagnostic('runtime', new Error(secret));
    expect(report().entries.map(entry => entry.code)).toEqual(['auth_required', 'operation_failed', 'operation_failed']);
    expect(JSON.stringify(report())).not.toContain(secret);
    expect(JSON.stringify(report())).not.toContain('4567');
  });
  it('code getterやproxyを実行して値を収集しない', () => {
    const getter = vi.fn(() => { throw new Error('secret'); });
    recordLocalDiagnostic('runtime', Object.defineProperty({}, 'code', { get: getter }));
    recordLocalDiagnostic('runtime', new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error('secret'); } }));
    expect(getter).not.toHaveBeenCalled();
    expect(report().entries.every(entry => entry.code === 'operation_failed')).toBe(true);
  });
  it('未知の項目や自由入力をschemaが拒否する', () => {
    recordLocalDiagnostic('backup');
    const valid = report();
    expect(localDiagnosticReportSchema.safeParse(valid).success).toBe(true);
    expect(localDiagnosticReportSchema.safeParse({ ...valid, token: 'synthetic-secret' }).success).toBe(false);
    expect(localDiagnosticReportSchema.safeParse({ ...valid, entries: [{ ...valid.entries[0], message: 'synthetic-store' }] }).success).toBe(false);
    expect(localDiagnosticReportSchema.safeParse({ ...valid, entries: [{ ...valid.entries[0], feature: 'synthetic-input' }] }).success).toBe(false);
    expect(localDiagnosticReportSchema.safeParse({ ...valid, build: 'https://example.invalid/?token=secret' }).success).toBe(false);
  });
  it('失敗にokを偽装できず、未定義のエラーも失敗として残る', () => {
    recordLocalDiagnostic('restore', { code: 'ok' });
    recordLocalDiagnostic('backup', undefined);
    expect(report().entries.map(entry => [entry.outcome, entry.code])).toEqual([['failure', 'operation_failed'], ['failure', 'operation_failed']]);
  });
  it('起動・保存・AI・移行・バックアップ・復元の結果を区別する', () => {
    recordLocalDiagnostic('startup'); recordLocalDiagnostic('save', { code: 'actual_write_uncertain' });
    recordLocalDiagnostic('ai', { code: 'invalid_ai_response' }); recordLocalDiagnostic('migration', { code: 'future_schema' });
    recordLocalDiagnostic('backup'); recordLocalDiagnostic('restore', { code: 'invalid_input' });
    expect(report().entries.map(entry => entry.feature)).toEqual(['startup', 'save', 'ai', 'migration', 'backup', 'restore']);
    expect(report().network).toBe('offline');
  });
  it('40件・15分の上限と明示消去を守る', () => {
    for (let i = 0; i < 45; i++) recordLocalDiagnostic('save');
    expect(report().entries).toHaveLength(40);
    vi.advanceTimersByTime(900_001);
    expect(report().entries).toEqual([]);
    recordLocalDiagnostic('startup'); clearLocalDiagnostics();
    expect(report().entries).toEqual([]);
  });
});
