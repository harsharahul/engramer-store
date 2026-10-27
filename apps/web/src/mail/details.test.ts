import { describe, expect, it } from "vitest";
import type { FileEntry } from "../store";
import { mailRows } from "./details";

const base = {
  folderId: null,
  mime: "application/pdf",
  size: 10,
  mtime: 0,
  hasText: false,
  hasClip: false,
  inlineText: false,
  tags: [],
  facts: [],
  favorite: false,
  key: new Uint8Array(32),
  hasThumb: false,
  trashed: false,
  createdAt: 0,
  updatedAt: 0,
};
const entry = (over: Partial<FileEntry> & { id: string; name: string }): FileEntry => ({ ...base, ...over });

const sent = Date.UTC(2026, 2, 3, 12);
const sentText = new Date(sent).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

const email = entry({
  id: "e1",
  name: "Lease renewal.email",
  mime: "application/vnd.engram.email+json",
  mail: {
    messageId: "<lease@example.com>",
    from: "Jane Example",
    fromAddress: "jane@example.com",
    to: ["owner@example.com", "partner@example.com"],
    date: sent,
    subject: "Lease renewal",
    attachmentIds: ["a1", "gone"],
  },
});
const lease = entry({ id: "a1", name: "lease-2026.pdf", mailParent: "e1" });
const files = new Map([
  [email.id, email],
  [lease.id, lease],
]);

describe("mailRows", () => {
  it("an email lists sender, recipients, date and attachments", () => {
    expect(mailRows(email, files)).toEqual([
      { label: "From", value: "Jane Example <jane@example.com>" },
      { label: "To", value: "owner@example.com, partner@example.com" },
      { label: "Sent", value: sentText },
      { label: "Attachment", value: "lease-2026.pdf", openId: "a1" },
    ]);
  });

  it("an attachment says which email it came with", () => {
    expect(mailRows(lease, files)).toEqual([
      { label: "Came with", value: `Lease renewal, from Jane Example, ${sentText}`, openId: "e1" },
    ]);
  });

  it("an attachment whose email is gone says so", () => {
    const orphan = entry({ id: "a2", name: "old.pdf", mailParent: "missing" });
    expect(mailRows(orphan, files)).toEqual([{ label: "Came with", value: "an email no longer in the vault" }]);
  });

  it("a file with no mail ties has no rows", () => {
    expect(mailRows(entry({ id: "x", name: "notes.txt" }), files)).toEqual([]);
  });
});
