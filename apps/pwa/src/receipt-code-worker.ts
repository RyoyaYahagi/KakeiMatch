import { receiptCodeRegions } from './receipt-code-detection';

self.onmessage = (event: MessageEvent<{ pixels: Uint8ClampedArray; width: number; height: number }>) => {
  const { pixels, width, height } = event.data;
  try { self.postMessage(receiptCodeRegions(pixels, width, height)); }
  finally { pixels.fill(0); }
};
