const editorListeners = new WeakMap<HTMLElement, AbortController>();

/** Keep one draft and one save action while detail rows open and close. */
export function configureInlineEditor(options: {
  root: HTMLElement;
  fields: HTMLElement[][];
  index: number;
  select: (index: number) => void;
  summaries: () => string[];
}) {
  const { root, fields } = options;
  editorListeners.get(root)?.abort();
  const listeners = new AbortController(); editorListeners.set(root, listeners);
  const signal = listeners.signal;
  const form = root.querySelector<HTMLFormElement>('form')!;
  const footer = document.getElementById(root.dataset.actionsId!)!;
  form.id ||= `inline-form-${crypto.randomUUID()}`;
  const actions = form.querySelector<HTMLElement>('.form-actions')!;
  for (const button of Array.from(actions.querySelectorAll<HTMLButtonElement>('button'))) button.setAttribute('form', form.id);
  const status = form.querySelector<HTMLElement>('.status');
  footer.replaceChildren(...(status ? [status] : []), actions);
  const originalHidden = new Map(Array.from(form.querySelectorAll<HTMLElement>('*')).map(node => [node, node.hidden]));
  const show = (index: number) => {
    for (const [node, hidden] of originalHidden) node.hidden = hidden;
    const controls = fields[index];
    const keep = controls.map(control => control.closest<HTMLElement>('.entry-row') ?? control);
    keep.push(...Array.from(form.querySelectorAll<HTMLLabelElement>('label')).filter(label => controls.some(control => control.id === label.htmlFor)));
    const reveal = (parent: HTMLElement) => {
      for (const child of Array.from(parent.children)) {
        if (!(child instanceof HTMLElement)) continue;
        const selected = keep.some(node => child === node || child.contains(node));
        child.hidden = !selected;
        if (!selected || keep.includes(child)) continue;
        if (child instanceof HTMLDetailsElement) child.open = true;
        reveal(child);
      }
    };
    reveal(form);
    for (const child of Array.from(root.children)) if (child instanceof HTMLElement && child !== form) child.hidden = true;
    root.classList.remove('is-collapsed');
    options.select(index);
  };
  root.addEventListener('inline-select', event => show((event as CustomEvent<number>).detail), { signal });
  root.addEventListener('inline-summary', event => { (event as CustomEvent<{ values?: string[] }>).detail.values = options.summaries(); }, { signal });
  // Invalid fields must be visible for native validation and correction.
  form.addEventListener('invalid', event => {
    event.preventDefault();
    const index = fields.findIndex(controls => controls.some(control => control === event.target || control.contains(event.target as Node)));
    if (index >= 0) root.dispatchEvent(new CustomEvent('inline-invalid', { detail: index }));
  }, { capture: true, signal });
  show(options.index);
  root.dispatchEvent(new CustomEvent('inline-ready', { detail: options.index }));
}
