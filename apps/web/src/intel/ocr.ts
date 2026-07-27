/**
 * On-device OCR with tesseract.js. Opt-in, fully self-hosted (worker, wasm
 * core, and the English model all come from this origin), and the recognized
 * text only ever lands inside encrypted metadata. The worker is created
 * lazily on first use and torn down after a minute of idleness so casual
 * sessions never pay for it.
 */
import type { Worker } from "tesseract.js";

const PREF_KEY = "engram-ocr";
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_EDGE_PX = 2400;
const IDLE_SHUTDOWN_MS = 60_000;
const TEXT_STORE_LIMIT = 100_000;

export function ocrEnabled(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) === "1";
  } catch {
    return false;
  }
}

export function setOcrEnabled(on: boolean): void {
  try {
    localStorage.setItem(PREF_KEY, on ? "1" : "0");
  } catch {
    // Preference persistence is best-effort.
  }
}

let workerPromise: Promise<Worker> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

async function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker, OEM } = await import("tesseract.js");
      return createWorker("eng", OEM.LSTM_ONLY, {
        workerPath: "/ocr/worker.min.js",
        corePath: "/ocr",
        langPath: "/ocr",
        gzip: true,
      });
    })();
  }
  return workerPromise;
}

function scheduleShutdown(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
  }
  idleTimer = setTimeout(() => {
    const pending = workerPromise;
    workerPromise = null;
    void pending?.then((worker) => worker.terminate()).catch(() => {});
  }, IDLE_SHUTDOWN_MS);
}

/** Big photos are downscaled before recognition: faster and no less accurate. */
async function normalized(image: Blob): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(image);
    const { width, height } = bitmap;
    const scale = Math.min(1, MAX_EDGE_PX / Math.max(width, height));
    if (scale === 1) {
      bitmap.close();
      return image;
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return image;
    }
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    return blob ?? image;
  } catch {
    return image;
  }
}

/**
 * Recognizes text in an image, entirely on this device. Returns undefined
 * when nothing legible was found or the image is unreasonable to process.
 */
export async function recognizeImage(image: Blob): Promise<string | undefined> {
  if (image.size === 0 || image.size > MAX_IMAGE_BYTES) {
    return undefined;
  }
  const worker = await getWorker();
  try {
    const prepared = await normalized(image);
    const { data } = await worker.recognize(new File([prepared], "image"));
    const text = data.text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    if (text.length < 3) {
      return undefined;
    }
    return text.slice(0, TEXT_STORE_LIMIT);
  } finally {
    scheduleShutdown();
  }
}
