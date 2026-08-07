// Camera barcode scanning (CLAUDE.md §12.4).
//
// > Camera opens immediately for scanning. A permanent "Search instead" button
// > switches to typeahead. Both paths land on the same item card.
//
// This uses the browser's native `BarcodeDetector`, which is present on Android
// Chrome and absent on iOS Safari and Firefox. **That is a real limitation, not
// an oversight**: shipping a WASM decoder would add a megabyte to first load for
// a capability the shop-floor device (an Android tablet) already has natively.
//
// Where it is missing, `isScanningSupported()` reports false and the UI opens
// on search instead of pretending the camera will work. §12's rule that both
// paths land on the same item card is what makes that degradation acceptable
// rather than crippling.

/** Symbologies worth looking for in a tool crib. */
const FORMATS = ["code_128", "code_39", "ean_13", "ean_8", "upc_a", "upc_e", "qr_code"];

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
}

interface BarcodeDetectorCtor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats?(): Promise<string[]>;
}

function detectorCtor(): BarcodeDetectorCtor | undefined {
  return (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
}

export function isScanningSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    !!detectorCtor()
  );
}

export interface ScannerHandle {
  stop: () => void;
}

export type ScannerError =
  | "unsupported"
  | "permission-denied"
  | "no-camera"
  | "failed";

interface StartOptions {
  video: HTMLVideoElement;
  onDetect: (code: string) => void;
  onError: (error: ScannerError) => void;
}

/**
 * Start the rear camera and scan until stopped.
 *
 * Detection is debounced on the value: a barcode sits in frame for many
 * consecutive frames, and firing the lookup thirty times a second would hammer
 * the server and flicker the screen.
 */
export async function startScanner({
  video,
  onDetect,
  onError,
}: StartOptions): Promise<ScannerHandle> {
  const Ctor = detectorCtor();
  if (!Ctor || !navigator.mediaDevices?.getUserMedia) {
    onError("unsupported");
    return { stop: () => {} };
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      // `environment` is the rear camera — the one pointing at the bin.
      video: { facingMode: { ideal: "environment" } },
      audio: false,
    });
  } catch (err) {
    const name = (err as { name?: string })?.name;
    onError(
      name === "NotAllowedError"
        ? "permission-denied"
        : name === "NotFoundError"
          ? "no-camera"
          : "failed",
    );
    return { stop: () => {} };
  }

  video.srcObject = stream;
  video.setAttribute("playsinline", "true");
  await video.play().catch(() => {});

  const detector = new Ctor({ formats: FORMATS });
  let running = true;
  let lastValue = "";
  let lastAt = 0;
  let frame = 0;

  const tick = async () => {
    if (!running) return;
    try {
      if (video.readyState >= 2) {
        const found = await detector.detect(video);
        const value = found[0]?.rawValue?.trim();
        const now = Date.now();
        // Same code within two seconds is the same barcode still in frame.
        if (value && (value !== lastValue || now - lastAt > 2000)) {
          lastValue = value;
          lastAt = now;
          onDetect(value);
        }
      }
    } catch {
      // A single failed frame is normal (mid-resize, backgrounded tab).
    }
    if (running) frame = requestAnimationFrame(() => void tick());
  };

  frame = requestAnimationFrame(() => void tick());

  return {
    stop: () => {
      running = false;
      cancelAnimationFrame(frame);
      for (const track of stream.getTracks()) track.stop();
      video.srcObject = null;
    },
  };
}
