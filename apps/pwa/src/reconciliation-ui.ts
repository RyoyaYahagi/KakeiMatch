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

type SlipField = { label: string; value: string; same?: boolean; differs?: boolean };

/** docs/DESIGN.md 突き合わせの伝票: one half of the slip, with where it came from and date / shop / amount. */
export function slipPart(kind: 'statement' | 'record', source: string, fields: SlipField[]) {
  const part = document.createElement('div'); part.className = `slip-part slip-${kind}`;
  const head = document.createElement('div'); head.className = 'slip-source';
  const name = document.createElement('span'); name.textContent = kind === 'statement' ? 'カード明細' : 'あなたの記録';
  const from = document.createElement('span'); from.textContent = source;
  head.append(name, from);
  const list = document.createElement('dl');
  for (const field of fields) {
    const term = document.createElement('dt'); term.textContent = field.label;
    const value = document.createElement('dd'); value.textContent = field.value;
    if (field.differs) value.classList.add('slip-differs');
    if (field.same) { const same = document.createElement('span'); same.className = 'slip-same'; same.textContent = '同じ'; value.append(same); }
    list.append(term, value);
  }
  part.append(head, list);
  return part;
}

/** The perforation between the statement and a record on the slip. */
export function slipPerforation() {
  const line = document.createElement('div'); line.className = 'slip-perforation'; line.setAttribute('aria-hidden', 'true');
  return line;
}

/** The large "済" seal pressed on the slip when the pair is accepted. */
export function slipSeal() {
  const seal = document.createElement('div'); seal.className = 'slip-seal'; seal.setAttribute('aria-hidden', 'true');
  const mark = document.createElement('span'); mark.textContent = '済';
  const word = document.createElement('small'); word.textContent = '照合';
  seal.append(mark, word);
  return seal;
}
