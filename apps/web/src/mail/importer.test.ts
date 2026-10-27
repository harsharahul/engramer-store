import { beforeAll, describe, expect, it } from "vitest";
import { contentDigest, ready, type FileMetadata, type MailMeta } from "@engramer/crypto";
import type { ActivityJob } from "../activity";
import type { UploadSource } from "../transfer";
import { importMail, type ImportTarget } from "./importer";
import { EMAIL_MIME } from "./kind";

const utf8 = new TextEncoder();

interface Stored {
  id: string;
  name: string;
  type: string;
  folderId: string;
  bytes: Uint8Array;
  digest: string;
  mail?: MailMeta;
  mailParent?: string;
  trashed?: boolean;
}

/** The store as the importer sees it: files, folders by path, uploads. */
function fakeTarget(opts: { onStore?: (file: Stored, job: ActivityJob | null) => void } = {}) {
  const files = new Map<string, Stored>();
  let job: ActivityJob | null = null;
  let inFlight = 0;
  const seen = { peakInFlight: 0, setMailCalls: 0, finished: [] as string[][] };
  let next = 0;
  const target: ImportTarget = {
    files: () => files.values(),
    ensureFolderPath: async (path) => `folder:${path.join("/")}`,
    store: async (file, folderId) => {
      inFlight++;
      seen.peakInFlight = Math.max(seen.peakInFlight, inFlight);
      const bytes = new Uint8Array(await file.arrayBuffer());
      await new Promise((resolve) => setTimeout(resolve, 2));
      const meta = (file as UploadSource).meta as Partial<FileMetadata> | undefined;
      const entry: Stored = {
        id: `file-${++next}`,
        name: file.name,
        type: file.type,
        folderId,
        bytes,
        digest: contentDigest(bytes),
        ...(meta?.mail ? { mail: meta.mail } : {}),
        ...(meta?.mailParent ? { mailParent: meta.mailParent } : {}),
      };
      files.set(entry.id, entry);
      inFlight--;
      opts.onStore?.(entry, job);
      return { id: entry.id, digest: entry.digest };
    },
    setMail: async (id, mail) => {
      seen.setMailCalls++;
      files.get(id)!.mail = mail;
    },
    begin: (started) => {
      job = { ...started, startedAt: 0 };
    },
    update: (patch) => {
      job = job ? { ...job, ...patch } : job;
    },
    finish: (title, detail) => {
      job = null;
      seen.finished.push([title, detail ?? ""]);
    },
  };
  const records = () => [...files.values()].filter((f) => f.type === EMAIL_MIME);
  // Two messages are in flight at once, so records land in either order.
  const record = (name: string) => records().find((f) => f.name === name)!;
  const attachments = () => [...files.values()].filter((f) => f.type !== EMAIL_MIME);
  return { target, files, records, record, attachments, seen };
}

interface Part {
  name: string;
  bytes: Uint8Array;
}

function message(subject: string, opts: { id?: string | null; date?: string; parts?: Part[] } = {}) {
  const id = opts.id === undefined ? `<${subject.replace(/\W+/g, "-")}@example.com>` : opts.id;
  const head =
    "From: Example Sender <sender@example.com>\r\nTo: owner@example.com\r\n" +
    `Subject: ${subject}\r\nDate: ${opts.date ?? "Mon, 15 Jun 2026 12:00:00 +0000"}\r\n` +
    (id ? `Message-ID: ${id}\r\n` : "") +
    "MIME-Version: 1.0\r\n";
  if (!opts.parts?.length) {
    return `${head}Content-Type: text/plain; charset=utf-8\r\n\r\nBody of ${subject}.\r\n`;
  }
  const parts = opts.parts
    .map(
      (part) =>
        `--mix\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename="${part.name}"\r\n` +
        `Content-Transfer-Encoding: base64\r\n\r\n${Buffer.from(part.bytes).toString("base64")}\r\n`,
    )
    .join("");
  return (
    `${head}Content-Type: multipart/mixed; boundary="mix"\r\n\r\n` +
    `--mix\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nBody of ${subject}.\r\n${parts}--mix--\r\n`
  );
}

function source(text: string | Uint8Array, name = "export.mbox"): UploadSource {
  const bytes = typeof text === "string" ? utf8.encode(text) : text;
  const blob = new Blob([bytes as BlobPart]);
  return {
    name,
    type: "",
    size: bytes.length,
    lastModified: 0,
    slice: (start, end) => blob.slice(start, end),
    arrayBuffer: () => blob.arrayBuffer(),
    text: () => blob.text(),
  };
}

const mbox = (...messages: string[]) =>
  messages.map((m) => `From sender@example.com Mon Jun 15 12:00:00 2026\n${m}\n`).join("");

const pdf = (label: string) => utf8.encode(`%PDF-1.4\n% ${label}\n`);

/** A message nested past the parser's limit: it cannot be read at all. */
const unreadable = (subject: string) =>
  `Subject: ${subject}\r\n` +
  Array.from({ length: 300 }, (_, i) => `Content-Type: multipart/mixed; boundary="b${i}"\r\n\r\n--b${i}\r\n`).join(
    "",
  );

