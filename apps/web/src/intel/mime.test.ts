import { describe, expect, it } from "vitest";
import { parseRaw } from "../workers/mime.worker";
import { parseMessage } from "./mime";

const utf8 = new TextEncoder();

describe("parseMessage", () => {
  it("parseMessage reads a multipart/alternative message", async () => {
    const raw = [
      "From: Example Air <bookings@example.com>",
      "To: traveller@example.com, other@example.com",
      "Subject: =?UTF-8?Q?Your_booking_=E2=9C=88?=",
      "Date: Mon, 05 Jan 2026 09:00:00 +0000",
      "Message-ID: <booking-1@example.com>",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="outer"',
      "",
      "--outer",
      'Content-Type: multipart/alternative; boundary="alt"',
      "",
      "--alt",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Flight TP 236 on 8 April.",
      "--alt",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>Flight <b>TP 236</b> on 8 April.</p>",
      "--alt--",
      "--outer",
      'Content-Type: application/pdf; name="ticket.pdf"',
      'Content-Disposition: attachment; filename="ticket.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      "JVBERi0xLjQK",
      "--outer--",
      "",
    ].join("\r\n");
    const email = await parseRaw(utf8.encode(raw));
    expect(email.subject).toBe("Your booking ✈");
    expect(email.messageId).toBe("<booking-1@example.com>");
    expect(email.from).toMatchObject({ name: "Example Air", address: "bookings@example.com" });
    expect(email.to?.map((to) => ("address" in to ? to.address : ""))).toEqual([
      "traveller@example.com",
      "other@example.com",
    ]);
    expect(email.text?.trim()).toBe("Flight TP 236 on 8 April.");
    expect(email.html).toContain("<b>TP 236</b>");
    expect(email.attachments).toHaveLength(1);
    const ticket = email.attachments[0]!;
    expect(ticket.filename).toBe("ticket.pdf");
    expect(ticket.mimeType).toBe("application/pdf");
    expect(ticket.disposition).toBe("attachment");
    // The decoded part, byte for byte: "%PDF-1.4\n".
    expect(new TextDecoder().decode(ticket.content as ArrayBuffer)).toBe("%PDF-1.4\n");
  });

  it("parses in place where workers do not exist", async () => {
    const email = await parseMessage(utf8.encode("Subject: hi\r\n\r\nbody\r\n"));
    expect(email.subject).toBe("hi");
    expect(email.text?.trim()).toBe("body");
  });
});
