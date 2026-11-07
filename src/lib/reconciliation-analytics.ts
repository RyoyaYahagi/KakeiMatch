import { z } from 'zod';
import type { ReconciliationCandidate, ReconciliationStatementResult } from './reconciliation-engine';

const item = z.object({ id: z.string(), merchant: z.string(), date: z.string(), amountYen: z.number().int().safe(), paymentSource: z.string() }).strict();
export const reconciliationAnalysisSchema = z.object({
  statements: z.array(item), candidates: z.array(item),
  events: z.array(z.object({ id: z.string(), at: z.iso.datetime(), statementId: z.string(), receiptId: z.string().nullish().transform(value => value ?? null),
    kind: z.enum(['decision', 'rejected', 'undo']), source: z.enum(['user', 'automatic']),
    resolution: z.string().nullish().transform(value => value ?? null), status: z.string().nullish().transform(value => value ?? null), errorCode: z.string().nullish().transform(value => value ?? null) }).strict()),
}).strict();
export type ReconciliationAnalysis = z.infer<typeof reconciliationAnalysisSchema>;
export type AnalysisEvent = ReconciliationAnalysis['events'][number];
export type AnalysisRun = { runId: string; completedAt: string; ruleVersion: string; candidates: ReconciliationCandidate[];
  statementResults: ReconciliationStatementResult[]; analysis?: ReconciliationAnalysis };

/** One latest observation and active decision per statement; reruns and retries are not new samples. */
export function summarizeReconciliation(runs: AnalysisRun[]) {
  const observations = new Map<string, ReconciliationStatementResult>();
  const decisions = new Map<string, { event: AnalysisEvent; run: AnalysisRun }>();
  const ordered = [...runs].sort((a,b) => a.completedAt.localeCompare(b.completedAt) || a.runId.localeCompare(b.runId));
  const events = ordered.flatMap(run => (run.analysis?.events ?? []).map(event => ({ event, run })));
  for (const run of ordered) {
    for (const row of run.statementResults) if (!row.reasonCodes.includes('refund_not_supported')) observations.set(row.statementTransactionId, row);
  }
  events.sort((a,b) => a.event.at.localeCompare(b.event.at));
  // Array order preserves processing -> terminal transitions even on equal timestamps.
  const active = events.filter(({event}) => event.kind !== 'rejected');
  for (const row of active) {
    if (row.event.kind === 'undo') decisions.delete(row.event.statementId);
    else decisions.set(row.event.statementId, row);
  }
  const manual = [...decisions.values()].filter(({event}) => event.source === 'user' && event.resolution === 'same_expense' && event.status === 'applied');
  const first = manual.filter(({event,run}) => run.candidates.some(c => c.statementTransactionId === event.statementId && c.receiptId === event.receiptId && c.rank === 1)).length;
  const known = manual.filter(({event,run}) => run.candidates.some(c => c.statementTransactionId === event.statementId && c.receiptId === event.receiptId)).length;
  const total = observations.size;
  const noCandidates = [...observations.values()].filter(row => row.status === 'unmatched_statement').length;
  const rejected = new Set(events.filter(({event}) => event.kind === 'rejected').map(({event,run}) => `${run.runId}\0${event.statementId}\0${event.receiptId}`)).size;
  const terminal = [...decisions.values()].filter(({event}) => event.resolution !== 'ignored' && (event.status === 'applied' || event.status === 'failed'));
  const failed = terminal.filter(({event}) => event.status === 'failed').length;
  return { runs: runs.length, recordedRuns: runs.filter(run => run.analysis).length, statements: total, noCandidates,
    noCandidateRate: total ? noCandidates / total : null, manualMatches: known, firstChoices: first,
    firstChoiceRate: known ? first / known : null, rejected, terminalDecisions: terminal.length, failed,
    failureRate: terminal.length ? failed / terminal.length : null };
}

/** Allowlist export. Anonymous mode removes contents and replaces identifiers per export. */
export function exportReconciliationAnalysis(runs: AnalysisRun[], detailed: boolean, exportedAt: string) {
  const ids = new Map<string,string>();
  const id = (value: string | null): string | null => {
    if (value === null || detailed) return value;
    if (!ids.has(value)) ids.set(value, `item-${ids.size + 1}`);
    return ids.get(value)!;
  };
  return { schemaVersion: 1, mode: detailed ? 'detailed' : 'anonymous', exportedAt, summary: summarizeReconciliation(runs),
    runs: runs.map(run => ({ runId: id(run.runId), completedAt: run.completedAt, ruleVersion: run.ruleVersion,
      statements: run.statementResults.map(row => ({ statementId: id(row.statementTransactionId), status: row.status })),
      candidates: run.candidates.map(c => ({ statementId: id(c.statementTransactionId), receiptId: id(c.receiptId), rank: c.rank,
        score: c.score, amountDeltaYen: c.amountDeltaYen, dateDistanceDays: c.dateDistanceDays,
        merchantSimilarity: c.merchantSimilarity, reasons: c.reasons })),
      contents: detailed ? run.analysis && { statements: run.analysis.statements, candidates: run.analysis.candidates } : undefined,
      events: run.analysis?.events.map(e => ({ ...e, id: id(e.id), statementId: id(e.statementId), receiptId: id(e.receiptId) })),
    })) };
}
