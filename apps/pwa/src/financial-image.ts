/** An ephemeral raster: no repository, object URL or original file is retained. */
export async function financialImage(file: File): Promise<{ canvas: HTMLCanvasElement; destroy(): void }> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 20 * 1024 * 1024) throw new Error('20 MiB以下のJPEG・PNG・WebP画像を選んでください。');
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const canvas = document.createElement('canvas');
  try {
    const scale = Math.min(1, 1800 / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('写真を開けませんでした。');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return { canvas, destroy: () => { canvas.width = 0; canvas.height = 0; canvas.remove(); } };
  } finally { bitmap.close(); }
}
/** Coordinates are normalized, independent of the preview's CSS size. */
export function maskFinancialImage(canvas: HTMLCanvasElement, x1: number, y1: number, x2: number, y2: number) {
  const context = canvas.getContext('2d');
  if (!context) return;
  context.fillStyle = '#000';
  context.fillRect(Math.min(x1, x2) * canvas.width, Math.min(y1, y2) * canvas.height,
    Math.max(0.005, Math.abs(x2 - x1)) * canvas.width, Math.max(0.005, Math.abs(y2 - y1)) * canvas.height);
}
export async function financialImageBytes(canvas: HTMLCanvasElement): Promise<Uint8Array<ArrayBuffer>> {
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('写真を準備できませんでした。')), 'image/jpeg', 0.9));
  if (blob.size > 6 * 1024 * 1024) throw new Error('写真が大きすぎます。必要な部分を撮り直してください。');
  return new Uint8Array(await blob.arrayBuffer());
}
