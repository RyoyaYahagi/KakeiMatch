/** Dismiss only a tap that starts and ends outside the dialog, never its padding or a drag from inside. */
export function dismissOnBackdrop(dialog: HTMLDialogElement, dismiss: () => void) {
  let startedOutside = false;
  const outside = (event: MouseEvent) => {
    const rect = dialog.getBoundingClientRect();
    return event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right
      || event.clientY < rect.top || event.clientY > rect.bottom);
  };
  dialog.addEventListener('pointerdown', event => { startedOutside = outside(event); });
  dialog.addEventListener('pointercancel', () => { startedOutside = false; });
  dialog.addEventListener('close', () => { startedOutside = false; });
  dialog.addEventListener('click', event => {
    const shouldDismiss = startedOutside && outside(event);
    startedOutside = false;
    if (shouldDismiss) dismiss();
  });
}
