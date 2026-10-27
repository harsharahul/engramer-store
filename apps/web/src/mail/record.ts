/**
 * One parsed message, made into what the vault stores: an email record (a
 * small JSON file holding the headers, the readable body, and the images
 * the body shows) plus a real file for every attachment.
 *
 * Inline images the body refers to by cid stay in the record while they are
 * small, so the email reads complete; anything larger, or not shown by the
 * body, becomes a file of its own. Tracking pixels are dropped.
 */

import { contentDigest, type MailMeta } from "@engramer/crypto";
import type { ParsedMessage } from "../intel/mime";

/** The record's file type. */
export const EMAIL_MIME = "application/vnd.engram.email+json";

/** Caps on what one record holds, in bytes. */
export const HEADERS_MAX = 64 * 1024;
export const TEXT_MAX = 1024 * 1024;
export const HTML_MAX = 2 * 1024 * 1024;
/** An inline part stays in the record only up to this size... */
export const INLINE_PART_MAX = 256 * 1024;
/** ...and while the record's inline parts stay within this in total. */
export const INLINE_TOTAL_MAX = 1024 * 1024;
/** Recipients kept in the metadata; the record keeps them all. */
const META_TO_MAX = 10;
/** Below this, a nameless image is a tracking pixel, not a picture. */
const PIXEL_BYTES = 100;
const NAME_MAX = 120;
const FALLBACK_BODY = 1024;

export interface EmailRecord {
  v: 1;
  /** The Message-ID header, or empty when the message has none. */
  messageId: string;
  date: number;
  from: { name: string; address: string };
  to: string[];
  cc: string[];
  subject: string;
  /** The raw header block, capped. */
  headers: string;
  text?: string;
  html?: string;
  /** Images the HTML shows by cid, as standard base64. */
  inline: { cid: string; mime: string; data: string }[];
  /** The files that came with it. Their ids are in the metadata's
   * `mail.attachmentIds`, in this order: the record is stored first. */
  attachments: { name: string; mime: string; size: number; digest: string }[];
  source: { kind: "import"; label: string };
}

export interface BuiltAttachment {
  name: string;
  mime: string;
  bytes: Uint8Array;
  digest: string;
}

export interface BuiltEmail {
  record: EmailRecord;
  /** The record's file name. */
  name: string;
  meta: MailMeta;
  attachments: BuiltAttachment[];
  /** What makes this message the same message on a second import. */
  dedupeKey: string;
}

type Address = NonNullable<ParsedMessage["from"]>;
type Mailbox = { name: string; address: string };

function mailboxes(list: Address[] | undefined): Mailbox[] {
  return (list ?? []).flatMap((entry) => (entry.group ? entry.group : [entry as Mailbox]));
}

/** Cuts text to at most `max` UTF-8 bytes, never mid-character. */
function capText(text: string, max: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= max) {
    return text;
  }
  return new TextDecoder().decode(bytes.subarray(0, max)).replace(/�+$/, "");
}

/** The header block of the raw message: everything before the first blank line. */
function headerBlock(raw: Uint8Array): string {
  const scan = raw.subarray(0, Math.min(raw.length, HEADERS_MAX + 4));
  let end = scan.length;
  for (let i = 0; i + 1 < scan.length; i++) {
    if (scan[i] === 0x0a && (scan[i + 1] === 0x0a || (scan[i + 1] === 0x0d && scan[i + 2] === 0x0a))) {
      end = i;
      break;
    }
  }
  return capText(new TextDecoder().decode(scan.subarray(0, end)).replace(/\r$/, ""), HEADERS_MAX);
}

/** The Date header, or the date of the newest Received line, or 0. */
function messageDate(parsed: ParsedMessage): number {
  const sent = Date.parse(parsed.date ?? "");
  if (!Number.isNaN(sent)) {
    return sent;
  }
  const received = parsed.headers.find((header) => header.key === "received");
  const stamp = received ? Date.parse(received.value.split(";").pop() ?? "") : NaN;
  return Number.isNaN(stamp) ? 0 : stamp;
}

const EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/json": "json",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "text/plain": "txt",
  "text/html": "html",
  "text/calendar": "ics",
  "text/csv": "csv",
  "message/rfc822": "eml",
};

