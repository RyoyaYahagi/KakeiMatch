import { icon } from './ui-icons';

export type HomeAttentionCounts = { needsReview: number; unmatched: number; failed: number };
/** One statement on the home "確認すること" box, already worded for the row. */
export type HomeAttentionItem = { merchant: string; amountYen: number; tone: 'danger' | 'warning' | 'missing'; reason: string };

const HOME_ATTENTION_LIMIT = 3;
const yen = (value: number) => `¥${Math.abs(value).toLocaleString('ja-JP')}`;
function span(className: string, value = '') { const node = document.createElement('span'); node.className = className; node.textContent = value; return node; }

/**
 * docs/UX.md ホーム: a box with up to three statements only while something needs a decision,
 * one quiet line for what matched by itself, and a hint before the first import.
 */
export function renderHomeAttention(target: HTMLElement, counts: HomeAttentionCounts | null, items: HomeAttentionItem[], autoMatched: number, openReconciliation: () => Promise<unknown>) {
  target.replaceChildren();
  const open = () => { void openReconciliation(); };
  if (!counts) {
    const hint = document.createElement('button'); hint.type = 'button'; hint.className = 'text-button attention-hint';
    hint.append(span('', '明細を取り込んで自動で照合する'), icon('chevronRight'));
    hint.addEventListener('click', open);
    target.append(hint);
    return;
  }
  const total = counts.needsReview + counts.unmatched + counts.failed;
  if (total) {
    const box = document.createElement('section'); box.className = 'attention-box'; box.setAttribute('aria-labelledby', 'attention-box-title');
    const header = document.createElement('div'); header.className = 'attention-box-header';
    const title = document.createElement('h2'); title.id = 'attention-box-title'; title.append(document.createTextNode('確認すること'));
    const count = span('count-badge', String(total)); count.append(span('visually-hidden', '件')); title.append(count);
    const toReview = document.createElement('button'); toReview.type = 'button'; toReview.className = 'text-button'; toReview.textContent = '照合へ';
    toReview.addEventListener('click', open);
    header.append(title, toReview);
    const list = document.createElement('ul'); list.className = 'record-rows';
    for (const item of items.slice(0, HOME_ATTENTION_LIMIT)) {
      const row = document.createElement('button'); row.type = 'button'; row.className = 'record-row';
      row.setAttribute('aria-label', `${item.merchant} · ${item.reason} · ${yen(item.amountYen)}`);
      const main = span('record-main'); main.append(span('record-title', item.merchant));
      const note = span(`record-note note-${item.tone} state-note`);
      const mark = span(`state-mark tone-${item.tone}`, item.tone === 'warning' ? '△' : '!'); mark.setAttribute('aria-hidden', 'true');
      note.append(mark, document.createTextNode(item.reason)); main.append(note);
      row.append(main, span('record-amount', yen(item.amountYen)));
      row.addEventListener('click', open);
      const entry = document.createElement('li'); entry.append(row); list.append(entry);
    }
    box.append(header, list);
    target.append(box);
  }
  if (autoMatched > 0) {
    const line = document.createElement('p'); line.className = 'auto-matched-line';
    const seal = span('seal', '済'); seal.setAttribute('aria-hidden', 'true');
    const words = span('');
    words.append(document.createTextNode(`${autoMatched}件`), document.createTextNode(' は自動で照合済みです'));
    line.append(seal, words);
    target.append(line);
  }
}
