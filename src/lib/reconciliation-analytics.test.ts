import { describe, expect, it } from 'vitest';
import { exportReconciliationAnalysis, summarizeReconciliation, type AnalysisRun, type AnalysisEvent } from './reconciliation-analytics';
const at = '2026-11-07T00:00:00.000Z';
const event = (patch: Partial<AnalysisEvent> = {}): AnalysisEvent => ({ id: 'event', at, statementId: 'private-statement', receiptId: 'private-receipt', kind: 'decision', source: 'user', resolution: 'same_expense', status: 'applied', errorCode: null, ...patch });
const run = (events: AnalysisEvent[] = []): AnalysisRun => ({ runId: 'private-run', ruleVersion: '1.2.0', completedAt: at,
  statementResults: [{ statementTransactionId: 'private-statement', status: 'needs_review', matchedReceiptId: null, reasonCodes: [] }],
  candidates: [{ statementTransactionId: 'private-statement', receiptId: 'private-receipt', rank: 1, score: 0.8, amountDeltaYen: 20, dateDistanceDays: 1, merchantSimilarity: 0.5, reasons: ['amount_close'] }],
  analysis: { statements: [{ id: 'private-statement', merchant: '秘密の店舗', date: '2026-11-01', amountYen: 12345, paymentSource: '秘密のカード' }],
    candidates: [{ id: 'private-receipt', merchant: '秘密の店舗', date: '2026-10-31', amountYen: 12325, paymentSource: '秘密のカード' }], events } });

describe('reconciliation analysis', () => {
  it('keeps unreviewed and automatic outcomes out of the manual denominator', () => {
    expect(summarizeReconciliation([run()]).firstChoiceRate).toBeNull();
    expect(summarizeReconciliation([run([event({ source: 'automatic' })])]).manualMatches).toBe(0);
    expect(summarizeReconciliation([run([event()])])).toMatchObject({ manualMatches: 1, firstChoices: 1, firstChoiceRate: 1 });
  });
  it('deduplicates reruns, retries and rejections and removes undone judgments', () => {
    const r = run([event({ status: 'processing' }), event({ status: 'failed' }), event(), event({ kind: 'rejected' }), event({ kind: 'rejected' }), event({ kind: 'undo' })]);
    expect(summarizeReconciliation([r, { ...run(), runId: 'rerun' }])).toMatchObject({ statements: 1, rejected: 1, manualMatches: 0, failed: 0, terminalDecisions: 0 });
    expect(r.analysis?.events).toHaveLength(6);
  });
  it('counts final failure states rather than treating errors or missing candidates as false matches', () => {
    expect(summarizeReconciliation([run([event({ resolution: 'ignored' })])]).terminalDecisions).toBe(0);
    expect(summarizeReconciliation([run([event({status:'failed'})])])).toMatchObject({ failed: 1, failureRate: 1, manualMatches: 0 });
    const r = run(); r.statementResults[0].status = 'unmatched_statement';
    expect(summarizeReconciliation([r])).toMatchObject({ noCandidateRate: 1, firstChoiceRate: null });
  });
  it('exports detailed snapshots but removes original IDs and transaction contents in anonymous mode', () => {
    const r = run([event()]);
    const anonymous = JSON.stringify(exportReconciliationAnalysis([r], false, at));
    for (const value of ['秘密', 'private-', '12345', '12325', '2026-11-01', '2026-10-31']) expect(anonymous).not.toContain(value);
    expect(JSON.stringify(exportReconciliationAnalysis([r], true, at))).toContain('秘密の店舗');
    expect(exportReconciliationAnalysis([r], false, at).runs[0].candidates[0].statementId).toBe(exportReconciliationAnalysis([r], false, at).runs[0].statements[0].statementId);
  });
});
