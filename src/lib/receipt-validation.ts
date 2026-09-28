export const MAX_RECEIPT_SIZE_BYTES = 10 * 1024 * 1024;

export const RECEIPT_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type ReceiptContentType = (typeof RECEIPT_CONTENT_TYPES)[number];

export class ReceiptValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceiptValidationError";
  }
}

function detectContentType(bytes: Buffer): ReceiptContentType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }

  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }

  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }

  return null;
}

export function validateReceiptImage(input: {
  bytes: Buffer;
  declaredContentType: string;
}): { contentType: ReceiptContentType; sizeBytes: number } {
  if (input.bytes.length === 0) {
    throw new ReceiptValidationError("画像ファイルを選択してください。");
  }

  if (input.bytes.length > MAX_RECEIPT_SIZE_BYTES) {
    throw new ReceiptValidationError("画像のサイズは10 MiB以下にしてください。");
  }

  if (!RECEIPT_CONTENT_TYPES.includes(input.declaredContentType as ReceiptContentType)) {
    throw new ReceiptValidationError("JPEG、PNG、WebP形式の画像を選択してください。");
  }

  const detectedContentType = detectContentType(input.bytes);
  if (!detectedContentType) {
    throw new ReceiptValidationError("画像形式を確認できませんでした。JPEG、PNG、WebP形式の画像を選択してください。");
  }

  if (detectedContentType !== input.declaredContentType) {
    throw new ReceiptValidationError("画像の形式がファイル情報と一致しません。画像を選び直してください。");
  }

  return { contentType: detectedContentType, sizeBytes: input.bytes.length };
}
