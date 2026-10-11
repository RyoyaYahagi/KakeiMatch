import { createWorker, PSM } from 'tesseract.js';
import jsQR from 'jsqr';
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

/** Locate dense vertical bars without decoding or retaining their contents. */
export function barcodeRegions(pixels: Uint8ClampedArray, width: number, height: number): ReceiptMask[] {
  const regions: ReceiptMask[] = [];
  const dark = (x: number, y: number) => {
    const at = (y * width + x) * 4;
    return pixels[at] + pixels[at + 1] + pixels[at + 2] < 300;
  };
  for (let y = 0; y < height - 16; y += 8) {
    let start = -1, transitions = 0, previous = false;
    for (let x = 0; x <= width; x++) {
      const black = x < width && dark(x, y);
      const vertical = x < width && [4, 8, 12, 16].every(offset => dark(x, y + offset) === black);
      if (!vertical || x === width) {
        if (start >= 0 && transitions >= 24 && x - start >= 60) {
          const left = start, right = x;
          let bottom = y + 16;
          while (bottom + 1 < height && Array.from({ length: 12 }, (_, i) => left + Math.floor((right - left - 1) * i / 11))
            .every(sample => dark(sample, bottom + 1) === dark(sample, y))) bottom++;
          regions.push({ x: left - 4, y: y - 8, width: right - left + 8, height: bottom - y + 16 });
        }
        start = -1; transitions = 0;
      } else {
        if (start < 0) { start = x; previous = black; }
        else if (black !== previous) { transitions++; previous = black; }
      }
    }
  }
  return regions;
}

