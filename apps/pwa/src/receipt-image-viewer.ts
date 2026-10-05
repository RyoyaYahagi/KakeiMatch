import { icon } from './ui-icons';

/** How far a tap zooms into the photo, relative to fitting the screen width. Pinch zoom keeps working on top of it. */
export const RECEIPT_ZOOM = 2.5;

/**
 * Scroll offsets that bring the tapped point of the photo to the middle of the screen
 * after zooming. `tap` is measured from the photo's top-left corner before zooming.
 */
export function zoomScroll(tap: { x: number; y: number }, scale: number, viewport: { width: number; height: number }) {
  return { left: Math.max(0, Math.round(tap.x * scale - viewport.width / 2)), top: Math.max(0, Math.round(tap.y * scale - viewport.height / 2)) };
}

/** Opens the receipt photo full screen. A tap zooms into that spot and another tap fits it again. */
export function openReceiptImage(src: string) {
  const viewer = document.createElement('dialog'); viewer.className = 'receipt-image-viewer'; viewer.setAttribute('aria-label', 'レシート画像');
  const header = document.createElement('div'); header.className = 'receipt-image-viewer-header';
  const hint = document.createElement('p'); hint.className = 'receipt-image-viewer-hint'; hint.textContent = 'タップした所を拡大します。もう一度タップすると戻ります。';
  const close = document.createElement('button'); close.type = 'button'; close.className = 'icon-button'; close.setAttribute('aria-label', '閉じる'); close.append(icon('close'));
  header.append(hint, close);
  const stage = document.createElement('div'); stage.className = 'receipt-image-viewer-stage';
  const image = document.createElement('img'); image.src = src; image.alt = '保存したレシート（拡大表示）';
  stage.append(image);
  viewer.append(header, stage);
  let zoomed = false;
  image.addEventListener('click', event => {
    if (zoomed) { zoomed = false; image.style.width = ''; stage.scrollTo({ left: 0, top: 0 }); }
    else {
      const fitted = image.getBoundingClientRect();
      const tap = { x: event.clientX - fitted.left, y: event.clientY - fitted.top };
      zoomed = true; image.style.width = `${RECEIPT_ZOOM * 100}%`;
      const scale = image.getBoundingClientRect().width / fitted.width;
      stage.scrollTo(zoomScroll(tap, scale, { width: stage.clientWidth, height: stage.clientHeight }));
    }
    viewer.classList.toggle('is-zoomed', zoomed);
  });
  close.addEventListener('click', () => viewer.close());
  viewer.addEventListener('close', () => viewer.remove());
  document.body.append(viewer);
  viewer.showModal();
  close.focus();
  return viewer;
}
