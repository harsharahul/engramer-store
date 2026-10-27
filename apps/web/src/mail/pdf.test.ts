import { unzlibSync } from "fflate";
import { PDFArray, PDFDocument, PDFName, PDFRawStream, type PDFPage } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { emailToPdf } from "./pdf";
import type { EmailRecord } from "./record";

const record = (over: Partial<EmailRecord>): EmailRecord => ({
  v: 1,
  messageId: "<p1@example.com>",
  date: Date.UTC(2026, 5, 15, 12),
  from: { name: "Example Air", address: "bookings@example.com" },
  to: ["traveller@example.com"],
  cc: [],
  subject: "Your booking to Lisbon",
  headers: "Subject: Your booking to Lisbon\r\nDate: Mon, 15 Jun 2026 12:00:00 +0000",
  inline: [],
  attachments: [],
  source: { kind: "import", label: "export.mbox" },
  ...over,
});

/** The text a page draws: its content streams inflated, hex strings decoded. */
function pageText(page: PDFPage): string {
  const contents = page.node.Contents();
  const streams =
    contents instanceof PDFArray
      ? contents.asArray().map((ref) => page.doc.context.lookup(ref))
      : [contents];
  let text = "";
  for (const stream of streams) {
    if (!(stream instanceof PDFRawStream)) {
      continue;
    }
    const raw = stream.dict.get(PDFName.of("Filter")) ? unzlibSync(stream.contents) : stream.contents;
    const ops = new TextDecoder("latin1").decode(raw);
    for (const match of ops.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)) {
      const hex = match[1]!;
      for (let i = 0; i < hex.length; i += 2) {
        text += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
      }
      text += "\n";
    }
  }
  return text;
}

async function textOf(bytes: Uint8Array): Promise<{ pages: number; text: string }> {
  const doc = await PDFDocument.load(bytes);
  return { pages: doc.getPageCount(), text: doc.getPages().map(pageText).join("\n") };
}

describe("emailToPdf", () => {
  it("a pdf carries the subject, sender and body text", async () => {
    const { bytes, replacedCharacters } = await emailToPdf(
      record({ text: "Flight TP 236 leaves at 18:10 on 8 April." }),
    );
    const { pages, text } = await textOf(bytes);
    expect(pages).toBe(1);
    expect(text).toContain("Your booking to Lisbon");
    expect(text).toContain("Example Air <bookings@example.com>");
    expect(text).toContain("traveller@example.com");
    expect(text).toContain("Mon, 15 Jun 2026 12:00:00 +0000");
    expect(text).toContain("Flight TP 236 leaves at 18:10 on 8 April.");
    expect(replacedCharacters).toBe(false);
  });

  it("reads the HTML as text when there is no plain body", async () => {
    const { bytes } = await emailToPdf(record({ html: "<p>Check-in&nbsp;from 15:00</p><script>x()</script>" }));
    const { text } = await textOf(bytes);
    expect(text).toContain("Check-in from 15:00");
    expect(text).not.toContain("x()");
  });

  it("a long body continues across pages", async () => {
    const body = Array.from({ length: 300 }, (_, i) => `Line ${i + 1} of the itinerary.`).join("\n");
    const { bytes } = await emailToPdf(record({ text: body }));
    const { pages, text } = await textOf(bytes);
    expect(pages).toBeGreaterThan(3);
    expect(text).toContain("Line 1 of the itinerary.");
    expect(text).toContain("Line 300 of the itinerary.");
  });

  it("wraps a long line to the page instead of running off it", async () => {
    const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    const { bytes } = await emailToPdf(record({ text: long }));
    const { text } = await textOf(bytes);
    const lines = text.split("\n").filter((line) => line.includes("word"));
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(" ").replace(/\s+/g, " ")).toContain("word0 word1");
    expect(lines.join(" ")).toContain("word59");
  });

  it("characters the font cannot draw are replaced and reported", async () => {
    const { bytes, replacedCharacters } = await emailToPdf(
      record({ subject: "Trip ✈ booked", text: "你好 and café" }),
    );
    const { text } = await textOf(bytes);
    expect(replacedCharacters).toBe(true);
    expect(text).toContain("Trip ? booked");
    expect(text).toContain("?? and café");
    expect(text).toContain("Some characters could not be shown in this PDF and appear as ?.");
  });

  it("the attachments are listed by name", async () => {
    const { bytes } = await emailToPdf(
      record({
        text: "See attached.",
        attachments: [
          { name: "ticket.pdf", mime: "application/pdf", size: 48_213, digest: "d1" },
          { name: "receipt.png", mime: "image/png", size: 1_024, digest: "d2" },
        ],
      }),
    );
    const { text } = await textOf(bytes);
    expect(text).toContain("Attachments");
    expect(text).toContain("ticket.pdf");
    expect(text).toContain("receipt.png");
  });
});
