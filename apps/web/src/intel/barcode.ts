/**
 * Reading the machine-encoded data printed on a document.
 *
 * The vault is otherwise blind to it. Character recognition reads printed
 * text and cannot read a barcode at all, so the QR on an invoice, the code on
 * a ticket and the block on the back of a licence are invisible to search no
 * matter how good the text extraction gets. This is a missing sense rather
 * than a weak one.
 *
 * Every symbology the decoder knows is enabled, not only the one that started
 * this: the WebAssembly costs the same either way, and restricting it would
 * throw away QR, Aztec and Data Matrix, which is where most of the machine
 * encoded data on ordinary documents actually lives.
 *
 * Self-hosted, like the text recognizer and the model runtime. The decoder
 * resolves its .wasm by filename at runtime, so vite.config.ts serves it from
 * /zxing and the loader is pointed there; the page's content security policy
 * would reject a CDN even if the default were left alone.
 */

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const IDLE_SHUTDOWN_MS = 60_000;

export interface Symbology {
  /** Canonical format name, for example "QRCode", "PDF417", "Aztec". */
  format: string;
  /** The decoded payload, as text. */
  text: string;
}

type Reader = typeof import("zxing-wasm/reader");

let readerPromise: Promise<Reader> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

async function getReader(): Promise<Reader> {
  if (!readerPromise) {
    readerPromise = (async () => {
      const reader = await import("zxing-wasm/reader");
      reader.prepareZXingModule({
        overrides: {
          locateFile: (path: string, prefix: string) =>
            path.endsWith(".wasm") ? `${__ZXING_BASE__}${path}` : `${prefix}${path}`,
        },
        fireImmediately: false,
      });
      return reader;
    })();
  }
  return readerPromise;
}

/** Frees the decoder after a while, so a casual session does not hold it. */
function touchIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
  }
  idleTimer = setTimeout(() => {
    void shutdownBarcode();
  }, IDLE_SHUTDOWN_MS);
}

export async function shutdownBarcode(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const pending = readerPromise;
  readerPromise = null;
  if (pending) {
    await pending.then((reader) => reader.purgeZXingModule()).catch(() => {});
  }
}

/**
 * Every symbol found in an image.
 *
 * The image is handed over whole rather than downscaled first: a dense PDF417
 * or a small QR loses the modules that carry its data long before a photograph
 * looks blurred to a person, and the decoder does its own scaling anyway.
 *
 * Never throws. A document with no barcode on it is the common case, not an
 * error, and a failed decode must not be able to fail an upload.
 */
export async function readSymbols(file: Blob): Promise<Symbology[]> {
  if (file.size === 0 || file.size > MAX_IMAGE_BYTES) {
    return [];
  }
  try {
    const reader = await getReader();
    touchIdleTimer();
    const results = await reader.readBarcodes(file, {
      tryHarder: true,
      tryRotate: true,
      tryInvert: true,
      maxNumberOfSymbols: 8,
    });
    return results
      .filter((result) => result.isValid && result.text)
      .map((result) => ({ format: String(result.format), text: result.text }));
  } catch {
    return [];
  }
}
