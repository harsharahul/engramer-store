import { describe, expect, it } from "vitest";
import { parseEmailRecord } from "./kind";

const valid = {
  v: 1,
  messageId: "<k1@example.com>",
  date: 0,
  from: { name: "Example Sender", address: "sender@example.com" },
  to: ["owner@example.com"],
  cc: [],
  subject: "Hello",
  headers: "",
  inline: [],
  attachments: [],
  source: { kind: "import", label: "export.mbox" },
};

describe("parseEmailRecord", () => {
  it("reads a record this version wrote", () => {
    expect(parseEmailRecord(JSON.stringify(valid))).toEqual(valid);
  });

  it("refuses a file that only looks like a record, so the viewer never meets it", () => {
    // Any file can be named .email, and one can be shared in by anyone.
    expect(parseEmailRecord(JSON.stringify({ v: 1, subject: "Hello" }))).toBeUndefined();
    expect(parseEmailRecord(JSON.stringify({ ...valid, from: "sender@example.com" }))).toBeUndefined();
    expect(parseEmailRecord(JSON.stringify({ ...valid, to: "owner@example.com" }))).toBeUndefined();
    expect(parseEmailRecord(JSON.stringify({ ...valid, inline: [{ cid: 1 }] }))).toBeUndefined();
    expect(parseEmailRecord(JSON.stringify({ ...valid, attachments: [{ name: "a.pdf" }] }))).toBeUndefined();
    expect(parseEmailRecord(JSON.stringify({ ...valid, html: 42 }))).toBeUndefined();
    expect(parseEmailRecord("not json")).toBeUndefined();
  });
});