async function detect(canvas: HTMLCanvasElement, signal: AbortSignal): Promise<{ masks: ReceiptMask[]; failed: boolean }> {
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  const masks = barcodeRegions(pixels.data, canvas.width, canvas.height);
  // Blank each discovered code in the detection copy to find other QR codes.
  for (let i = 0; i < 12; i++) {
    cancelled(signal);
    const qr = jsQR(pixels.data, pixels.width, pixels.height);
    if (!qr) break;
    const corners = [qr.location.topLeftCorner, qr.location.topRightCorner, qr.location.bottomLeftCorner, qr.location.bottomRightCorner];
    const x = Math.max(0, Math.floor(Math.min(...corners.map(p => p.x))) - 8);
    const y = Math.max(0, Math.floor(Math.min(...corners.map(p => p.y))) - 8);
    const right = Math.min(canvas.width, Math.ceil(Math.max(...corners.map(p => p.x))) + 8);
    const bottom = Math.min(canvas.height, Math.ceil(Math.max(...corners.map(p => p.y))) + 8);
    masks.push({ x, y, width: right - x, height: bottom - y });
    for (let row = y; row < bottom; row++) pixels.data.fill(255, (row * pixels.width + x) * 4, (row * pixels.width + right) * 4);
  }
  pixels.data.fill(0);
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
    const initializing = createWorker(['jpn', 'eng'], 1, {
      workerPath: '/receipt-ocr/worker.min.js', corePath: '/receipt-ocr', langPath: '/receipt-ocr',
      workerBlobURL: false, cacheMethod: 'none', logger: () => {}, errorHandler: () => {},
    });
    void initializing.then(created => { if (detectionSignal.aborted) void created.terminate(); }, () => {});
    worker = await abortable(initializing, detectionSignal);
    cancelled(detectionSignal);
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
    const { data } = await abortable(worker.recognize(canvas, {}, { blocks: true, text: false }), detectionSignal);
    cancelled(detectionSignal);
    masks.push(...privateReceiptRegions((data.blocks ?? []).flatMap(block => block.paragraphs.flatMap(paragraph => paragraph.lines))));
    return { masks, failed: false };
  } catch {
    cancelled(signal);
    return { masks, failed: true };
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
    const { masks, failed } = await detect(canvas, signal);
    cancelled(signal);
    return await new Promise<Blob>((resolve, reject) => {
      const dialog = document.createElement('dialog'); dialog.className = 'receipt-privacy-dialog';
      const title = document.createElement('h2'); title.textContent = '送信する写真を確認'; title.id = 'receipt-privacy-title'; dialog.setAttribute('aria-labelledby', title.id);
      const help = document.createElement('p'); help.textContent = `${failed ? '自動検出できなかった箇所があります。' : '個人情報と思われる箇所を隠しました。'} 氏名・電話・住所・会員番号・カード番号・口座番号・QRコード・バーコードが残っていないか確認してください。店名・日付・商品・金額は残してください。`;
      const hint = document.createElement('p'); hint.textContent = '隠す範囲を写真の上でなぞって追加できます。誤って隠した場合は「1つ戻す」で戻せます。';
      canvas.className = 'receipt-mask-canvas'; canvas.setAttribute('aria-label', '送信する写真。黒い範囲は送信前に隠します。');
      const draw = () => { context.clearRect(0, 0, canvas.width, canvas.height); context.drawImage(original, 0, 0); applyMasks(context, masks); };
      draw();
      let start: { x: number; y: number } | null = null;
      const point = (event: PointerEvent) => { const rect = canvas.getBoundingClientRect(); return { x: (event.clientX - rect.left) * canvas.width / rect.width, y: (event.clientY - rect.top) * canvas.height / rect.height }; };
      canvas.onpointerdown = event => { start = point(event); canvas.setPointerCapture(event.pointerId); };
      canvas.onpointerup = event => { if (!start) return; const end = point(event); masks.push({ x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.max(6, Math.abs(end.x - start.x)), height: Math.max(6, Math.abs(end.y - start.y)) }); start = null; draw(); };
      canvas.onpointercancel = () => { start = null; };
      const undo = document.createElement('button'); undo.type = 'button'; undo.textContent = '1つ戻す'; undo.onclick = () => { masks.pop(); draw(); };
      // Keyboard and assistive-technology users can hide a full-width band by percentage.
      const band = document.createElement('fieldset'); const legend = document.createElement('legend'); legend.textContent = '数字で範囲を隠す（写真の上端を0%、下端を100%）'; band.append(legend);
      const values = ['上端（%）', '下端（%）'].map((labelText, i) => { const label = document.createElement('label'); label.textContent = labelText;
        const input = document.createElement('input'); input.type = 'number'; input.min = '0'; input.max = '100'; input.value = i ? '100' : '90'; label.append(input); band.append(label); return input; });
      const add = document.createElement('button'); add.type = 'button'; add.textContent = 'この範囲を隠す'; add.onclick = () => { const [top, bottom] = values.map(input => input.valueAsNumber); if (!Number.isFinite(top) || !Number.isFinite(bottom) || top < 0 || bottom > 100 || bottom <= top) return; masks.push({ x: 0, y: canvas.height * top / 100, width: canvas.width, height: canvas.height * (bottom - top) / 100 }); draw(); }; band.append(add);
      const send = document.createElement('button'); send.type = 'button'; send.className = 'primary'; send.textContent = 'この写真で読み取る';
      const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'キャンセル';
      const cleanup = () => { signal.removeEventListener('abort', abort); dialog.close(); dialog.remove(); };
      const abort = () => { cleanup(); reject(new DOMException('Cancelled', 'AbortError')); };
      cancel.onclick = abort; dialog.addEventListener('cancel', event => { event.preventDefault(); abort(); });
      send.onclick = () => { send.disabled = true; cancelled(signal); canvas.toBlob(blob => { cleanup(); if (signal.aborted) reject(new DOMException('Cancelled', 'AbortError')); else if (blob) resolve(blob); else reject(new Error('image_encode_failed')); }, 'image/png'); };
      const actions = document.createElement('div'); actions.className = 'receipt-privacy-actions'; actions.append(send, cancel);
      dialog.append(title, help, hint, canvas, undo, band, actions); document.body.append(dialog);
      signal.addEventListener('abort', abort, { once: true }); dialog.showModal();
    });
  } finally { canvas.width = canvas.height = original.width = original.height = 0; }
}
