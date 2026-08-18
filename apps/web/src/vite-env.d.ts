/// <reference types="vite/client" />

/** The release this bundle was built from; see define() in vite.config.ts. */
declare const __APP_VERSION__: string;

/** Versioned base paths of the staged ML runtimes, e.g. "/ort/1.26.0/".
 * The version in the path is what lets the server mark these
 * multi-megabyte assets immutable; each staging plugin in vite.config.ts
 * defines its own. */
declare const __ORT_BASE__: string;
declare const __OCR_BASE__: string;
declare const __ZXING_BASE__: string;
declare const __GLINER_ORT_BASE__: string;

/** heic-decode ships no types; this is its whole surface as used here. */
declare module "heic-decode" {
  const decode: (input: {
    buffer: Uint8Array;
  }) => Promise<{ width: number; height: number; data: ArrayBuffer }>;
  export default decode;
}
