import _sodium from "libsodium-wrappers-sumo";

let initialized = false;

/** Resolves once libsodium's WASM module is loaded. Call before any other function. */
export async function ready(): Promise<void> {
  await _sodium.ready;
  initialized = true;
}

export function sodium(): typeof _sodium {
  if (!initialized) {
    throw new Error("crypto not initialized: await ready() first");
  }
  return _sodium;
}
