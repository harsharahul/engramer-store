/**
 * Bridge to the desktop shell, when there is one. The web app never assumes
 * a native layer: every helper degrades to "not available" in a plain
 * browser, and callers fall back to the browser-native path (WebAuthn).
 * The shell exposes exactly four commands, all about the unlock secret;
 * key material still lives and is used only inside this web context.
 */

import { diag } from "./diag";

type TauriInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

function tauriInvoke(): TauriInvoke | null {
  const shell = (
    window as { __TAURI__?: { core?: { invoke?: TauriInvoke } } }
  ).__TAURI__;
  return shell?.core?.invoke ?? null;
}

/** True when running inside the desktop shell. */
export function nativeShell(): boolean {
  return tauriInvoke() !== null;
}

/** True when the shell can gate secrets behind Touch ID (or the login
 * password on Macs without it). */
export async function nativeUnlockAvailable(): Promise<boolean> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return false;
  }
  try {
    return (await invoke("native_unlock_available")) === true;
  } catch {
    return false;
  }
}

/** Thrown message fragment when the user dismissed the biometric prompt. */
export const NATIVE_CANCELLED = "cancelled";

export async function nativeSecretStore(email: string, secret: string): Promise<void> {
  const invoke = tauriInvoke();
  if (!invoke) {
    throw new Error("no native shell");
  }
  await invoke("unlock_secret_store", { email, secret });
}

export async function nativeSecretGet(email: string): Promise<string> {
  const invoke = tauriInvoke();
  if (!invoke) {
    throw new Error("no native shell");
  }
  const secret = await invoke("unlock_secret_get", { email });
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error("no secret");
  }
  return secret;
}

export async function nativeSecretDelete(email: string): Promise<void> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return;
  }
  await invoke("unlock_secret_delete", { email }).catch(() => {});
}

// ----- extension handoff (shared keychain; iOS extensions read it) -----

/** True when the shell can persist a handoff record for app extensions. */
export async function nativeHandoffAvailable(): Promise<boolean> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return false;
  }
  try {
    return (await invoke("handoff_available")) === true;
  } catch {
    return false;
  }
}

export async function nativeHandoffStore(email: string, payload: string): Promise<void> {
  const invoke = tauriInvoke();
  if (!invoke) {
    throw new Error("no native shell");
  }
  await invoke("handoff_store", { email, payload });
}

export async function nativeHandoffGet(email: string): Promise<string | null> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return null;
  }
  try {
    const record = await invoke("handoff_get", { email });
    return typeof record === "string" ? record : null;
  } catch {
    return null;
  }
}

/** What the extension-shaped keychain lookup finds, run from inside the app. */
export type HandoffProbeResult =
  | { state: "found"; bytes: number }
  | { state: "missing" }
  | { state: "error"; detail: string };

export async function nativeHandoffProbe(): Promise<HandoffProbeResult> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return { state: "missing" };
  }
  try {
    const found = await invoke("handoff_probe");
    return typeof found === "number" ? { state: "found", bytes: found } : { state: "missing" };
  } catch (error) {
    return { state: "error", detail: String(error) };
  }
}

export async function nativeHandoffClear(email: string): Promise<void> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return;
  }
  await invoke("handoff_clear", { email }).catch(() => {});
}

// ----- Files-app provider (iOS; registers the vault as a drive) -----

export async function nativeFilesProviderEnable(email: string): Promise<void> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return;
  }
  await invoke("files_provider_enable", { email }).catch(() => {});
}

/** Asks the Files app to re-enumerate the drive after a reconnect. */
export async function nativeFilesProviderSignal(email: string): Promise<void> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return;
  }
  await invoke("files_provider_signal", { email }).catch(() => {});
}

export async function nativeFilesProviderDisable(email: string): Promise<void> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return;
  }
  await invoke("files_provider_disable", { email }).catch(() => {});
}

// ----- server override (one binary, many servers) -----

/** The stored server override, or null when the build's default is in use. */
export async function nativeServerUrlGet(): Promise<string | null> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return null;
  }
  try {
    const url = await invoke("server_url_get");
    return typeof url === "string" ? url : null;
  } catch {
    return null;
  }
}

/** Persists a new server and navigates the shell to it. */
export async function nativeServerUrlSet(url: string): Promise<void> {
  const invoke = tauriInvoke();
  if (!invoke) {
    throw new Error("no native shell");
  }
  await invoke("server_url_set", { url });
}

/** Back to the build's own default server. */
export async function nativeServerUrlClear(): Promise<void> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return;
  }
  await invoke("server_url_clear").catch(() => {});
}

// ----- photo library (iOS; automatic backup) -----

export interface NativePhotoAsset {
  id: string;
  kind: "image" | "video";
  filename: string;
  mtime_ms: number;
  screenshot: boolean;
}

export async function nativePhotosAvailable(): Promise<boolean> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return false;
  }
  try {
    return (await invoke("photos_available")) === true;
  } catch {
    return false;
  }
}

/** Requests full-library access; resolves to the resulting status. */
export async function nativePhotosAuthorize(): Promise<string> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return "denied";
  }
  return (await invoke("photos_authorize")) as string;
}

export async function nativePhotosList(): Promise<NativePhotoAsset[]> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return [];
  }
  return (await invoke("photos_list")) as NativePhotoAsset[];
}

/** Exports one asset's original and reads it back as a File (originals
 * intact), reusing the picker's own read-and-delete bridge. */
export async function nativePhotoFile(id: string): Promise<File | null> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return null;
  }
  const path = (await invoke("photos_export", { id })) as string;
  const name = path.split("/").pop() || "photo";
  const bytes = fileBytes(await invoke("picked_file_read", { path }));
  return new File([bytes as BlobPart], name, { type: mimeFromName(name) });
}

