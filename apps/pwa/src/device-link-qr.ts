// Shows a connection code as a QR code and reads one with the camera.
// iPhone Safari has no built-in barcode reader, so decoding uses jsQR on camera frames.
import qrcode from 'qrcode-generator';
import jsQR from 'jsqr';

const SVG = 'http://www.w3.org/2000/svg';

/** One SVG path of the dark modules, so the code stays sharp at any size. */
export function qrSvg(code: string, label: string): SVGSVGElement {
  const qr = qrcode(0, 'L');
  qr.addData(code, 'Byte');
  qr.make();
  const count = qr.getModuleCount();
  const quiet = 4;
  let path = '';
  for (let row = 0; row < count; row++) {
    for (let column = 0; column < count; column++) if (qr.isDark(row, column)) path += `M${column + quiet} ${row + quiet}h1v1h-1z`;
  }
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${count + quiet * 2} ${count + quiet * 2}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  svg.classList.add('link-qr');
  const background = document.createElementNS(SVG, 'rect');
  background.setAttribute('width', '100%'); background.setAttribute('height', '100%'); background.setAttribute('fill', '#fff');
  const modules = document.createElementNS(SVG, 'path');
  modules.setAttribute('d', path); modules.setAttribute('fill', '#000');
  svg.append(background, modules);
  return svg;
}

type Detector = { detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>> };
/** The browser's own reader where it has one (Chrome on Mac and Android): faster and more forgiving of blur than jsQR. */
async function nativeDetector(): Promise<Detector | null> {
  const Native = (globalThis as { BarcodeDetector?: { new(options: { formats: string[] }): Detector; getSupportedFormats(): Promise<string[]> } }).BarcodeDetector;
  if (!Native) return null;
  try { return (await Native.getSupportedFormats()).includes('qr_code') ? new Native({ formats: ['qr_code'] }) : null; } catch { return null; }
}

/** Reads QR codes from the rear camera until `accept` takes one. `stop()` releases the camera. */
export async function scanQr(video: HTMLVideoElement, accept: (value: string) => boolean): Promise<{ stop(): void }> {
  // A dense code needs detail: laptop cameras default to a low resolution unless asked.
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
  const detector = await nativeDetector();
  video.srcObject = stream;
  video.muted = true;
  video.setAttribute('playsinline', '');
  await video.play();
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  let running = true;
  const stop = () => {
    running = false;
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
  };
  const frame = async () => {
    if (!running) return;
    if (video.readyState >= video.HAVE_CURRENT_DATA && video.videoWidth > 0) {
      let value: string | null = null;
      if (detector) {
        try { value = (await detector.detect(video))[0]?.rawValue ?? null; } catch { value = null; }
      } else {
        // jsQR on a frame of up to 1280px: enough detail for a dense code, still quick on phones.
        const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
        canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        value = jsQR(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' })?.data ?? null;
      }
      if (!running) return;
      if (value && accept(value)) { stop(); return; }
    }
    requestAnimationFrame(() => { void frame(); });
  };
  requestAnimationFrame(() => { void frame(); });
  return { stop };
}