describe("importMail", () => {
  beforeAll(async () => {
    await ready();
  });

  it("imports an mbox into Mail/Imported with attachments in a year folder", async () => {
    const rig = fakeTarget();
    const report = await importMail(
      [
        source(
          mbox(
            message("Your ticket", { parts: [{ name: "ticket.pdf", bytes: pdf("ticket") }] }),
            message("Last year", { date: "Sun, 15 Jun 2025 12:00:00 +0000" }),
          ),
        ),
      ],
      rig.target,
    );
    expect(report).toEqual({ imported: 2, alreadyPresent: 0, skipped: [], attachments: 1 });
    const ticketMail = rig.record("Your ticket.email");
    const lastYear = rig.record("Last year.email");
    expect(ticketMail).toMatchObject({ name: "Your ticket.email", folderId: "folder:Mail/Imported" });
    expect(ticketMail!.mail).toMatchObject({ messageId: "<Your-ticket@example.com>", subject: "Your ticket" });
    expect(lastYear!.folderId).toBe("folder:Mail/Imported");
    const [ticket] = rig.attachments();
    expect(ticket).toMatchObject({
      name: "ticket.pdf",
      folderId: "folder:Mail/Imported/Attachments/2026",
      mailParent: ticketMail!.id,
    });
    expect(ticket!.bytes).toEqual(pdf("ticket"));
    expect(rig.seen.finished).toEqual([["Imported 2 emails and 1 attachment", ""]]);
  });

  it("a second import of the same source creates nothing and reports every message as already present", async () => {
    const rig = fakeTarget();
    const text = mbox(
      message("One", { parts: [{ name: "a.pdf", bytes: pdf("a") }] }),
      message("Two"),
      message("Three"),
    );
    await importMail([source(text)], rig.target);
    const before = rig.files.size;
    const again = await importMail([source(text)], rig.target);
    expect(again).toEqual({ imported: 0, alreadyPresent: 3, skipped: [], attachments: 0 });
    expect(rig.files.size).toBe(before);
    expect(rig.seen.finished.at(-1)![0]).toBe("No new emails; 3 already present");
  });

  it("messages without a Message-ID dedupe by the fallback key", async () => {
    const rig = fakeTarget();
    const old = message("Old note", { id: null });
    const first = await importMail([source(mbox(old, old))], rig.target);
    expect(first.imported).toBe(1);
    expect(first.alreadyPresent).toBe(1);
    const second = await importMail([source(mbox(old))], rig.target);
    expect(second).toMatchObject({ imported: 0, alreadyPresent: 1 });
    expect(rig.records()).toHaveLength(1);
  });

  it("the same attachment in three replies is stored once", async () => {
    const rig = fakeTarget();
    const lease = { name: "lease.pdf", bytes: pdf("lease") };
    const report = await importMail(
      [source(mbox(message("Lease", { parts: [lease] }), message("Re: Lease", { parts: [lease] }), message("Re: Re: Lease", { parts: [lease] })))],
      rig.target,
    );
    expect(report.imported).toBe(3);
    expect(report.attachments).toBe(1);
    expect(rig.attachments()).toHaveLength(1);
    const id = rig.attachments()[0]!.id;
    expect(rig.records().map((r) => r.mail!.attachmentIds)).toEqual([[id], [id], [id]]);
  });

  it("one malformed message is skipped by name and the rest import", async () => {
    const rig = fakeTarget();
    const report = await importMail(
      [source(mbox(message("Before"), unreadable("Broken one"), message("After")))],
      rig.target,
    );
    expect(report.imported).toBe(2);
    expect(report.skipped).toEqual([{ name: "Broken one", reason: expect.stringMatching(/could not be read/) }]);
    expect(rig.records().map((r) => r.name).sort()).toEqual(["After.email", "Before.email"]);
    expect(rig.seen.finished[0]![1]).toContain("Broken one");
  });

  it("a message over 50 MiB is skipped by name", async () => {
    const rig = fakeTarget();
    const big = `Subject: Huge scan\r\n\r\n${"x".repeat(50 * 1024 * 1024 + 1)}`;
    const report = await importMail([source(big, "Huge scan.eml")], rig.target);
    expect(report.imported).toBe(0);
    expect(report.skipped).toEqual([{ name: "Huge scan", reason: "larger than 50 MB" }]);
    expect(rig.files.size).toBe(0);
  });

  it("Stop ends the run between messages and the report counts what landed", async () => {
    const rig = fakeTarget({
      onStore: (_file, job) => job?.stop?.(),
    });
    const report = await importMail(
      [source(mbox(message("M1"), message("M2"), message("M3"), message("M4"), message("M5")))],
      rig.target,
    );
    expect(report.imported).toBeGreaterThan(0);
    expect(report.imported).toBeLessThan(5);
    expect(rig.records()).toHaveLength(report.imported);
    expect(rig.seen.finished[0]![0]).toMatch(/^Stopped\. Imported/);
  });

  it("the record lists its attachments' file ids after the import", async () => {
    const rig = fakeTarget();
    await importMail(
      [
        source(
          mbox(
            message("Two files", {
              parts: [
                { name: "first.pdf", bytes: pdf("first") },
                { name: "second.pdf", bytes: pdf("second") },
              ],
            }),
            message("No files"),
          ),
        ),
      ],
      rig.target,
    );
    const byName = new Map(rig.attachments().map((a) => [a.name, a.id]));
    const withFiles = rig.record("Two files.email");
    const without = rig.record("No files.email");
    expect(withFiles!.mail!.attachmentIds).toEqual([byName.get("first.pdf"), byName.get("second.pdf")]);
    expect(without!.mail!.attachmentIds).toEqual([]);
    // One write for the email that has attachments, none for the other.
    expect(rig.seen.setMailCalls).toBe(1);
  });

  it("keeps at most two messages in flight", async () => {
    const rig = fakeTarget();
    const many = Array.from({ length: 8 }, (_, i) => message(`Note ${i}`));
    await importMail([source(mbox(...many))], rig.target);
    expect(rig.records()).toHaveLength(8);
    expect(rig.seen.peakInFlight).toBeLessThanOrEqual(2);
    expect(rig.seen.peakInFlight).toBeGreaterThan(1);
  });
});
