import { fromB64, toB64, utf8Decode, utf8Encode } from "@engramer/crypto";

/**
 * The fragment of a file-request link: what the upload page needs that the
 * server must not see or must not be able to change.
 *
 * The label lets the page greet the sender without the server storing it
 * in the clear. The owner's public key is the reason the fragment exists
 * at all: the sender seals every file key to it, and the server is the
 * only other place the sender could learn it from. Carried in the link,
 * which travels from owner to sender outside the server, the key the
 * server shows can be checked against the key the owner meant.
 */

export interface RequestLinkFragment {
  label: string;
  /** Absent on links minted before the key travelled with them. */
  publicKey?: string;
}

export function buildRequestFragment(label: string, publicKey: string): string {
  return toB64(utf8Encode(JSON.stringify({ l: label, k: publicKey })));
}

/** Reads either shape; a fragment that is not valid returns an empty label. */
export function parseRequestFragment(fragment: string): RequestLinkFragment {
  if (!fragment) {
    return { label: "" };
  }
  let text: string;
  try {
    text = utf8Decode(fromB64(fragment.replace(/^#/, "")));
  } catch {
    return { label: "" };
  }
  try {
    const parsed = JSON.parse(text) as { l?: unknown; k?: unknown };
    if (parsed && typeof parsed === "object" && typeof parsed.l === "string") {
      return typeof parsed.k === "string" && parsed.k.length > 0
        ? { label: parsed.l, publicKey: parsed.k }
        : { label: parsed.l };
    }
  } catch {
    // Links minted before the key travelled carried the bare label.
  }
  return { label: text };
}
