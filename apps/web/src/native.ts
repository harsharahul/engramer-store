/**
 * Bridge to the desktop shell, when there is one. The web app never assumes
 * a native layer: every helper degrades to "not available" in a plain
 * browser, and callers fall back to the browser-native path (WebAuthn).
 * The shell exposes exactly four commands, all about the unlock secret;
 * key material still lives and is used only inside this web context.
 */

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
    return null;
  }
  let paths: unknown;
  try {
    paths = await invoke("pick_photos", {});
  } catch {
    // An older shell, or a platform without the picker.
    return null;
  }
  if (!Array.isArray(paths)) {
    return null;
  }
  const files: File[] = [];
  for (const path of paths as string[]) {
    const name = path.split("/").pop() || "photo";
    const bytes = fileBytes(await invoke("watched_file_read", { path }));
    files.push(new File([bytes as BlobPart], name, { type: mimeFromName(name) }));
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
