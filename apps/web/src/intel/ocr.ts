/**
 * On-device OCR with tesseract.js. Opt-in, fully self-hosted (worker, wasm
 * core, and the English model all come from this origin), and the recognized
 * text only ever lands inside encrypted metadata. The worker is created
 * lazily on first use and torn down after a minute of idleness so casual
 * sessions never pay for it.
 */
import type { Worker } from "tesseract.js";
import { decodeHeic, isHeicLike } from "./heic";
import { settingChanged } from "../settingsbus";

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
    settingChanged();
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
        // Versioned base so the server can serve these as immutable; the
        // language data keeps its stable unversioned home in public/ocr.
        workerPath: `${__OCR_BASE__}worker.min.js`,
        corePath: __OCR_BASE__.replace(/\/$/, ""),
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
    // HEIC needs our own decoder where the platform lacks one, and the
    // recognizer cannot read the original bytes there either, so a decoded
    // HEIC is always re-encoded below even at full size.
    let native = true;
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(image);
    } catch (err) {
      if (!isHeicLike(image.type, "")) {
        throw err;
      }
      const decoded = await decodeHeic(new Uint8Array(await image.arrayBuffer()));
      bitmap = await createImageBitmap(new ImageData(decoded.data, decoded.width, decoded.height));
      native = false;
    }
    const { width, height } = bitmap;
    const scale = Math.min(1, MAX_EDGE_PX / Math.max(width, height));
    if (scale === 1 && native) {
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

import type { PDFPageProxy } from "pdfjs-dist";

async function pageToBlob(page: PDFPageProxy, width: number): Promise<Blob | null> {
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: Math.max(1, width / base.width) });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return null;
  }
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
}

/**
 * Renders one page of a PDF to an image at recognition width. The barcode
 * reader borrows this: a printed boarding pass is usually stored as a PDF,
 * and its code needs more resolution than a thumbnail carries.
 */
export async function renderPdfPage(pdf: Blob, pageNumber = 1): Promise<Blob | null> {
  if (pdf.size === 0 || pdf.size > MAX_PDF_BYTES) {
    return null;
  }
  const pdfjs = await import("pdfjs-dist");
  const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const loadingTask = pdfjs.getDocument({ data: await pdf.arrayBuffer() });
  try {
    const doc = await loadingTask.promise;
    if (pageNumber > doc.numPages) {
      return null;
    }
    return await pageToBlob(await doc.getPage(pageNumber), PDF_RENDER_WIDTH);
  } catch {
    return null;
  } finally {
    await loadingTask.destroy();
  }
}

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
      const blob = await pageToBlob(await doc.getPage(i), PDF_RENDER_WIDTH);
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
