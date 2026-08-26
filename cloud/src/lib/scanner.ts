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
  /**
   * Whether this camera exposes a torch at all.
   *
   * Most Android rear cameras do; front cameras, desktop webcams and iOS
   * Safari do not. The UI hides the button rather than offering one that
   * silently fails, because a torch button that does nothing in a dark store
   * reads as a broken app.
   */
  hasTorch: () => boolean;
  /** Returns the state actually achieved, which may differ from the request. */
  setTorch: (on: boolean) => Promise<boolean>;
  isTorchOn: () => boolean;
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
    return NO_SCANNER;
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
    return NO_SCANNER;
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

  // Torch lives on the video track, not on the camera or the element. It has
  // to be read after the stream is live: capabilities are unknown until the
  // browser has actually opened the device.
  const [track] = stream.getVideoTracks();
  const torchCapable = Boolean(
    (track?.getCapabilities?.() as { torch?: boolean } | undefined)?.torch,
  );
  let torchOn = false;

  return {
    stop: () => {
      running = false;
      cancelAnimationFrame(frame);
      // Turn the light off before releasing the camera. Some Android devices
      // leave the LED burning if the track is stopped while the torch is on,
      // and the only way back is a reboot.
      if (torchOn && track) {
        void track
          .applyConstraints({ advanced: [{ torch: false } as MediaTrackConstraintSet] })
          .catch(() => {});
      }
      for (const t of stream.getTracks()) t.stop();
      video.srcObject = null;
    },

    hasTorch: () => torchCapable,
    isTorchOn: () => torchOn,

    setTorch: async (on: boolean) => {
      if (!torchCapable || !track) return false;
      try {
        await track.applyConstraints({
          advanced: [{ torch: on } as MediaTrackConstraintSet],
        });
        torchOn = on;
      } catch {
        // Some devices advertise the capability and then refuse it, usually
        // because another app holds the camera. Report what is true.
        torchOn = false;
      }
      return torchOn;
    },
  };
}

/** Returned when the camera never opened, so callers need no null checks. */
const NO_SCANNER: ScannerHandle = {
  stop: () => {},
  hasTorch: () => false,
  isTorchOn: () => false,
  setTorch: async () => false,
};
