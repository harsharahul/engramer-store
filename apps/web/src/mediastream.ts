import { useStore } from "./store";

/**
 * Page side of the media bridge: the service worker serves decrypted
 * video and audio at /media/<fileId>, and this module hands it the file
 * keys it needs, by message only. Keys never touch storage on either side.
 */

export function mediaUrl(fileId: string): string {
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
    const data = event.data as { type?: string; fileId?: string } | undefined;
    if (data?.type === "media-key-request" && data.fileId) {
      postKey(data.fileId);
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