/** A name that is safe as one path segment: no slashes or control characters. */
function safeName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[\\/]/g, "-").replace(/\s+/g, " ").trim();
  return clean.length > NAME_MAX ? clean.slice(0, NAME_MAX).trim() : clean;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function partBytes(content: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof content === "string") {
    return new TextEncoder().encode(content);
  }
  return content instanceof Uint8Array ? content : new Uint8Array(content);
}

/** Whether an image header says 1x1 (GIF and PNG carry it at fixed offsets). */
function onePixel(bytes: Uint8Array, mime: string): boolean {
  if (mime === "image/gif" && bytes.length >= 10) {
    return (bytes[6]! | (bytes[7]! << 8)) === 1 && (bytes[8]! | (bytes[9]! << 8)) === 1;
  }
  if (mime === "image/png" && bytes.length >= 24) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return view.getUint32(16) === 1 && view.getUint32(20) === 1;
  }
  return false;
}

export function buildEmail(
  parsed: ParsedMessage,
  raw: Uint8Array,
  source: { label: string },
): BuiltEmail {
  const sender = mailboxes(parsed.from ? [parsed.from] : undefined)[0] ?? { name: "", address: "" };
  const from = { name: sender.name || sender.address, address: sender.address };
  const to = mailboxes(parsed.to).map((box) => box.address).filter(Boolean);
  const cc = mailboxes(parsed.cc).map((box) => box.address).filter(Boolean);
  const subject = (parsed.subject ?? "").trim();
  const date = messageDate(parsed);
  const html = parsed.html ? capText(parsed.html, HTML_MAX) : undefined;
  const text = parsed.text ? capText(parsed.text, TEXT_MAX) : undefined;
  const htmlLower = (parsed.html ?? "").toLowerCase();

  const inline: EmailRecord["inline"] = [];
  const attachments: BuiltAttachment[] = [];
  let inlineTotal = 0;
  for (const part of parsed.attachments) {
    const bytes = partBytes(part.content);
    const mime = (part.mimeType || "application/octet-stream").toLowerCase();
    const isImage = mime.startsWith("image/");
    if (isImage && !part.filename && (bytes.length < PIXEL_BYTES || onePixel(bytes, mime))) {
      continue;
    }
    const cid = (part.contentId ?? "").replace(/^<|>$/g, "");
    const shown = cid !== "" && htmlLower.includes(`cid:${cid.toLowerCase()}`);
    if (shown && bytes.length <= INLINE_PART_MAX && inlineTotal + bytes.length <= INLINE_TOTAL_MAX) {
      inline.push({ cid, mime, data: toBase64(bytes) });
      inlineTotal += bytes.length;
      continue;
    }
    const extension = EXTENSIONS[mime] ?? "bin";
    const n = attachments.length + 1;
    const name =
      safeName(part.filename ?? "") || `${isImage ? "image" : "attachment"}-${n}.${extension}`;
    attachments.push({ name, mime, bytes, digest: contentDigest(bytes) });
  }

  const messageId = (parsed.messageId ?? "").trim();
  const body = (parsed.text ?? parsed.html ?? "").slice(0, FALLBACK_BODY);
  const dedupeKey =
    messageId ||
    `nomid:${contentDigest(new TextEncoder().encode(`${date}|${from.address}|${subject}|${body}`))}`;

  const record: EmailRecord = {
    v: 1,
    messageId,
    date,
    from,
    to,
    cc,
    subject,
    headers: headerBlock(raw),
    ...(text !== undefined ? { text } : {}),
    ...(html !== undefined ? { html } : {}),
    inline,
    attachments: attachments.map(({ name, mime, bytes, digest }) => ({
      name,
      mime,
      size: bytes.length,
      digest,
    })),
    source: { kind: "import", label: source.label },
  };

  return {
    record,
    name: `${safeName(subject) || "(no subject)"}.email`,
    meta: {
      messageId: dedupeKey,
      from: from.name,
      fromAddress: from.address,
      to: to.slice(0, META_TO_MAX),
      date,
      subject,
      attachmentIds: [],
    },
    attachments,
    dedupeKey,
  };
}
