import { describe, expect, it } from "vitest";
import type { TreeFile } from "../uploader";
import { routeDrop, routeTree } from "./route";

const file = (name: string, type = "") => new File(["x"], name, { type });

describe("routeDrop", () => {
  it("routeDrop sends eml and mbox to mail and keeps the rest", () => {
    const eml = file("Booking.eml");
    const mbox = file("All mail Including Spam and Trash.mbox");
    const pdf = file("ticket.pdf", "application/pdf");
    const photo = file("IMG_1.jpg", "image/jpeg");
    const routed = routeDrop([eml, pdf, mbox, photo]);
    expect(routed.mail).toEqual([eml, mbox]);
    expect(routed.files).toEqual([pdf, photo]);
  });

  it("routeDrop recognizes message/rfc822 without an extension", () => {
    const saved = file("Re lease", "message/rfc822");
    const mbox = file("archive", "application/mbox");
    expect(routeDrop([saved, mbox]).mail).toEqual([saved, mbox]);
  });
});

describe("routeTree", () => {
  it("reads an Apple Mail export folder as one mailbox named after it", async () => {
    // Apple Mail exports Inbox.mbox/ holding a file called "mbox" and its
    // own index; the index is not mail and is not uploaded either.
    const items: TreeFile[] = [
      { file: file("mbox"), path: ["Mail export", "Inbox.mbox"] },
      { file: file("table_of_contents"), path: ["Mail export", "Inbox.mbox"] },
      { file: file("notes.txt", "text/plain"), path: ["Mail export"] },
      { file: file("Saved.eml"), path: ["Mail export"] },
    ];
    const routed = routeTree(items);
    expect(routed.mail.map((m) => m.name)).toEqual(["Inbox.mbox", "Saved.eml"]);
    expect(await routed.mail[0]!.text()).toBe("x");
    expect(routed.files.map((i) => i.file.name)).toEqual(["notes.txt"]);
  });
});
