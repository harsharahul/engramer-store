/**
 * Bridge to the desktop shell, when there is one. The web app never assumes
 * a native layer: every helper degrades to "not available" in a plain
 * browser, and callers fall back to the browser-native path (WebAuthn).
 * The shell exposes exactly four commands, all about the unlock secret;
 * key material still lives and is used only inside this web context.
 */

import { diag } from "./diag";
import { fileBytes, mimeFromName, NativePickedFile } from "./nativefile";
import type { UploadSource } from "./transfer";

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

// ----- network path (Wi-Fi only enforcement needs the interface type) -----

/** What the shell's network monitor reports about the current path. */
export interface NativeNetworkStatus {
  /** False until the monitor has delivered its first update. */
  known: boolean;
  online: boolean;
  wifi: boolean;
  wired: boolean;
  cellular: boolean;
  expensive: boolean;
  constrained: boolean;
}

/** The current network path, or null when no shell monitor exists. */
export async function nativeNetworkStatus(): Promise<NativeNetworkStatus | null> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return null;
  }
  try {
    return (await invoke("network_status")) as NativeNetworkStatus;
  } catch {
    return null;
  }
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

// ----- File Provider (the vault as a system drive: Files on iOS, -----
// ----- the Finder sidebar on macOS)                              -----

/** True when this shell can register the vault as a system drive. */
export async function nativeFilesProviderAvailable(): Promise<boolean> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return false;
  }
  try {
    return (await invoke("files_provider_available")) === true;
  } catch {
    return false;
  }
}

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

// ----- share-sheet outbox (iOS; staged uploads the app can flush) -----

/** What a drain pass did with the extension's staged uploads. */
export interface OutboxDrainReport {
  uploaded: number;
  cleaned: number;
  pending: number;
}

export async function nativeOutboxDrain(): Promise<OutboxDrainReport | null> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return null;
  }
  try {
    return (await invoke("outbox_drain")) as OutboxDrainReport;
  } catch {
    return null;
  }
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
  /** Capture time; what a backup window filters on. */
  created_ms: number;
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

/** Exports one asset's original as an upload source (originals intact).
 * On a streaming shell the source is a handle whose bytes stay on disk
 * until the upload slices them; on an old shell the whole-file read
 * remains, and the backup pass holds videos back from it. Named from
 * `name` when the caller knows the library's own filename: the export
 * path prefixes the asset id for uniqueness on disk, and that prefix
 * used to leak into the vault as the stored name. */
export async function nativePhotoFile(id: string, name?: string): Promise<UploadSource | null> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return null;
  }
  const path = (await invoke("photos_export", { id })) as string;
  const chosen = name || path.split("/").pop() || "photo";
  if (await pickedStreamingAvailable()) {
    const stat = (await invoke("picked_file_stat", { path })) as {
      size: number;
      mtime_ms?: number;
    };
    return new NativePickedFile(invoke, path, {
      name: chosen,
      type: mimeFromName(chosen),
      size: stat.size,
      lastModified: stat.mtime_ms ?? Date.now(),
    });
  }
  const bytes = fileBytes(await invoke("picked_file_read", { path }));
  return new File([bytes as BlobPart], chosen, { type: mimeFromName(chosen) });
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

export { fileBytes, mimeFromName } from "./nativefile";

export async function watchedFileRead(path: string): Promise<Uint8Array> {
  const invoke = tauriInvoke();
  if (!invoke) {
    throw new Error("no native shell");
  }
  return fileBytes(await invoke("watched_file_read", { path }));
}

/** A file key the way shell commands take it: base64 over the raw bytes. */
function keyB64(key: Uint8Array): string {
  let raw = "";
  for (let i = 0; i < key.length; i += 0x8000) {
    raw += String.fromCharCode(...key.subarray(i, i + 0x8000));
  }
  return btoa(raw);
}

/**
 * Exports one vault file through the shell: ciphertext streams to disk,
 * the file-to-file decryptor verifies the digest in-pass, and the share
 * sheet opens on the result, where the person chooses where the
 * plaintext goes. The staged copy lives only as long as the sheet.
 * Returns the name the export landed under; null on a shell without the
 * command, so the caller keeps its in-page path. A shell that HAS the
 * command but fails throws: the in-page path holds whole files in
 * memory, and retrying a large one there is the crash this exists to end.
 */
