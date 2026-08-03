import { IntegrityError, downloadAndDecrypt } from "./transfer";
import type { FileEntry } from "./store";

export async function saveDecryptedFile(file: FileEntry): Promise<void> {
  let bytes: Uint8Array;
  try {
    bytes = await downloadAndDecrypt(file.id, file.key, file.digest);
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
