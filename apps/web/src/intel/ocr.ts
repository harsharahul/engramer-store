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

const MAX_PDF_BYTES = 50 * 1024 * 1024;
const MAX_OCR_PAGES = 20;
const PDF_RENDER_WIDTH = 1600;

/**
 * Recognizes text in a scanned PDF: pages render to canvas and go through
 * the same on-device engine as photos. Documents with a real text layer
 * never reach this path (their text extracts directly); this exists for
 * the scans and faxes of the world, which are images in a PDF wrapper.
 */
export async function recognizePdf(pdf: Blob): Promise<string | undefined> {
  if (pdf.size === 0 || pdf.size > MAX_PDF_BYTES) {
    return undefined;
  }
  const pdfjs = await import("pdfjs-dist");
  const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const loadingTask = pdfjs.getDocument({ data: await pdf.arrayBuffer() });
  const parts: string[] = [];
  try {
    const doc = await loadingTask.promise;
    const pages = Math.min(doc.numPages, MAX_OCR_PAGES);
    let total = 0;
    for (let i = 1; i <= pages && total < TEXT_STORE_LIMIT; i++) {
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.max(1, PDF_RENDER_WIDTH / base.width) });
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        break;
      }
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) {
        continue;
      }
      const text = await recognizeImage(blob);
      if (text) {
        parts.push(text);
        total += text.length;
      }
    }
  } finally {
    await loadingTask.destroy();
  }
  const text = parts.join("\n").trim();
  return text.length >= 3 ? text.slice(0, TEXT_STORE_LIMIT) : undefined;
}
