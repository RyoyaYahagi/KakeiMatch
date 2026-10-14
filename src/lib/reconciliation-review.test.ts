import { describe, expect, it } from 'vitest';
import { statementAttention } from '../../apps/pwa/src/reconciliation-review';
import type { LocalStatement } from '../../apps/pwa/src/local-reconciliation';
const statement = (id: string, usedDate: string, amountYen: number, patch: Partial<LocalStatement> = {}): LocalStatement => ({
  id, usedDate, amountYen, provider: 'paypay_card', importId: 'synthetic', externalId: null, kind: 'purchase',
  postedDate: null, merchant: id, paymentMethod: null, ...patch,
});
describe('conditional statement attention', () => {
  it('has no blanket warning for normal, refunded, resolved, or first-ever small purchases', () => {
    const rows = [statement('normal', '2026-10-01', 1200), statement('refund', '2026-10-01', 200, { kind: 'refund' }), statement('small', '2026-09-01', 100)];
    expect(statementAttention(rows, new Set(rows.map(row => row.id)))).toEqual([]);
    expect(statementAttention([statement('resolved', '2026-10-01', 200), statement('later', '2026-10-02', 20000)], new Set())).toEqual([]);
  });
  it('requires earlier same-provider history for a new merchant with a small payment', () => {
    const rows = [statement('old', '2026-09-01', 1000), statement('new', '2026-10-01', 500)];
    expect(statementAttention(rows, new Set(['new']))[0].reasons).toEqual(['過去の明細にない加盟店で500円以下の決済']);
    expect(statementAttention(rows.map(row => row.id === 'old' ? { ...row, provider: 'rakuten_card' } : row), new Set(['new']))).toEqual([]);
    expect(statementAttention(rows.map(row => ({ ...row, merchant: 'Same Store' })), new Set(['new']))).toEqual([]);
  });
  it('surfaces a small-to-large sequence only in the same provider within two calendar days', () => {
    const rows = [statement('small', '2026-10-01', 500), statement('large', '2026-10-03', 10000)];
    const result = statementAttention(rows, new Set(['small', 'large']));
    expect(result).toHaveLength(2); expect(result[0].reasons).toContain('500円以下の決済の後、2日以内に1万円以上の決済');
    expect(statementAttention([rows[0], { ...rows[1], provider: 'smbc_card' }], new Set(['small', 'large']))).toEqual([]);
    expect(statementAttention([rows[0], { ...rows[1], usedDate: '2026-10-04' }], new Set(['large']))).toEqual([]);
    expect(statementAttention([{ ...rows[0], amountYen: 501 }, rows[1]], new Set(['large']))).toEqual([]);
  });
  it('uses explicit day-level burst reasons and stable keys that change for new reasons', () => {
    const rows = ['a', 'b', 'c'].map(id => statement(id, '2026-10-01', 1200));
    const result = statementAttention(rows, new Set(['b']));
    expect(result).toEqual([{ statementId: 'b', reasons: ['同じカードで同日に3件以上の決済'], key: expect.any(String) }]);
    expect(statementAttention([...rows].reverse(), new Set(['b']))).toEqual(result);
    expect(statementAttention(rows.slice(0, 2), new Set(['b']))).toEqual([]);
    expect(statementAttention(rows.map(row => row.id === 'c' ? { ...row, provider: 'smbc_card' } : row), new Set(['b']))).toEqual([]);
  });
});
