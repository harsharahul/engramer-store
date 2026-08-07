/// <reference types="vite/client" />

/** The release this bundle was built from; see define() in vite.config.ts. */
declare const __APP_VERSION__: string;

/** heic-decode ships no types; this is its whole surface as used here. */
declare module "heic-decode" {
  const decode: (input: {
    buffer: Uint8Array;
  }) => Promise<{ width: number; height: number; data: ArrayBuffer }>;
  export default decode;
}
