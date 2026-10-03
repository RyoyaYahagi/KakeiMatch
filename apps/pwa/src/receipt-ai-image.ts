import type { ReceiptContentType } from "../../../src/lib/receipt-validation";

/**
 * Longest edge of the copy sent for AI reading. The model reads each image
 * within a fixed token budget, so a full-resolution phone photo mostly adds
 * upload time. The saved original keeps its full resolution.
 */
export const MAX_AI_IMAGE_EDGE = 2048;
const JPEG_QUALITY = 0.85;

export type AiImage = { bytes: Uint8Array; contentType: ReceiptContentType };

/** Returns the reduced size, or null when the image already fits. */
export function aiImageSize(width: number, height: number): { width: number; height: number } | null {
  const longest = Math.max(width, height);
  if (longest <= MAX_AI_IMAGE_EDGE) return null;
  const scale = MAX_AI_IMAGE_EDGE / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Prepares the bytes sent for AI reading: a reduced JPEG when the photo is larger than needed. */
export async function prepareAiImage(blob: Blob, contentType: ReceiptContentType): Promise<AiImage> {
  const original = async (): Promise<AiImage> => ({ bytes: new Uint8Array(await blob.arrayBuffer()), contentType });
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") return original();
  let bitmap: ImageBitmap;
  // An image this browser cannot decode is sent unchanged, as before this reduction existed.
  try { bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" }); } catch { return original(); }
  try {
    const size = aiImageSize(bitmap.width, bitmap.height);
    if (!size) return original();
    const canvas = new OffscreenCanvas(size.width, size.height);
    const context = canvas.getContext("2d");
    if (!context) return original();
    // JPEG has no transparency; a white background keeps transparent PNG areas readable.
    context.fillStyle = "#fff";
    context.fillRect(0, 0, size.width, size.height);
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    const reduced = await canvas.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY });
    return { bytes: new Uint8Array(await reduced.arrayBuffer()), contentType: "image/jpeg" };
  } finally { bitmap.close(); }
}
