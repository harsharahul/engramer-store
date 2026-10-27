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

/** The record a file holds, or undefined when it is not one this version reads. */
export function parseEmailRecord(json: string): EmailRecord | undefined {
  try {
    const value = JSON.parse(json) as Partial<EmailRecord> | null;
    return value && value.v === 1 && typeof value.subject === "string" ? (value as EmailRecord) : undefined;
  } catch {
    return undefined;
  }
}