export async function nativeExportFile(
  file: { id: string; name: string; key: Uint8Array; digest?: string },
  token: string,
): Promise<string | null> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return null;
  }
  try {
    return (await invoke("file_export", {
      fileId: file.id,
      key: keyB64(file.key),
      token,
      base: location.origin,
      name: file.name,
      digest: file.digest ?? null,
    })) as string;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (/not allowed|not found/i.test(reason)) {
      // An older shell: the command does not exist there.
      diag("download", "shell cannot export files; using the in-page path");
      return null;
    }
    throw new Error(reason);
  }
}

// ----- offline store (the shell's disk copy of files' ciphertext) -----

/** One stored file, for badges and the storage row. */
export interface NativeOfflineEntry {
  fileId: string;
  pinned: boolean;
  complete: boolean;
  bytes: number;
}

/**
 * A fully local file's ciphertext, or null when the store holds less
 * than all of it (or there is no shell): callers fetch from the server
 * exactly as they always did. Every failure is a null on purpose; the
 * offline store must never break an open, only skip the network.
 */
export async function nativeOfflineRead(fileId: string): Promise<Uint8Array | null> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return null;
  }
  try {
    return fileBytes(await invoke("offline_read", { fileId }));
  } catch {
    return null;
  }
}

/**
 * Downloads whatever spans are still missing, verifies the whole file
 * decrypts against its digest, and marks it kept: complete means "opens
 * with no network", and pinned means "never evicted for cache space".
 * Progress arrives as "pin-progress" shell events. False when the shell
 * cannot (old build, no space, offline): the caller reports, nothing
 * breaks.
 */
