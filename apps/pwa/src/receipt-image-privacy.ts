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
      const status = document.createElement('p'); status.setAttribute('role', 'status'); status.textContent = '個人情報を探しています… 写真をなぞって隠す範囲を追加できます。';
      const hint = document.createElement('p'); hint.textContent = '隠す範囲を写真の上でなぞって追加できます。誤って隠した場合は「1つ戻す」で戻せます。';
      canvas.className = 'receipt-mask-canvas'; canvas.setAttribute('aria-label', '送信する写真。黒い範囲は送信前に隠します。');
      const draw = () => { context.clearRect(0, 0, canvas.width, canvas.height); context.drawImage(original, 0, 0); applyMasks(context, masks); };
      draw();
      let dragging: ReceiptMask | null = null;
      let frame = 0;
      const redraw = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; draw(); if (dragging) applyMasks(context, [dragging]); }); };
      let start: { x: number; y: number } | null = null;
      const point = (event: PointerEvent) => { const rect = canvas.getBoundingClientRect(); return { x: (event.clientX - rect.left) * canvas.width / rect.width, y: (event.clientY - rect.top) * canvas.height / rect.height }; };
      const updateDrag = (event: PointerEvent) => {
        if (!start) return;
        const end = point(event);
        dragging = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.max(6, Math.abs(end.x - start.x)), height: Math.max(6, Math.abs(end.y - start.y)) };
        redraw();
      };
      canvas.onpointerdown = event => { start = point(event); canvas.setPointerCapture(event.pointerId); updateDrag(event); };
      canvas.onpointermove = updateDrag;
      canvas.onpointerup = event => { if (!start) return; updateDrag(event); if (dragging) masks.push(dragging); start = null; dragging = null; redraw(); };
      canvas.onpointercancel = () => { start = null; dragging = null; redraw(); };
      const undo = document.createElement('button'); undo.type = 'button'; undo.textContent = '1つ戻す'; undo.onclick = () => { masks.pop(); draw(); };
      // Keyboard and assistive-technology users can hide a full-width band by percentage.
      const band = document.createElement('fieldset'); const legend = document.createElement('legend'); legend.textContent = '数字で範囲を隠す（写真の上端を0%、下端を100%）'; band.append(legend);
      const values = ['上端（%）', '下端（%）'].map((labelText, i) => { const label = document.createElement('label'); label.textContent = labelText;
        const input = document.createElement('input'); input.type = 'number'; input.min = '0'; input.max = '100'; input.value = i ? '100' : '90'; label.append(input); band.append(label); return input; });
      const add = document.createElement('button'); add.type = 'button'; add.textContent = 'この範囲を隠す'; add.onclick = () => { const [top, bottom] = values.map(input => input.valueAsNumber); if (!Number.isFinite(top) || !Number.isFinite(bottom) || top < 0 || bottom > 100 || bottom <= top) return; masks.push({ x: 0, y: canvas.height * top / 100, width: canvas.width, height: canvas.height * (bottom - top) / 100 }); draw(); }; band.append(add);
      const send = document.createElement('button'); send.type = 'button'; send.className = 'primary'; send.textContent = 'この写真で読み取る'; send.disabled = true;
      const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'キャンセル';
      let closed = false;
      const detection = new AbortController();
      const cleanup = () => { closed = true; detection.abort(); cancelAnimationFrame(frame); signal.removeEventListener('abort', abort); dialog.close(); dialog.remove(); };
      const abort = () => { cleanup(); reject(new DOMException('Cancelled', 'AbortError')); };
      cancel.onclick = abort; dialog.addEventListener('cancel', event => { event.preventDefault(); abort(); });
      send.onclick = () => { send.disabled = true; cancelled(signal); draw(); canvas.toBlob(blob => { cleanup(); if (signal.aborted) reject(new DOMException('Cancelled', 'AbortError')); else if (blob) resolve(blob); else reject(new Error('image_encode_failed')); }, 'image/png'); };
      const actions = document.createElement('div'); actions.className = 'receipt-privacy-actions'; actions.append(send, cancel);
      dialog.append(title, status, help, hint, canvas, undo, band, actions); document.body.append(dialog);
      signal.addEventListener('abort', abort, { once: true }); dialog.showModal();
      // Scan the untouched raster: manual masks added while scanning must not hide OCR input.
      void detect(original, detection.signal, found => {
        if (closed) return;
        masks.unshift(...found);
        redraw();
      }).then(result => {
        if (closed) return;
        status.textContent = result.failed ? '自動検出できなかった箇所があります。写真を確認して隠す範囲を追加してください。' : '個人情報と思われる箇所を隠しました。残っていないか確認してください。';
        send.disabled = false;
        redraw();
      }, () => {
        if (closed) return;
        status.textContent = '自動検出できませんでした。写真を確認して隠す範囲を追加してください。';
        send.disabled = false;
      });
    });
  } finally { canvas.width = canvas.height = original.width = original.height = 0; }
}
