import { isHandheld } from "./analysisslot";
import { nativeExportFile, nativeListen, nativeShell } from "./native";
import { IntegrityError, downloadAndDecrypt } from "./transfer";
import { openSharedContent } from "./openshared";
import { beginSave, endSave, updateSave, type SavePhase } from "./saveprogress";
import { useStore, type FileEntry } from "./store";

/** What the shell's save-progress events carry. */
interface SaveEvent {
  fileId: string;
  phase: SavePhase;
  done: number;
  total: number | null;
}

/**
 * Hands a file's plaintext to the person. On a handheld shell the bytes
 * stream natively, decrypt file to file, and the share sheet opens so
 * they choose where it goes: AirDrop, another app, any folder in Files.
 * Nothing is held in the page, whatever the size; the in-page path
 * decrypts the whole file into memory plus a Blob copy, and past a few
 * hundred megabytes iOS killed the content process and silently reloaded
 * the page. Browsers keep their anchor download. Both paths narrate
 * through the shared save record, so every surface shows one overlay.
 */
export async function saveDecryptedFile(file: FileEntry): Promise<void> {
  beginSave(file.id, file.name);
  try {
    if (isHandheld() && nativeShell()) {
      const token = useStore.getState().session?.token;
      if (token) {
        const stop = await nativeListen<SaveEvent>("save-progress", (event) => {
          if (event.fileId === file.id) {
            updateSave(file.id, event.phase, event.done, event.total ?? null);
          }
        });
        try {
          const exported = await nativeExportFile(
            { id: file.id, name: file.name, key: file.key, ...(file.digest ? { digest: file.digest } : {}) },
            token,
          );
          if (exported !== null) {
            // The sheet is on screen; it takes the story from here.
            return;
          }
        } finally {
          stop();
        }
      }
    }
    let bytes: Uint8Array;
    try {
      // A shared entry's digest can merely be stale; refresh and retry
      // before concluding anything about the bytes themselves.
      bytes = await openSharedContent(file, (entry) =>
        downloadAndDecrypt(entry.id, entry.key, entry.digest, {
          preferLocal: true,
          onProgress: (loaded, total) => updateSave(file.id, "download", loaded, total),
        }),
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
  } finally {
    endSave(file.id);
  }
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
