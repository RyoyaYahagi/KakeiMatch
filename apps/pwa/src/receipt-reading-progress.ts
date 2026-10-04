export type ReadingStep = 'reading' | 'categorizing';

const STEP_LABELS: Record<ReadingStep, string> = { reading: '内容を読み取っています', categorizing: 'カテゴリを提案しています' };
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
  const title = document.createElement('p'); title.className = 'receipt-reading-title';
  const hint = document.createElement('p'); hint.className = 'receipt-reading-hint';
  const announcer = document.createElement('p'); announcer.className = 'visually-hidden'; announcer.setAttribute('role', 'status');
  panel.append(title, hint, announcer);
  const startedAt = now();
  let step: ReadingStep = 'reading';
  const render = () => {
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