// ----- watched folders (desktop shell only) -----

export interface WatchedFile {
  path: string;
  name: string;
  rel_dirs: string[];
  size: number;
  mtime: number;
}

export async function watchedFolders(): Promise<string[]> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return [];
  }
  return (await invoke("watched_folders")) as string[];
}

export async function watchedAdd(path: string): Promise<string[]> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return [];
  }
  return (await invoke("watched_add", { path })) as string[];
}

export async function watchedRemove(path: string): Promise<string[]> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return [];
  }
  return (await invoke("watched_remove", { path })) as string[];
}

export async function watchedScan(): Promise<WatchedFile[]> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return [];
  }
  return (await invoke("watched_scan")) as WatchedFile[];
}

/**
 * File content as bytes, whatever shape the shell hands it over in.
 *
 * This crossing has no type safety: the value arrives as JSON from another
 * process, and declaring it an ArrayBuffer only asserted a hope. It arrives
 * as a plain array of byte values, and `new Blob([array])` does not reject
 * that: it stringifies it, so a PDF became the text "37,80,68,70,..." and
 * every file a watched folder uploaded was silently corrupted, at three and
 * a half times its real size. Convert rather than assert.
 */
export function fileBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) {
    return Uint8Array.from(value as number[]);
  }
  throw new Error("the shell returned something that is not file content");
}

export async function watchedFileRead(path: string): Promise<Uint8Array> {
  const invoke = tauriInvoke();
  if (!invoke) {
    throw new Error("no native shell");
  }
  return fileBytes(await invoke("watched_file_read", { path }));
}

/**
 * The type a picked file's name implies, or "" when the name does not say.
 *
 * The shell hands over paths rather than browser `File`s, so nothing sets a
 * type and everything downstream branches on one. Only the formats a photo
 * library actually holds are listed: an empty answer is honest and can be
 * recovered from the name later, a wrong one cannot.
 */
export function mimeFromName(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const known: Record<string, string> = {
    heic: "image/heic",
    heif: "image/heif",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    tiff: "image/tiff",
    dng: "image/x-adobe-dng",
    mov: "video/quicktime",
    mp4: "video/mp4",
    m4v: "video/x-m4v",
  };
  return known[ext] ?? "";
}

/**
 * The system photo picker, as `File`s carrying the ORIGINAL bytes.
 *
 * A web file input cannot get these on iOS: the system transcodes HEIC to
 * JPEG on the way out, whatever the accept attribute says, so the page never
 * sees what the camera recorded. The shell's picker asks for each asset as
 * stored instead. Returns null where there is no such picker (every browser,
 * and any shell too old to carry the command), so callers fall back to the
 * file input rather than losing the ability to add photos at all.
 */
export async function pickPhotos(): Promise<File[] | null> {
  const invoke = tauriInvoke();
  if (!invoke) {
    // Distinct from a failed call: no shell at all, or its bridge was never
    // injected into this page, which is what a capability mismatch looks like.
    diag("photos", "no shell bridge on this page; using the file input");
    return null;
  }
  let paths: unknown;
  try {
    paths = await invoke("pick_photos", {});
  } catch (err) {
    // An older shell, or a platform without the picker. Falling back is
    // right, but silently is not: it looks identical to the picker running
    // and handing back a transcoded file, which is the bug it exists to fix.
    diag("photos", `native picker unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  if (!Array.isArray(paths)) {
    diag("photos", `native picker returned ${typeof paths}, not a list of paths`);
    return null;
  }
  diag("photos", `native picker returned ${paths.length} item(s)`);
  const files: File[] = [];
  for (const path of paths as string[]) {
    const name = path.split("/").pop() || "photo";
    try {
      const bytes = fileBytes(await invoke("picked_file_read", { path }));
      files.push(new File([bytes as BlobPart], name, { type: mimeFromName(name) }));
    } catch (err) {
      // Skip the one that failed rather than abandoning the batch, and never
      // fall back to the file input from here: the picker DID hand over
      // originals, and quietly re-picking them would transcode instead.
      diag("photos", `could not read a picked file: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return files;
}

/** Native folder picker; null when dismissed. */
export async function pickFolder(): Promise<string | null> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return null;
  }
  const chosen = await invoke("plugin:dialog|open", {
    options: { directory: true, multiple: false },
  });
  return typeof chosen === "string" ? chosen : null;
}

/** Subscribes to shell events; returns an unsubscribe, or a no-op outside
 * the shell. */
export async function nativeListen<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  const shell = (
    window as {
      __TAURI__?: {
        event?: { listen?: (e: string, cb: (ev: { payload: T }) => void) => Promise<() => void> };
      };
    }
  ).__TAURI__;
  if (!shell?.event?.listen) {
    return () => {};
  }
  return shell.event.listen(event, (ev) => handler(ev.payload));
}

// ----- native media path (desktop shell only) -----

/** The shell's media protocol answers range requests locally. */
export function nativeMediaUrl(fileId: string): string {
  return `stream://localhost/${fileId}`;
}

export async function nativeMediaRegister(
  fileId: string,
  key: Uint8Array,
  token: string,
  mime: string,
): Promise<boolean> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return false;
  }
  let b64 = "";
  for (let i = 0; i < key.length; i += 0x8000) {
    b64 += String.fromCharCode(...key.subarray(i, i + 0x8000));
  }
  try {
    await invoke("media_register", {
      fileId,
      key: btoa(b64),
      token,
      base: location.origin,
      mime,
    });
    return true;
  } catch {
    return false;
  }
}

/** Locking or signing out revokes every key the shell holds. */
export async function nativeMediaClear(): Promise<void> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return;
  }
  await invoke("media_clear").catch(() => {});
}
