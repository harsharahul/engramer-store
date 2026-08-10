/**
 * The frame identity for one attempt at opening a document.
 *
 * The editor announces itself exactly once per document load, and the
 * session that answers that announce is built by the open effect. A resync
 * builds a NEW session, so it must be given a NEW frame: a session created
 * against a frame that already announced waits forever for an announce that
 * has already happened. Binding the iframe's key to this value makes that
 * structural rather than remembered.
 */
export function editorFrameKey(fileId: string, fileType: string, reloadNonce: number): string {
  return `${fileId}|${fileType}|${reloadNonce}`;
}
