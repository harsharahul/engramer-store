import { isHandheld } from "./analysisslot";
import { nativeSaveDownload, nativeShell } from "./native";
import { IntegrityError, downloadAndDecrypt } from "./transfer";
import { openSharedContent } from "./openshared";
import { useStore, type FileEntry } from "./store";

/**
 * Saves a file where the person can reach it. On a handheld shell the
 * bytes stream natively into Documents/Downloads (the Files app shows
 * it), never held in the page: the in-page path decrypts the whole file
 * into memory plus a Blob copy, and past a few hundred megabytes iOS
 * killed the content process and silently reloaded the page. Returns a
 * sentence saying where the file went when the shell saved it; null when
 * the browser handled it its own way.
 */
export async function saveDecryptedFile(file: FileEntry): Promise<string | null> {
  if (isHandheld() && nativeShell()) {
    const token = useStore.getState().session?.token;
    if (token) {
      const saved = await nativeSaveDownload(
        { id: file.id, name: file.name, key: file.key, ...(file.digest ? { digest: file.digest } : {}) },
        token,
      );
      if (saved !== null) {
        return `Saved to the Files app: On My iPhone › Engram Store › Downloads › ${saved}`;
      }
    }
  }
  let bytes: Uint8Array;
  try {
    // A shared entry's digest can merely be stale; refresh and retry
    // before concluding anything about the bytes themselves.
    bytes = await openSharedContent(file, (entry) =>
      downloadAndDecrypt(entry.id, entry.key, entry.digest),
    );
  } catch (err) {
    // A file that fails its check is still handed over: something is better
    // than nothing when the alternative is an unreachable file.
    if (!(err instanceof IntegrityError)) {
      throw err;
    }
    bytes = err.bytes;
  }
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], {
    type: file.mime || "application/octet-stream",
  });
  triggerDownload(blob, file.name);
  return null;
}

export function triggerDownload(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
