// QR generation and camera scanning — both fully local, no network.

import QRCode from 'qrcode';
import jsQR from 'jsqr';

const LC_GREEN = '#b4f953';
const LC_BLACK = '#0a0a0a';

/** Draw `text` as a QR into a canvas element, styled to match the app. */
export async function renderQR(canvas, text, size = 240) {
  await QRCode.toCanvas(canvas, text, {
    width: size,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: { dark: LC_BLACK, light: LC_GREEN },
  });
}

/**
 * Open the camera and call `onResult(text)` on the first QR found.
 * Returns a stop() function; always call it when closing the UI, or the
 * camera light stays on.
 */
export async function startScanner(videoEl, canvasEl, onResult, onError) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('this device has no camera API available');
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
      audio: false,
    });
  } catch (e) {
    // NotAllowedError is a denied permission; NotFoundError is no camera.
    if (e?.name === 'NotAllowedError') {
      throw new Error('camera permission denied — allow it in your system or app settings');
    }
    if (e?.name === 'NotFoundError') {
      throw new Error('no camera found on this device');
    }
    throw e;
  }

  videoEl.srcObject = stream;
  videoEl.setAttribute('playsinline', 'true'); // iOS: don't go fullscreen
  await videoEl.play();

  let stopped = false;
  const ctx = canvasEl.getContext('2d', { willReadFrequently: true });

  const stop = () => {
    stopped = true;
    for (const track of stream.getTracks()) track.stop();
    videoEl.srcObject = null;
  };

  const tick = () => {
    if (stopped) return;
    if (videoEl.readyState === videoEl.HAVE_ENOUGH_DATA) {
      const w = videoEl.videoWidth;
      const h = videoEl.videoHeight;
      if (w && h) {
        // Downscale wide frames: jsQR is O(pixels) and runs every frame.
        const scale = Math.min(1, 640 / Math.max(w, h));
        canvasEl.width = Math.round(w * scale);
        canvasEl.height = Math.round(h * scale);
        ctx.drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);
        const image = ctx.getImageData(0, 0, canvasEl.width, canvasEl.height);
        try {
          const found = jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });
          if (found?.data) {
            stop();
            onResult(found.data.trim());
            return;
          }
        } catch (e) {
          stop();
          onError?.(e);
          return;
        }
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  return stop;
}
