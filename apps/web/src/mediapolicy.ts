/**
 * What the service worker's media bridge may serve, and to whom.
 *
 * The bridge answers /media/<fileId> with DECRYPTED bytes on the app's own
 * origin. That is exactly what a media element needs and exactly what no
 * other kind of request may have: a navigation to that path would render
 * whatever the file holds as a same-origin document, and a file that
 * arrived from a stranger (a file request, a shared document) can hold
 * anything. So the bridge serves only video and audio, only to media
 * elements, and marks every response as something that cannot become a
 * document even if a browser were to try.
 */

/** Video and audio, and nothing a browser could render or execute. */
export function isStreamableMime(mime: string): boolean {
  const type = mime.trim().toLowerCase();
  return /^(video|audio)\/[a-z0-9.+-]+$/.test(type);
}

/** The request came from a media element, not a navigation or a fetch. */
export function isMediaFetch(request: { mode: string; destination: string }): boolean {
  if (request.mode === "navigate") {
    return false;
  }
  return request.destination === "video" || request.destination === "audio";
}

/**
 * Headers for a bridge response: the registered media type, pinned
 * against sniffing, under a policy that refuses to be a document, and
 * readable by this origin alone.
 */
export function mediaResponseHeaders(mime: string): Record<string, string> {
  return {
    "content-type": mime,
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'",
    "cross-origin-resource-policy": "same-origin",
  };
}
