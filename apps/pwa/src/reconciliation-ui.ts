import type { HomeAttentionCounts } from './home-attention';
import { icon } from './ui-icons';

/* Small pieces of the reconciliation screen (docs/UX.md 照合). */
export function shortDay(date: string) { const [, month, day] = date.split('-'); return `${Number(month)}/${Number(day)}`; }

export function daysBetween(from: string, to: string) {
  const toUtc = (date: string) => { const [year, month, day] = date.split('-').map(Number); return Date.UTC(year, month - 1, day); };
  return Math.round((toUtc(to) - toUtc(from)) / 86_400_000);
}

/** Collapsed row of a statement that needs a decision: status mark, merchant with the reason, and the amount. */
export function reviewSummaryRow(merchant: string, amount: string, tone: 'warning' | 'missing') {
  const element = document.createElement('summary'); element.className = 'review-row';
  const mark = document.createElement('span'); mark.className = `record-icon tone-${tone}`; mark.append(icon(tone === 'warning' ? 'warning' : 'unmatched'));
  const main = document.createElement('span'); main.className = 'record-main';
  const title = document.createElement('span'); title.className = 'record-title'; title.textContent = merchant;
  const note = document.createElement('span'); note.className = `record-note note-${tone}`;
  main.append(title, note);
  const value = document.createElement('span'); value.className = 'record-amount'; value.textContent = amount;
  element.append(mark, main, value);
  return { element, note };
}

/** docs/UX.md 下部ナビ: the reconciliation tab shows how many statements need a decision. */
export function updateReconciliationBadge(counts: HomeAttentionCounts | null) {
  const tab = document.getElementById('reconciliation-tab');
  const badge = document.getElementById('reconciliation-badge');
  if (!tab || !badge) return;
  const total = counts ? counts.needsReview + counts.unmatched + counts.failed : 0;
  badge.textContent = total ? String(total) : '';
  badge.hidden = total === 0;
  if (total) tab.setAttribute('aria-label', `照合（確認が必要 ${total}件）`); else tab.removeAttribute('aria-label');
}
