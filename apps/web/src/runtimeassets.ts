/**
 * The ML runtimes (onnx wasm, tesseract cores, barcode reader) are
 * multi-megabyte same-origin static assets under versioned paths. The
 * server serves them immutable, but Safari's HTTP cache is reluctant to
 * retain entries this large at all, so the service worker keeps them in
 * Cache Storage: fetched once, kept across sessions, evicted only when an
 * upgrade changes the versioned path. Without this, every upload session
 * on a WAN deployment re-downloads and re-compiles tens of megabytes
 * before the first file can finish.
 */

export const RUNTIME_CACHE = "engram-ml-runtimes";

/** The stable language data lives outside the versioned bases and only
 * ever changes by being renamed. */
const STABLE_ASSETS = ["/ocr/eng.traineddata.gz"];

export function runtimeBases(): string[] {
  return [__ORT_BASE__, __OCR_BASE__, __ZXING_BASE__, __GLINER_ORT_BASE__];
}

/** Any path under a runtime mount, current version or not. */
export function isRuntimeAssetPath(pathname: string): boolean {
  return /^\/(ort|ocr|zxing|gliner-ort)\//.test(pathname);
}

/** Whether a cached entry belongs to the running build's runtimes; the
 * rest is a previous version's and gets evicted on activate. */
export function isCurrentRuntimeAsset(
  pathname: string,
  bases: string[] = runtimeBases(),
): boolean {
  return bases.some((base) => pathname.startsWith(base)) || STABLE_ASSETS.includes(pathname);
}

/** What to pre-fetch for the features this device has switched on; the
 * biggest wins are the onnx runtime (semantic search) and the OCR stack. */
export function warmList(flags: { semantic: boolean; ocr: boolean }): string[] {
  const urls: string[] = [];
  if (flags.semantic) {
    urls.push(
      `${__ORT_BASE__}ort-wasm-simd-threaded.asyncify.mjs`,
      `${__ORT_BASE__}ort-wasm-simd-threaded.asyncify.wasm`,
    );
  }
  if (flags.ocr) {
    urls.push(
      `${__OCR_BASE__}worker.min.js`,
      `${__OCR_BASE__}tesseract-core-relaxedsimd-lstm.wasm.js`,
      `${__OCR_BASE__}tesseract-core-relaxedsimd-lstm.wasm`,
      ...STABLE_ASSETS,
    );
  }
  return urls;
}
