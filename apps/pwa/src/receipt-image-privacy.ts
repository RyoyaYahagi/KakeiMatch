import { createWorker, PSM } from 'tesseract.js';
import { privateReceiptRegions, type ReceiptMask } from '../../../src/lib/receipt-privacy';

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('Cancelled', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}
function cancelled(signal: AbortSignal) { signal.throwIfAborted(); }
function applyMasks(context: CanvasRenderingContext2D, masks: ReceiptMask[]) {
  context.fillStyle = '#000';
  for (const mask of masks) context.fillRect(mask.x, mask.y, mask.width, mask.height);
}

function detectCodes(canvas: HTMLCanvasElement, signal: AbortSignal): Promise<ReceiptMask[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./receipt-code-worker.ts', import.meta.url), { type: 'module' });
    const cleanup = () => { signal.removeEventListener('abort', abort); worker.terminate(); };
    const abort = () => { cleanup(); reject(new DOMException('Cancelled', 'AbortError')); };
    worker.onmessage = event => { cleanup(); resolve(event.data); };
    worker.onerror = () => { cleanup(); reject(new Error('code_detection_failed')); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    const pixels = canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, canvas.width, canvas.height);
    worker.postMessage({ pixels: pixels.data, width: pixels.width, height: pixels.height }, [pixels.data.buffer]);
  });
}

async function detect(canvas: HTMLCanvasElement, signal: AbortSignal, onMasks: (masks: ReceiptMask[]) => void): Promise<{ failed: boolean }> {
  const deadline = new AbortController();
  const cancelDetection = () => deadline.abort();
  signal.addEventListener('abort', cancelDetection, { once: true });
  if (signal.aborted) deadline.abort();
  const timer = setTimeout(cancelDetection, 25_000);
  const detectionSignal = deadline.signal;
  let worker: Awaited<ReturnType<typeof createWorker>> | undefined;
  const stop = () => { if (worker) void worker.terminate(); };
  detectionSignal.addEventListener('abort', stop, { once: true });
  try {
    // Codes and text run concurrently in dedicated workers, keeping touch input responsive.
    const codes = detectCodes(canvas, detectionSignal).then(onMasks);
    const text = (async () => {
      const initializing = createWorker(['jpn', 'eng'], 1, {
        workerPath: '/receipt-ocr/worker.min.js', corePath: '/receipt-ocr', langPath: '/receipt-ocr',
        workerBlobURL: false, cacheMethod: 'none', logger: () => {}, errorHandler: () => {},
      });
      void initializing.then(created => { if (detectionSignal.aborted) void created.terminate(); }, () => {});
      worker = await abortable(initializing, detectionSignal);
      cancelled(detectionSignal);
      await abortable(worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT }), detectionSignal);
      const { data } = await abortable(worker.recognize(canvas, {}, { blocks: true, text: false }), detectionSignal);
      cancelled(detectionSignal);
      onMasks(privateReceiptRegions((data.blocks ?? []).flatMap(block => block.paragraphs.flatMap(paragraph => paragraph.lines))));
    })();
    const results = await Promise.allSettled([codes, text]);
    cancelled(signal);
    return { failed: results.some(result => result.status === 'rejected') };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancelDetection);
    detectionSignal.removeEventListener('abort', stop);
    if (worker) await worker.terminate();
  }
}