export async function nativeOfflinePin(
  file: { id: string; key: Uint8Array; digest?: string },
  token: string,
): Promise<boolean> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return false;
  }
  try {
    await invoke("offline_pin", {
      fileId: file.id,
      key: keyB64(file.key),
      token,
      base: location.origin,
      digest: file.digest ?? null,
    });
    return true;
  } catch (err) {
    diag("offline", `pin failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** Unpinned data stays cached until space is needed; only the promise
 * to keep it goes. */
export async function nativeOfflineUnpin(fileId: string): Promise<void> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return;
  }
  await invoke("offline_unpin", { fileId }).catch(() => {});
}

/** Everything the shell's store holds; empty outside the shell. */
export async function nativeOfflineStatus(): Promise<NativeOfflineEntry[]> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return [];
  }
  try {
    return (await invoke("offline_status")) as NativeOfflineEntry[];
  } catch {
    return [];
  }
}

/** Drops every unpinned cached file; answers the bytes freed. */
export async function nativeOfflineClearCache(): Promise<number> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return 0;
  }
  try {
    return (await invoke("offline_clear_cache")) as number;
  } catch {
    return 0;
  }
}

/** Signing out empties the store entirely, pins included. */
export async function nativeOfflineClear(): Promise<void> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return;
  }
  await invoke("offline_clear").catch(() => {});
}

/** A stored file whose bytes changed on the server is no longer the
 * file it promised to keep: drop the stale copy. */
export async function nativeOfflineRemove(fileId: string): Promise<void> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return;
  }
  await invoke("offline_remove", { fileId }).catch(() => {});
}

/**
 * Rebuilds the handle an interrupted upload was reading from, verifying
 * the bytes on disk are still the recorded ones by size. Null when the
 * file is gone or changed: there is nothing safe to continue.
 */
export async function nativeStagedSource(record: {
  path: string;
  family: "picked" | "watched";
  name: string;
  type: string;
  size: number;
  mtime: number;
  sourceId?: string;
}): Promise<UploadSource | null> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return null;
  }
  try {
    const command = record.family === "watched" ? "watched_file_stat" : "picked_file_stat";
    const stat = (await invoke(command, { path: record.path })) as {
      size: number;
      mtime_ms?: number;
    };
    if (stat.size !== record.size) {
      return null;
    }
    return new NativePickedFile(
      invoke,
      record.path,
      {
        name: record.name,
        type: record.type,
        size: stat.size,
        lastModified: stat.mtime_ms ?? record.mtime,
      },
      {
        family: record.family,
        ...(record.sourceId ? { sourceId: record.sourceId } : {}),
      },
    );
  } catch {
    return null;
  }
}

/** Sweeps the picker's staging directory, keeping only the named paths;
 * what interrupted uploads still need survives, the rest goes. */
export async function pickedSweep(keep: string[]): Promise<void> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return;
  }
  await invoke("picked_sweep", { keep }).catch(() => {});
}

/**
 * A watched file as a streamed handle: bounded windows over the bridge,
 * nothing deleted (the file is the person's own), media served through
 * the protocol's watched route. Null on a shell without the ranged
 * commands; the caller keeps its bounded whole-file read there.
 */
export async function watchedStreamedFile(file: {
  path: string;
  name: string;
  size: number;
  mtime: number;
}): Promise<UploadSource | null> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return null;
  }
  try {
    const stat = (await invoke("watched_file_stat", { path: file.path })) as {
      size: number;
      mtime_ms?: number;
    };
    return new NativePickedFile(
      invoke,
      file.path,
      {
        name: file.name,
        type: mimeFromName(file.name),
        size: stat.size,
        lastModified: stat.mtime_ms ?? file.mtime,
      },
      { family: "watched" },
    );
  } catch {
    return null;
  }
}

/**
 * Whether this shell can serve picked files in bounded windows. Old shells
 * only offer the whole-file read, which serialized entire videos through
 * the bridge and got the app killed for memory; on those, callers use the
 * browser file input instead, trading original bytes for staying alive
 * until the shell updates.
 */
export async function pickedStreamingAvailable(): Promise<boolean> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return false;
  }
  try {
    return (await invoke("picked_probe")) === true;
  } catch {
    return false;
  }
}

/**
 * The system photo picker, as upload sources carrying the ORIGINAL bytes.
 *
 * A web file input cannot get these on iOS: the system transcodes HEIC to
 * JPEG on the way out, whatever the accept attribute says, so the page never
 * sees what the camera recorded. The shell's picker asks for each asset as
 * stored instead, and hands back streamed HANDLES: no byte crosses the
 * bridge until the upload slices its 4 MiB windows. Returns null where
 * there is no such picker, or where the shell cannot stream (reading a
 * video whole is the memory kill this exists to end), so callers fall back
 * to the file input rather than losing the ability to add photos at all.
 */
export async function pickPhotos(): Promise<UploadSource[] | null> {
  const invoke = tauriInvoke();
  if (!invoke) {
    // Distinct from a failed call: no shell at all, or its bridge was never
    // injected into this page, which is what a capability mismatch looks like.
    diag("photos", "no shell bridge on this page; using the file input");
    return null;
  }
  if (!(await pickedStreamingAvailable())) {
    // Asked BEFORE the picker shows: an old shell should never stage
    // originals it has no safe way to hand over.
    diag("photos", "shell cannot stream picked files; using the file input");
    return null;
  }
  let entries: { path: string; id?: string | null }[];
  try {
    // Identities first: results say which library asset each file came
    // from, so the upload can stamp what the backup ledger keys on.
    entries = (await invoke("pick_photos_with_ids", {})) as { path: string; id?: string | null }[];
  } catch {
    let paths: unknown;
    try {
      paths = await invoke("pick_photos", {});
    } catch (err) {
      diag("photos", `native picker unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    if (!Array.isArray(paths)) {
      diag("photos", `native picker returned ${typeof paths}, not a list of paths`);
      return null;
    }
    entries = (paths as string[]).map((path) => ({ path }));
  }
  diag("photos", `native picker returned ${entries.length} item(s)`);
  const files: UploadSource[] = [];
  for (const { path, id } of entries) {
    const name = path.split("/").pop() || "photo";
    try {
      const stat = (await invoke("picked_file_stat", { path })) as {
        size: number;
        mtime_ms?: number;
      };
      files.push(
        new NativePickedFile(
          invoke,
          path,
          {
            name,
            type: mimeFromName(name),
            size: stat.size,
            lastModified: stat.mtime_ms ?? Date.now(),
          },
          id ? { sourceId: id } : undefined,
        ),
      );
    } catch (err) {
      // Skip the one that failed rather than abandoning the batch, and never
      // fall back to the file input from here: the picker DID hand over
      // originals, and quietly re-picking them would transcode instead.
      diag("photos", `could not stat a picked file: ${err instanceof Error ? err.message : String(err)}`);
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

/** The player for this file closed: the shell stops its background
 * warming and aborts its in-flight transfer, so a starved link belongs
 * entirely to whatever plays next. Reopening re-registers. */
export async function nativeMediaRelease(fileId: string): Promise<void> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return;
  }
  await invoke("media_release", { fileId }).catch(() => {});
}

/** Bytes per second of the file's last network window; 0 when unknown
 * or outside the shell. What the starvation offer is judged against. */
export async function nativeMediaPace(fileId: string): Promise<number> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return 0;
  }
  try {
    const pace = await invoke("media_pace", { fileId });
    return typeof pace === "number" ? pace : 0;
  } catch {
    return 0;
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
