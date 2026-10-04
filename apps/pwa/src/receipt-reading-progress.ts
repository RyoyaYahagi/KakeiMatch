export type ReadingStep = 'reading' | 'categorizing';

const STEP_LABELS: Record<ReadingStep, string> = { reading: '内容を読み取っています', categorizing: 'カテゴリを提案しています' };
/** A small robot holding a receipt. Its motion follows the step; it is decoration, so screen readers skip it. */
const ROBOT_SVG = `<svg class="reading-robot" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
  <g class="robot-figure">
    <line class="robot-antenna" x1="32" y1="7" x2="32" y2="14"/>
    <circle class="robot-antenna-tip" cx="32" cy="5" r="3"/>
    <rect class="robot-head" x="14" y="13" width="36" height="24" rx="9"/>
    <rect class="robot-face" x="19" y="18" width="26" height="14" rx="6"/>
    <g class="robot-eyes"><circle cx="27" cy="25" r="2.6"/><circle cx="37" cy="25" r="2.6"/></g>
    <rect class="robot-body" x="19" y="38" width="26" height="18" rx="6"/>
    <path class="robot-receipt" d="M21 32h22v25l-2.75-2-2.75 2-2.75-2-2.75 2-2.75-2-2.75 2-2.75-2-2.75 2z"/>
    <rect class="robot-receipt-line" x="25" y="37" width="14" height="2" rx="1"/>
    <rect class="robot-receipt-line" x="25" y="42" width="9" height="2" rx="1"/>
    <rect class="robot-receipt-line" x="25" y="47" width="12" height="2" rx="1"/>
    <circle class="robot-hand" cx="20" cy="45" r="3.4"/><circle class="robot-hand" cx="44" cy="45" r="3.4"/>
  </g>
</svg>`;

/** Most reads finish within this many seconds; after it the panel explains the longer wait. */
export const LONG_READING_SECONDS = 10;

/** Status text for a reading step and the seconds since the read started. */
export function readingStatus(step: ReadingStep, elapsedSeconds: number): { title: string; hint: string } {
  const hint = elapsedSeconds >= LONG_READING_SECONDS
    ? '品目が多いレシートは時間がかかります。このままお待ちください。'
    : '通常5秒ほどかかります。支払元は今のうちに選べます。';
  return { title: `${STEP_LABELS[step]}（${elapsedSeconds}秒）`, hint };
}

/**
 * A live status panel for an AI read: the current step with elapsed seconds and
 * a hint. Screen readers hear the step changes, not every second of the timer.
 */
export function createReadingProgress(now: () => number = Date.now) {
  const panel = document.createElement('div'); panel.className = 'receipt-reading';
  panel.insertAdjacentHTML('afterbegin', ROBOT_SVG);
  const text = document.createElement('div'); text.className = 'receipt-reading-text';
  const title = document.createElement('p'); title.className = 'receipt-reading-title';
  const hint = document.createElement('p'); hint.className = 'receipt-reading-hint';
  const announcer = document.createElement('p'); announcer.className = 'visually-hidden'; announcer.setAttribute('role', 'status');
  text.append(title, hint);
  panel.append(text, announcer);
  const startedAt = now();
  let step: ReadingStep = 'reading';
  const render = () => {
    panel.dataset.step = step;
    const status = readingStatus(step, Math.floor((now() - startedAt) / 1000));
    title.textContent = status.title; hint.textContent = status.hint;
  };
  const timer = setInterval(render, 1000);
  render(); announcer.textContent = STEP_LABELS[step];
  return {
    element: panel,
    setStep(next: ReadingStep) { step = next; render(); announcer.textContent = STEP_LABELS[next]; },
    stop() { clearInterval(timer); panel.remove(); },
  };
}
