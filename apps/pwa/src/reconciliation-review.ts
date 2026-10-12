import { normalizeReconciliationMerchant } from '../../../src/lib/reconciliation-engine';
import type { LocalStatement } from './local-reconciliation';

export type SuspectedUse = { statementId: string; markedAt: string };
export const suspectedUseId = (id: string) => `settings:reconciliation-suspected:${id}`;
export const manualReviewId = (id: string) => `settings:reconciliation-manual:${id}`;
export const attentionAcknowledgementId = 'settings:reconciliation-attention';

export type StatementAttention = { statementId: string; reasons: string[]; key: string };
/** Conservative, explainable patterns using only information actually present in the CSV.
 * Small = 1–500 yen. A burst = at least 3 purchases on one calendar day for one provider.
 * A small payment followed within 2 calendar days by >=10,000 yen is also surfaced.
 * Only statements still awaiting a user decision (or explicitly marked) are returned.
 */
export function statementAttention(statements: LocalStatement[], unresolvedIds: ReadonlySet<string>): StatementAttention[] {
  const purchases = statements.filter(row => row.kind === 'purchase' && row.amountYen > 0);
  type History = { firstDate: string; merchantDates: Map<string, string>; dayCounts: Map<string, number>; smallDates: Set<string>; largeDates: Set<string> };
  const histories = new Map<string, History>();
  const providerKey = (row: LocalStatement) => row.provider === 'paypay' ? 'paypay_card' : row.provider;
  const isSmall = (row: LocalStatement) => row.amountYen <= 500;
  for (const row of purchases) {
    const history = histories.get(providerKey(row)) ?? { firstDate: row.usedDate, merchantDates: new Map(), dayCounts: new Map(), smallDates: new Set(), largeDates: new Set() };
    const merchant = normalizeReconciliationMerchant(row.merchant);
    history.firstDate = history.firstDate < row.usedDate ? history.firstDate : row.usedDate;
    const previous = history.merchantDates.get(merchant);
    history.merchantDates.set(merchant, previous && previous < row.usedDate ? previous : row.usedDate);
    history.dayCounts.set(row.usedDate, (history.dayCounts.get(row.usedDate) ?? 0) + 1);
    if (isSmall(row)) history.smallDates.add(row.usedDate);
    if (row.amountYen >= 10_000) history.largeDates.add(row.usedDate);
    histories.set(providerKey(row), history);
  }
  const shiftDay = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  return purchases.filter(row => unresolvedIds.has(row.id)).flatMap(row => {
    const history = histories.get(providerKey(row))!;
    const reasons: string[] = [];
    // A first-seen merchant needs earlier history for the same provider to compare with.
    if (isSmall(row) && history.firstDate < row.usedDate && history.merchantDates.get(normalizeReconciliationMerchant(row.merchant)) === row.usedDate) {
      reasons.push('過去の明細にない加盟店で500円以下の決済');
    }
    const sequence = [1, 2].some(days => isSmall(row) ? history.largeDates.has(shiftDay(row.usedDate, days))
      : row.amountYen >= 10_000 && history.smallDates.has(shiftDay(row.usedDate, -days)));
    if (sequence) reasons.push('500円以下の決済の後、2日以内に1万円以上の決済');
    if ((history.dayCounts.get(row.usedDate) ?? 0) >= 3) reasons.push('同じカードで同日に3件以上の決済');
    return reasons.length ? [{ statementId: row.id, reasons, key: JSON.stringify([row.id, reasons]) }] : [];
  });
}
