import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { contentDigest, ready } from "@engramer/crypto";
import { parseRaw } from "../workers/mime.worker";
import { buildEmail, EMAIL_MIME, INLINE_PART_MAX } from "./record";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

async function build(raw: Uint8Array) {
  return buildEmail(await parseRaw(raw), raw, { label: "export.mbox" });
}

const utf8 = new TextEncoder();

/** A related message whose HTML shows each image by cid. */
function withInlineImages(sizes: number[]): Uint8Array {
  const parts = sizes.map((size, n) => {
    const bytes = new Uint8Array(size).map((_, i) => (i * 31 + n) & 0xff);
    const b64 = Buffer.from(bytes).toString("base64").replace(/.{76}/g, "$&\r\n");
    return (
      `--rel\r\nContent-Type: image/png\r\nContent-ID: <img${n}@example>\r\n` +
      `Content-Disposition: inline\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64}\r\n`
    );
  });
  const html = sizes.map((_, n) => `<img src="cid:img${n}@example">`).join("");
  return utf8.encode(
    "From: sender@example.com\r\nSubject: Pictures\r\nMessage-ID: <pics@example.com>\r\n" +
      'MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="rel"\r\n\r\n' +
      `--rel\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}\r\n` +
      parts.join("") +
      "--rel--\r\n",
  );
}

describe("buildEmail", () => {
  beforeAll(async () => {
    await ready();
  });

  it("keeps text and html of an alternative message", async () => {
    const built = await build(fixture("alternative.eml"));
    expect(built.record.text?.trim()).toBe("The plain words.");
    expect(built.record.html).toContain("<i>rich</i>");
    expect(built.name).toBe("Plain and rich.email");
    expect(built.record).toMatchObject({
      v: 1,
      messageId: "<alt-1@example.com>",
      date: Date.UTC(2026, 0, 5, 9),
      from: { name: "Example Sender", address: "sender@example.com" },
      to: ["receiver@example.com"],
      cc: [],
      subject: "Plain and rich",
      source: { kind: "import", label: "export.mbox" },
    });
    expect(built.record.headers).toContain("Subject: Plain and rich");
    expect(built.meta).toEqual({
      messageId: "<alt-1@example.com>",
      from: "Example Sender",
      fromAddress: "sender@example.com",
      to: ["receiver@example.com"],
      date: Date.UTC(2026, 0, 5, 9),
      subject: "Plain and rich",
      attachmentIds: [],
    });
    expect(built.dedupeKey).toBe("<alt-1@example.com>");
    expect(built.attachments).toEqual([]);
    expect(EMAIL_MIME).toBe("application/vnd.engram.email+json");
  });

  it("keeps a referenced cid image inline", async () => {
    const built = await build(fixture("related-cid.eml"));
    expect(built.record.inline).toHaveLength(1);
    expect(built.record.inline[0]).toMatchObject({ cid: "logo1@example", mime: "image/png" });
    // Standard base64, so the viewer can put it in a data URL as it is.
    expect(atob(built.record.inline[0]!.data).length).toBe(1108);
    expect(built.attachments).toEqual([]);
  });

  it("decodes an RFC 2231 attachment name", async () => {
    const built = await build(fixture("rfc2231.eml"));
    expect(built.attachments.map((a) => a.name)).toEqual(["résumé 2026.pdf"]);
    expect(built.record.attachments[0]).toMatchObject({
      name: "résumé 2026.pdf",
      mime: "application/pdf",
    });
  });

  it("reads an ISO-8859-1 body", async () => {
    const built = await build(fixture("latin1.eml"));
    expect(built.record.text?.trim()).toBe("Café crème at the corner.");
  });

  it("survives a malformed boundary with the text it could read", async () => {
    const built = await build(fixture("malformed-boundary.eml"));
    expect(built.record.text?.trim()).toBe("The part that arrived.");
    // The cut-off part is kept as what arrived, under a name from its type.
    expect(built.attachments.map((a) => [a.name, a.bytes.length])).toEqual([["attachment-1.pdf", 6]]);
  });

  it("drops a tracking pixel", async () => {
    const built = await build(fixture("pixel.eml"));
    expect(built.record.inline).toEqual([]);
    expect(built.attachments).toEqual([]);
    expect(built.record.attachments).toEqual([]);
  });

  it("turns an oversized inline image into an attachment", async () => {
    const built = await build(withInlineImages([INLINE_PART_MAX + 1]));
    expect(built.record.inline).toEqual([]);
    expect(built.attachments.map((a) => [a.name, a.mime, a.bytes.length])).toEqual([
      ["image-1.png", "image/png", INLINE_PART_MAX + 1],
    ]);
  });

  it("keeps inline images only up to 1 MiB in total", async () => {
    const quarter = 250 * 1024;
    const built = await build(withInlineImages([quarter, quarter, quarter, quarter, quarter]));
    expect(built.record.inline.map((part) => part.cid)).toEqual([
      "img0@example",
      "img1@example",
      "img2@example",
      "img3@example",
    ]);
    expect(built.attachments).toHaveLength(1);
  });

  it("attachment bytes equal the decoded part and carry a digest", async () => {
    const built = await build(fixture("rfc2231.eml"));
    const expected = utf8.encode("%PDF-1.4\n% synthetic\n");
    const attachment = built.attachments[0]!;
    expect(attachment.bytes).toEqual(expected);
    expect(attachment.digest).toBe(contentDigest(expected));
    expect(built.record.attachments[0]).toMatchObject({
      size: expected.length,
      digest: contentDigest(expected),
    });
  });

  it("messages without a Message-ID get a stable fallback key", async () => {
    const message = (subject: string) =>
      utf8.encode(
        `From: sender@example.com\r\nSubject: ${subject}\r\nDate: Mon, 05 Jan 2026 09:00:00 +0000\r\n\r\nSame body.\r\n`,
      );
    const first = await build(message("Old note"));
    const again = await build(message("Old note"));
    const other = await build(message("Other note"));
    expect(first.dedupeKey).toMatch(/^nomid:[A-Za-z0-9_-]+$/);
    expect(again.dedupeKey).toBe(first.dedupeKey);
    expect(other.dedupeKey).not.toBe(first.dedupeKey);
    expect(first.meta.messageId).toBe(first.dedupeKey);
    expect(first.record.messageId).toBe("");
  });

  it("names a message with no subject and keeps file names safe", async () => {
    const none = await build(utf8.encode("From: a@example.com\r\n\r\nhi\r\n"));
    expect(none.name).toBe("(no subject).email");
    const slashed = await build(utf8.encode("From: a@example.com\r\nSubject: Q1/Q2 report\r\n\r\nhi\r\n"));
    expect(slashed.name).toBe("Q1-Q2 report.email");
  });
});
