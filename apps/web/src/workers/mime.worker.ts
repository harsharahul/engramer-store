/// <reference lib="webworker" />
/**
 * The message parser, off the main thread.
 *
 * One parser reads every email, imported or fetched: postal-mime turns raw
 * RFC 822 bytes into headers, text, HTML and decoded attachments. A large
 * import parses thousands of messages, so it runs here where a slow one
 * cannot stall the interface. Nothing in this worker talks to the network.
 */

import PostalMime, { type Email } from "postal-mime";

/** Parses one raw message. Attachment contents come back as ArrayBuffers. */
export function parseRaw(raw: Uint8Array): Promise<Email> {
  return PostalMime.parse(raw, { attachmentEncoding: "arraybuffer" });
}

interface Ask {
  id: number;
  raw: Uint8Array;
}

// Only when loaded as a worker; tests import parseRaw directly.
if (typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope) {
  self.onmessage = async (event: MessageEvent<Ask>) => {
    const { id, raw } = event.data;
    try {
      const email = await parseRaw(raw);
      const transfer = email.attachments
        .map((attachment) => attachment.content)
        .filter((content): content is ArrayBuffer => content instanceof ArrayBuffer);
      self.postMessage({ id, email }, transfer);
    } catch (error) {
      self.postMessage({ id, error: String(error) });
    }
  };
}
