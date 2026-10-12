import jsQR from 'jsqr';
import type { ReceiptMask } from '../../../src/lib/receipt-privacy';

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

export function receiptCodeRegions(pixels: Uint8ClampedArray, width: number, height: number): ReceiptMask[] {
  const masks = barcodeRegions(pixels, width, height);
  // Blank each discovered code in the detection copy to find other QR codes.
  for (let i = 0; i < 12; i++) {
    const qr = jsQR(pixels, width, height);
    if (!qr) break;
    const corners = [qr.location.topLeftCorner, qr.location.topRightCorner, qr.location.bottomLeftCorner, qr.location.bottomRightCorner];
    const x = Math.max(0, Math.floor(Math.min(...corners.map(p => p.x))) - 8);
    const y = Math.max(0, Math.floor(Math.min(...corners.map(p => p.y))) - 8);
    const right = Math.min(width, Math.ceil(Math.max(...corners.map(p => p.x))) + 8);
    const bottom = Math.min(height, Math.ceil(Math.max(...corners.map(p => p.y))) + 8);
    masks.push({ x, y, width: right - x, height: bottom - y });
    for (let row = y; row < bottom; row++) pixels.fill(255, (row * width + x) * 4, (row * width + right) * 4);
  }
  return masks;
}
