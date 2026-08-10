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

export type StartupStall = "none" | "blocked" | "slow";

/**
 * An editor that has not announced itself while this origin is plainly
 * reachable is not slow, it is being refused: a content blocker treating
 * the sandboxed frame's null-origin subresource requests as third party.
 * Naming that is worth more than another two minutes of spinner. When the
 * origin probe fails too, the link itself is struggling and patience is
 * still the right answer.
 */
export function describeStartupStall(input: {
  announced: boolean;
  originAlive: boolean;
}): StartupStall {
  if (input.announced) {
    return "none";
  }
  return input.originAlive ? "blocked" : "slow";
}
