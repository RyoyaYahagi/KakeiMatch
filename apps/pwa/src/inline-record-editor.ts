/** Keep the existing editor's validation, drafts and save recovery inside a detail row. */
export function showInlineFields(root: HTMLElement, controls: HTMLElement[], cancel: HTMLButtonElement) {
  root.classList.add('inline-record-editor');
  const form = root.querySelector('form');
  if (!form) return;
  const fields = controls.map(control => control.closest<HTMLElement>('.entry-row') ?? control);
  const labels = controls.flatMap(control => control.id ? Array.from(root.querySelectorAll<HTMLLabelElement>('label')).filter(label => label.htmlFor === control.id) : []);
  const keep = [...fields, ...labels, ...Array.from(form.querySelectorAll<HTMLElement>('.form-actions, .status, [role="status"]'))];
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
  const actions = form.querySelector('.form-actions');
  cancel.hidden = false;
  cancel.className = 'text-button';
  actions?.prepend(cancel);
}
