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

/** Reads QR codes from the rear camera until `accept` takes one. `stop()` releases the camera. */
export async function scanQr(video: HTMLVideoElement, accept: (value: string) => boolean): Promise<{ stop(): void }> {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
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
  const frame = () => {
    if (!running) return;
    if (video.readyState >= video.HAVE_CURRENT_DATA && video.videoWidth > 0) {
      // Decoding a downscaled frame keeps phones responsive; connection codes still read reliably.
      const scale = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const found = jsQR(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' });
      if (found?.data && accept(found.data)) { stop(); return; }
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  return { stop };
}