/** Only this freshly rasterized, reviewed copy is allowed across the AI boundary. */
export async function prepareReceiptImage(file: Blob, signal: AbortSignal): Promise<Blob> {
  cancelled(signal);
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  // Bound mobile memory while retaining legibility; rasterizing also removes EXIF metadata.
  const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
  canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d')!;
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
  const original = document.createElement('canvas'); original.width = canvas.width; original.height = canvas.height;
  original.getContext('2d')!.drawImage(canvas, 0, 0);
  try {
    const masks: ReceiptMask[] = [];
    cancelled(signal);
    return await new Promise<Blob>((resolve, reject) => {
      const dialog = document.createElement('dialog'); dialog.className = 'receipt-privacy-dialog';
      const title = document.createElement('h2'); title.textContent = '送信する写真を確認'; title.id = 'receipt-privacy-title'; dialog.setAttribute('aria-labelledby', title.id);
      const help = document.createElement('p'); help.textContent = `氏名・電話・住所・会員番号・カード番号・口座番号・QRコード・バーコードが残っていないか確認してください。店名・日付・商品・金額は残してください。`;
      const status = document.createElement('p'); status.setAttribute('role', 'status'); status.textContent = '個人情報を探しています…';
      const hint = document.createElement('p'); const maskHint = '隠す範囲を写真の上でなぞって追加できます。誤って隠した場合は「1つ戻す」で戻せます。'; hint.textContent = maskHint;
      canvas.className = 'receipt-mask-canvas'; canvas.setAttribute('aria-label', '送信する写真。黒い範囲は送信前に隠します。');
      const full = { x: 0, y: 0, width: original.width, height: original.height };
      let view = { ...full }, selection = { ...full };
      let cropMode = false, detectionDone = false;
      type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
      const frameElement = document.createElement('div'); frameElement.className = 'receipt-crop-frame'; frameElement.append(canvas);
      const handles = new Map<Corner, HTMLButtonElement>();
      const draw = (showSelection = true) => {
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.save(); context.translate(-view.x, -view.y); context.drawImage(original, 0, 0); applyMasks(context, masks);
        if (cropMode && showSelection) {
          context.fillStyle = 'rgba(0, 0, 0, .55)';
          context.fillRect(view.x, view.y, view.width, selection.y - view.y);
          context.fillRect(view.x, selection.y + selection.height, view.width, view.y + view.height - selection.y - selection.height);
          context.fillRect(view.x, selection.y, selection.x - view.x, selection.height);
          context.fillRect(selection.x + selection.width, selection.y, view.x + view.width - selection.x - selection.width, selection.height);
          context.strokeStyle = '#fff'; context.lineWidth = 2 * canvas.width / Math.max(1, canvas.clientWidth);
          context.strokeRect(selection.x, selection.y, selection.width, selection.height);
        }
        context.restore();
        for (const [corner, handle] of handles) {
          handle.hidden = !cropMode;
          const x = selection.x + (corner.endsWith('right') ? selection.width : 0);
          const y = selection.y + (corner.startsWith('bottom') ? selection.height : 0);
          handle.style.left = `${canvas.offsetLeft + (x - view.x) / view.width * canvas.clientWidth}px`;
          handle.style.top = `${canvas.offsetTop + (y - view.y) / view.height * canvas.clientHeight}px`;
        }
      };
      let dragging: ReceiptMask | null = null;
      let cropCorner: Corner | null = null;
      let frame = 0;
      const redraw = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; draw(); if (dragging) { context.save(); context.translate(-view.x, -view.y); applyMasks(context, [dragging]); context.restore(); } }); };
      const resizeObserver = new ResizeObserver(redraw); resizeObserver.observe(canvas);
      let start: { x: number; y: number } | null = null;
      const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
      const point = (event: PointerEvent) => { const rect = canvas.getBoundingClientRect(); return {
        x: clamp(view.x + (event.clientX - rect.left) * view.width / rect.width, view.x, view.x + view.width),
        y: clamp(view.y + (event.clientY - rect.top) * view.height / rect.height, view.y, view.y + view.height),
      }; };
      const resizeCorner = (corner: Corner, end: { x: number; y: number }) => {
        const right = selection.x + selection.width, bottom = selection.y + selection.height;
        const minWidth = Math.min(12, view.width), minHeight = Math.min(12, view.height);
        if (corner.endsWith('left')) { selection.x = clamp(end.x, view.x, right - minWidth); selection.width = right - selection.x; }
        else selection.width = clamp(end.x, selection.x + minWidth, view.x + view.width) - selection.x;
        if (corner.startsWith('top')) { selection.y = clamp(end.y, view.y, bottom - minHeight); selection.height = bottom - selection.y; }
        else selection.height = clamp(end.y, selection.y + minHeight, view.y + view.height) - selection.y;
        redraw();
      };
      const updateDrag = (event: PointerEvent) => {
        if (cropCorner) { resizeCorner(cropCorner, point(event)); return; }
        if (!start || cropMode) return;
        const end = point(event);
        dragging = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.max(6, Math.abs(end.x - start.x)), height: Math.max(6, Math.abs(end.y - start.y)) };
        redraw();
      };
      const endDrag = (event: PointerEvent) => {
        updateDrag(event); if (dragging) masks.push(dragging);
        start = null; dragging = null; cropCorner = null; redraw();
      };
      const cancelDrag = () => { start = null; dragging = null; cropCorner = null; redraw(); };
      canvas.onpointerdown = event => { if (cropMode) return; start = point(event); canvas.setPointerCapture(event.pointerId); updateDrag(event); };
      canvas.onpointermove = updateDrag; canvas.onpointerup = endDrag; canvas.onpointercancel = cancelDrag;
      const cornerLabels = { 'top-left': '左上', 'top-right': '右上', 'bottom-left': '左下', 'bottom-right': '右下' } as const;
      for (const corner of Object.keys(cornerLabels) as Corner[]) {
        const handle = document.createElement('button'); handle.type = 'button'; handle.className = 'receipt-crop-handle';
        handle.setAttribute('aria-label', `トリミング枠の${cornerLabels[corner]}`); handle.hidden = true;
        handle.onpointerdown = event => { cropCorner = corner; handle.setPointerCapture(event.pointerId); event.preventDefault(); };
        handle.onpointermove = updateDrag; handle.onpointerup = endDrag; handle.onpointercancel = cancelDrag;
        handle.onkeydown = event => {
          const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
          const direction = arrows[event.key]; if (!direction) return;
          event.preventDefault(); const step = Math.max(1, Math.round(Math.min(view.width, view.height) / 100)) * (event.shiftKey ? 5 : 1);
          resizeCorner(corner, { x: selection.x + (corner.endsWith('right') ? selection.width : 0) + direction[0] * step,
            y: selection.y + (corner.startsWith('bottom') ? selection.height : 0) + direction[1] * step });
        };
        handles.set(corner, handle); frameElement.append(handle);
      }
      draw();
      const undo = document.createElement('button'); undo.type = 'button'; undo.textContent = '1つ戻す'; undo.onclick = () => { masks.pop(); draw(); };
      const cropControls = document.createElement('div'); cropControls.className = 'receipt-crop-controls';
      const crop = document.createElement('button'); crop.type = 'button'; crop.textContent = 'トリミング'; crop.setAttribute('aria-pressed', 'false');
      const applyCrop = document.createElement('button'); applyCrop.type = 'button'; applyCrop.textContent = 'この範囲で切り取る'; applyCrop.hidden = true;
      const resetCrop = document.createElement('button'); resetCrop.type = 'button'; resetCrop.textContent = '切り取りを戻す'; resetCrop.disabled = true;
      const setCropMode = (enabled: boolean) => {
        cancelDrag(); cropMode = enabled; crop.setAttribute('aria-pressed', String(enabled)); applyCrop.hidden = !enabled;
        help.hidden = enabled; frameElement.dataset.cropping = String(enabled);
        hint.textContent = enabled ? '四隅の丸を動かして、残す範囲を調整してください。矢印キーでも動かせます。「この範囲で切り取る」で確定します。' : maskHint;
        send.disabled = !detectionDone || enabled; redraw();
      };
      crop.onclick = () => { selection = { ...view }; setCropMode(!cropMode); };
      applyCrop.onclick = () => {
        const x = Math.floor(selection.x), y = Math.floor(selection.y);
        view = { x, y, width: Math.ceil(selection.x + selection.width) - x, height: Math.ceil(selection.y + selection.height) - y };
        canvas.width = view.width; canvas.height = view.height;
        resetCrop.disabled = view.x === 0 && view.y === 0 && view.width === full.width && view.height === full.height;
        setCropMode(false);
      };
      resetCrop.onclick = () => { view = { ...full }; canvas.width = full.width; canvas.height = full.height; resetCrop.disabled = true; setCropMode(false); };
      cropControls.append(crop, applyCrop, resetCrop);
      const send = document.createElement('button'); send.type = 'button'; send.className = 'primary'; send.textContent = 'この写真で読み取る'; send.disabled = true;
      const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'キャンセル';
      let closed = false;
      const detection = new AbortController();
      const cleanup = () => { closed = true; detection.abort(); resizeObserver.disconnect(); cancelAnimationFrame(frame); signal.removeEventListener('abort', abort); dialog.close(); dialog.remove(); };
      const abort = () => { cleanup(); reject(new DOMException('Cancelled', 'AbortError')); };
      cancel.onclick = abort; dialog.addEventListener('cancel', event => { event.preventDefault(); abort(); });
      send.onclick = () => { send.disabled = true; cancelled(signal); draw(false); canvas.toBlob(blob => { cleanup(); if (signal.aborted) reject(new DOMException('Cancelled', 'AbortError')); else if (blob) resolve(blob); else reject(new Error('image_encode_failed')); }, 'image/png'); };
      const actions = document.createElement('div'); actions.className = 'receipt-privacy-actions'; actions.append(send, cancel);
      dialog.append(title, status, help, hint, cropControls, frameElement, undo, actions); document.body.append(dialog);
      signal.addEventListener('abort', abort, { once: true }); dialog.showModal();
      // Scan the untouched raster: manual masks added while scanning must not hide OCR input.
      void detect(original, detection.signal, found => {
        if (closed) return;
        masks.unshift(...found);
        redraw();
      }).then(result => {
        if (closed) return;
        status.textContent = result.failed ? '自動検出できなかった箇所があります。写真を確認して隠す範囲を追加してください。' : '個人情報と思われる箇所を隠しました。残っていないか確認してください。';
        detectionDone = true; send.disabled = cropMode;
        redraw();
      }, () => {
        if (closed) return;
        status.textContent = '自動検出できませんでした。写真を確認して隠す範囲を追加してください。';
        detectionDone = true; send.disabled = cropMode;
      });
    });
  } finally { canvas.width = canvas.height = original.width = original.height = 0; }
}
