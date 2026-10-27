/**
 * What makes a file an email record, kept apart from the record builder so
 * the file-kind and analysis paths can ask without loading the builder.
 */

import type { EmailRecord } from "./record";

/** The record's file type. */
export const EMAIL_MIME = "application/vnd.engram.email+json";

export function isEmailRecord(name: string, mime: string): boolean {
  return mime === EMAIL_MIME || /\.email$/i.test(name);
}

const isString = (value: unknown): value is string => typeof value === "string";
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);

/**
 * The record a file holds, or undefined when it is not one this version
 * reads. Every field the viewer touches is checked: any file can be named
 * .email, and one can be shared in by anyone.
 */
export function parseEmailRecord(json: string): EmailRecord | undefined {
  let value: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }
    value = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const from = value.from as Record<string, unknown> | null | undefined;
  const ok =
    value.v === 1 &&
    isString(value.messageId) &&
    typeof value.date === "number" &&
    typeof from === "object" &&
    from !== null &&
    isString(from.name) &&
    isString(from.address) &&
    isStrings(value.to) &&
    isStrings(value.cc) &&
    isString(value.subject) &&
    isString(value.headers) &&
    (value.text === undefined || isString(value.text)) &&
    (value.html === undefined || isString(value.html)) &&
    Array.isArray(value.inline) &&
    value.inline.every((part: Record<string, unknown>) => isString(part?.cid) && isString(part.mime) && isString(part.data)) &&
    Array.isArray(value.attachments) &&
    value.attachments.every(
      (part: Record<string, unknown>) =>
        isString(part?.name) && isString(part.mime) && typeof part.size === "number" && isString(part.digest),
    );
  return ok ? (value as unknown as EmailRecord) : undefined;
}
