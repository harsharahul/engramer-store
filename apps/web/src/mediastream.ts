import { useStore } from "./store";
import { diag } from "./diag";
import { nativeMediaRegister, nativeMediaUrl, nativeShell } from "./native";
import { isStreamableMime } from "./mediapolicy";

/**
 * Page side of the media bridge: the service worker serves decrypted
 * video and audio at /media/<fileId>, and this module hands it the file
 * keys it needs, by message only. Keys never touch storage on either side.
 */

export function mediaUrl(fileId: string): string {
  // The desktop shell serves media through its native protocol: range
  // requests are answered in-process, so WKWebView's many short reads
  // cost no network round trips. Browsers keep the service worker path.
  return nativeShell() ? nativeMediaUrl(fileId) : `/media/${fileId}`;
}

/** The browser path, used as a fallback if the native protocol fails. */
export function bridgeMediaUrl(fileId: string): string {
  return `/media/${fileId}`;
}

export function mediaBridgeAvailable(): boolean {
  return "serviceWorker" in navigator && navigator.serviceWorker.controller !== null;
}

function postKey(fileId: string): void {
  const state = useStore.getState();
  const file = state.files.get(fileId);
  const token = state.session?.token;
  const controller = navigator.serviceWorker?.controller;
  if (!file || !token || !controller) {
    return;
  }
  // The worker asks for keys by file id alone, and the library holds files
  // other people wrote. Only a file that is actually video or audio gets
  // its key handed across; the worker checks again on its side.
  if (!isStreamableMime(file.mime)) {
    return;
  }
  controller.postMessage({
    type: "media-key",
    fileId,
    key: file.key.slice().buffer,
    token,
    mime: file.mime,
    size: file.size,
  });
}

/** Pushes a file's key to the worker ahead of setting a media src. */
export function registerMediaKey(fileId: string): void {
  postKey(fileId);
  if (nativeShell()) {
    const state = useStore.getState();
    const file = state.files.get(fileId);
    const token = state.session?.token;
    if (file && token) {
      void nativeMediaRegister(fileId, file.key, token, file.mime);
    }
  }
}

/**
 * Answers the worker's key requests for the whole session, so a restarted
 * worker can resume serving without any user-visible hiccup.
 */
export function installMediaKeyResponder(): () => void {
  if (!("serviceWorker" in navigator)) {
    return () => {};
  }
  const onMessage = (event: MessageEvent) => {
    const data = event.data as { type?: string; fileId?: string; chunk?: number; kind?: string } | undefined;
    if (data?.type === "media-key-request" && data.fileId) {
      postKey(data.fileId);
    }
    if (data?.type === "media-upstream" && data.fileId) {
      const name = useStore.getState().files.get(data.fileId)?.name ?? data.fileId.slice(0, 8);
      diag("stream", `${name} upstream ${data.kind} at chunk ${data.chunk}`);
    }
  };
  navigator.serviceWorker.addEventListener("message", onMessage);
  return () => navigator.serviceWorker.removeEventListener("message", onMessage);
}

/** Subscribes to legacy-stream decrypt progress for one file. */
export function onMediaProgress(
  fileId: string,
  handler: (loaded: number, total: number) => void,
): () => void {
  if (!("serviceWorker" in navigator)) {
    return () => {};
  }
  const onMessage = (event: MessageEvent) => {
    const data = event.data as
      | { type?: string; fileId?: string; loaded?: number; total?: number }
      | undefined;
    if (data?.type === "media-progress" && data.fileId === fileId) {
      handler(data.loaded ?? 0, data.total ?? 0);
    }
  };
  navigator.serviceWorker.addEventListener("message", onMessage);
  return () => navigator.serviceWorker.removeEventListener("message", onMessage);
}
