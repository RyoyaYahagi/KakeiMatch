import { icon } from './ui-icons';

export type HomeAttentionCounts = { needsReview: number; unmatched: number; failed: number };

function span(className: string, value = '') { const node = document.createElement('span'); node.className = className; node.textContent = value; return node; }

/** docs/UX.md ホーム: a warning band only while something needs a decision; a quiet hint before the first import. */
export function renderHomeAttention(target: HTMLElement, counts: HomeAttentionCounts | null, openReconciliation: () => Promise<unknown>) {
  target.replaceChildren();
  const total = counts ? counts.needsReview + counts.unmatched + counts.failed : 0;
  if (counts && total === 0) return;
  const button = document.createElement('button'); button.type = 'button';
  button.addEventListener('click', () => { void openReconciliation(); });
  if (!counts) {
    button.className = 'text-button attention-hint';
    button.append(span('', '明細を取り込んで自動で照合する'), icon('chevronRight'));
  } else {
    button.className = 'attention-banner';
    const badge = span('attention-icon'); badge.append(icon('warning'));
    const detail = [counts.failed ? `反映失敗 ${counts.failed}` : '', counts.needsReview ? `要確認 ${counts.needsReview}` : '', counts.unmatched ? `記録なし ${counts.unmatched}` : ''].filter(Boolean).join(' · ');
    const text = span('attention-text');
    text.append(span('attention-title', `確認が必要な明細 ${total}件`), span('attention-detail', detail));
    button.append(badge, text, icon('chevronRight'));
  }
  target.append(button);
}
