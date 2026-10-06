export type ReadingStep = 'reading' | 'categorizing';

/** Most reads finish within this many seconds; after it the step explains the longer wait. */
export const LONG_READING_SECONDS = 10;

type StepState = 'done' | 'now' | 'todo' | 'failed';
type StepText = { title: string; note: string };

/** docs/DESIGN.md 読み取り中: the words of each step in each state. */
export function readingStepText(step: 'saved' | ReadingStep, state: StepState, elapsedSeconds = 0): StepText {
  if (step === 'saved') return { title: '写真を保存しました', note: 'この端末に。読み取れなくても消えません' };
  if (step === 'reading') {
    if (state === 'done') return { title: '文字を読み取りました', note: '' };
    if (state === 'failed') return { title: '読み取れませんでした', note: '写真は残っています' };
    return { title: '文字を読み取っています', note: elapsedSeconds >= LONG_READING_SECONDS ? '品目が多いレシートは時間がかかります' : '10秒ほどかかります' };
  }
  return { title: state === 'now' ? '品目をカテゴリに分けています' : '品目をカテゴリに分けます', note: '' };
}

/**
 * The steps of an AI read as ledger rows: done, in progress, and still to come.
 * Screen readers hear when the step changes.
 */
export function createReadingProgress(now: () => number = Date.now) {
  const list = document.createElement('ol'); list.className = 'reading-steps';
  const announcer = document.createElement('p'); announcer.className = 'visually-hidden'; announcer.setAttribute('role', 'status');
  const rows = (['saved', 'reading', 'categorizing'] as const).map(step => {
    const row = document.createElement('li'); row.dataset.readingStep = step;
    const mark = document.createElement('span'); mark.className = 'reading-step-mark'; mark.setAttribute('aria-hidden', 'true');
    const words = document.createElement('span'); words.className = 'reading-step-words';
    const title = document.createElement('span'); const note = document.createElement('small');
    words.append(title, note); row.append(mark, words); list.append(row);
    return { step, row, mark, title, note };
  });
  const element = document.createElement('div'); element.className = 'receipt-reading'; element.append(list, announcer);
  const startedAt = now();
  let current: ReadingStep | 'failed' = 'reading';
  const stateOf = (step: 'saved' | ReadingStep): StepState => {
    if (step === 'saved') return 'done';
    if (current === 'failed') return step === 'reading' ? 'failed' : 'todo';
    if (step === current) return 'now';
    return step === 'reading' ? 'done' : 'todo';
  };
  const render = () => {
    element.dataset.step = current;
    const elapsed = Math.floor((now() - startedAt) / 1000);
    for (const row of rows) {
      const state = stateOf(row.step);
      const text = readingStepText(row.step, state, elapsed);
      row.row.className = `reading-step is-${state}`;
      row.mark.textContent = state === 'done' ? '✓' : state === 'failed' ? '!' : '';
      row.title.textContent = text.title; row.note.textContent = text.note; row.note.hidden = !text.note;
    }
  };
  const timer = setInterval(render, 1000);
  const announce = () => { announcer.textContent = rows.find(row => stateOf(row.step) === 'now' || stateOf(row.step) === 'failed')?.title.textContent ?? ''; };
  render(); announce();
  return {
    element,
    setStep(next: ReadingStep) { current = next; render(); announce(); },
    fail() { current = 'failed'; clearInterval(timer); render(); announce(); },
    stop() { clearInterval(timer); element.remove(); },
  };
}
