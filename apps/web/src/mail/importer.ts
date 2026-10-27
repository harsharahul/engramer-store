/**
 * Imports mail from .eml and .mbox files into the vault.
 *
 * One finite pass over the messages in the files it is given: each message
 * becomes an email record in Mail/Imported, and each attachment a file in
 * Mail/Imported/Attachments/<year> that names its email. A message already
 * in the vault (same Message-ID, or the same fallback key) is counted and
 * left alone, so importing a file twice, or again after Stop, stores
 * nothing twice. An attachment already in the vault (same digest) is
 * linked, not stored again.
 */

import type { MailMeta } from "@engramer/crypto";
import { DATED_KINDS, isTracked, type Fact } from "../intel/facts";
import { describeImport, type ActivityJob } from "../activity";
import { parseMessage, type ParsedMessage } from "../intel/mime";
import type { UploadSource } from "../transfer";
import { EMAIL_MIME } from "./kind";
import { splitMbox } from "./mbox";
import { buildEmail } from "./record";

/** Messages larger than this are skipped and named in the report. */
export const MESSAGE_MAX = 50 * 1024 * 1024;
/** Messages being stored at once. */
export const MAIL_IN_FLIGHT = 2;

const RECORDS_FOLDER = ["Mail", "Imported"];
const ATTACHMENTS_FOLDER = [...RECORDS_FOLDER, "Attachments"];

export interface ImportReport {
  imported: number;
  alreadyPresent: number;
  skipped: { name: string; reason: string }[];
  attachments: number;
  /** Dates that count, found in what this import stored: one line, never a notice per date. */
  dates: number;
}

/** What the importer needs from the store. */
export interface ImportTarget {
  /** Every file the library holds, trashed and shared-in ones included. */
  files(): Iterable<{
    id: string;
    digest?: string;
    mail?: MailMeta;
    trashed?: boolean;
    shared?: boolean;
    facts?: Fact[];
  }>;
  ensureFolderPath(path: string[]): Promise<string>;
  /** Uploads one source into a folder through the normal upload path. */
  store(file: UploadSource, folderId: string): Promise<{ id: string; digest?: string }>;
  /** Rewrites an email record's mail fields. */
  setMail(id: string, mail: MailMeta): Promise<void>;
  begin(job: Omit<ActivityJob, "startedAt">): void;
  update(patch: Partial<ActivityJob>): void;
  finish(title: string, detail?: string): void;
  /** The message parser; the worker-backed one unless a caller says otherwise. */
  parse?(raw: Uint8Array): Promise<ParsedMessage>;
}

/** A file to upload, carrying the metadata the importer already knows. */
function sourceWith(
  parts: BlobPart[],
  name: string,
  type: string,
  lastModified: number,
  meta: UploadSource["meta"],
): UploadSource {
  return Object.assign(new File(parts, name, { type, lastModified }), { meta });
}

/** The Subject header read straight from the bytes, to name a message that cannot be parsed. */
function subjectOf(raw: Uint8Array): string {
  const head = new TextDecoder("latin1").decode(raw.subarray(0, 64 * 1024)).split(/\r?\n\r?\n/)[0] ?? "";
  const match = /^subject:[ \t]*(.*(?:\r?\n[ \t].*)*)/im.exec(head);
  return (match?.[1] ?? "").replace(/\r?\n[ \t]+/g, " ").trim().slice(0, 120);
}

/** Whether a parse found anything that makes it an email. */
function readable(parsed: ParsedMessage): boolean {
  return Boolean(
    parsed.from ||
      parsed.subject ||
      parsed.messageId ||
      parsed.date ||
      parsed.text ||
      parsed.html ||
      parsed.attachments.length > 0,
  );
}

function shortReason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

export async function importMail(sources: UploadSource[], target: ImportTarget): Promise<ImportReport> {
  const parse = target.parse ?? parseMessage;
  const report: ImportReport = { imported: 0, alreadyPresent: 0, skipped: [], attachments: 0, dates: 0 };
  // What this run stored, to count the dates found in it at the end.
  const stored = new Set<string>();

  // What this account already holds. Files other accounts share in do not
  // count: a share can be revoked, so imported mail keeps its own copies.
  // Emails count even in the Trash: a deleted email is not brought back by
  // importing the same file again.
  const keys = new Set<string>();
  const present = new Map<string, { id: string; mail: MailMeta }>();
  const byDigest = new Map<string, Promise<string>>();
  for (const file of target.files()) {
    if (file.shared) {
      continue;
    }
    if (file.mail?.messageId) {
      keys.add(file.mail.messageId);
      present.set(file.mail.messageId, { id: file.id, mail: file.mail });
    }
    if (file.digest && !file.trashed) {
      byDigest.set(file.digest, Promise.resolve(file.id));
    }
  }

  // Folders are created on first need, so an import that finds nothing new
  // leaves no empty folders behind.
  const folders = new Map<string, Promise<string>>();
  const folder = (path: string[]) => {
    const key = path.join("\u0000");
    let pending = folders.get(key);
    if (!pending) {
      pending = target.ensureFolderPath(path);
      pending.catch(() => folders.delete(key));
      folders.set(key, pending);
    }
    return pending;
  };

  const controller = new AbortController();
  const allEml = sources.every((s) => /\.eml$/i.test(s.name) || s.type === "message/rfc822");
  target.begin({
    kind: "importing",
    title: "Importing mail",
    done: 0,
    // An mbox does not say how many messages it holds until it is read.
    total: allEml ? sources.length : 0,
    failed: 0,
    stop: () => controller.abort(),
  });
  const progress = (current?: string) =>
    target.update({
      done: report.imported + report.alreadyPresent + report.skipped.length,
      failed: report.skipped.length,
      ...(current ? { current } : {}),
    });

  /** Stores an email's attachments, or links the ones already here; answers their ids in order. */
  const storeAttachments = async (
    recordId: string,
    built: ReturnType<typeof buildEmail>,
    label: string,
  ): Promise<string[]> => {
    const date = built.meta.date;
    const year = date ? String(new Date(date).getFullYear()) : "Undated";
    const ids: string[] = [];
    for (const attachment of built.attachments) {
      let pending = byDigest.get(attachment.digest);
      if (!pending) {
        pending = (async () => {
          const file = sourceWith([attachment.bytes as BlobPart], attachment.name, attachment.mime, date || Date.now(), {
            mailParent: recordId,
          });
          // The bytes going up are the decoded part, all of them.
          if (file.size !== attachment.bytes.length) {
            throw new Error("the attachment's size changed on the way to upload");
          }
          const saved = await target.store(file, await folder([...ATTACHMENTS_FOLDER, year]));
          if (saved.digest && saved.digest !== attachment.digest) {
            throw new Error("the stored bytes differ from the attachment");
          }
          stored.add(saved.id);
          report.attachments++;
          return saved.id;
        })();
        const claimed = pending;
        claimed.catch(() => {
          if (byDigest.get(attachment.digest) === claimed) {
            byDigest.delete(attachment.digest);
          }
        });
        byDigest.set(attachment.digest, claimed);
      }
      try {
        ids.push(await pending);
      } catch (error) {
        report.skipped.push({
          name: `${attachment.name} (with ${label})`,
          reason: `could not be stored: ${shortReason(error)}`,
        });
      }
    }
    return ids;
  };

  const handle = async (raw: Uint8Array, sourceName: string, fallbackName: string) => {
    const label = subjectOf(raw) || fallbackName;
    let parsed: ParsedMessage;
    try {
      parsed = await parse(raw);
    } catch (error) {
      report.skipped.push({ name: label, reason: `could not be read: ${shortReason(error)}` });
      return;
    }
    if (!readable(parsed)) {
      report.skipped.push({ name: label, reason: "not an email" });
      return;
    }
    const built = buildEmail(parsed, raw, { label: sourceName });
    if (keys.has(built.dedupeKey)) {
      report.alreadyPresent++;
      // An earlier import that stored the email but not all of its files
      // (a dropped connection, a closed tab) is finished now. A complete
      // email is left alone: its list never shrinks, so an attachment the
      // owner deleted since is not stored again.
      const existing = present.get(built.dedupeKey);
      if (existing && existing.mail.attachmentIds.length < built.attachments.length) {
        // Once per run, even when the export holds the message twice.
        present.delete(built.dedupeKey);
        const ids = await storeAttachments(existing.id, built, label);
        const before = existing.mail.attachmentIds;
        if (ids.length !== before.length || ids.some((id, i) => id !== before[i])) {
          await target.setMail(existing.id, { ...existing.mail, attachmentIds: ids });
        }
      }
      progress();
      return;
    }
    // Claimed before any await, so the same message twice in flight is
    // stored once.
    keys.add(built.dedupeKey);
    const date = built.meta.date;
    let recordId: string;
    try {
      const record = sourceWith(
        [JSON.stringify(built.record)],
        built.name,
        EMAIL_MIME,
        date || Date.now(),
        { mail: built.meta },
      );
      recordId = (await target.store(record, await folder(RECORDS_FOLDER))).id;
      stored.add(recordId);
    } catch (error) {
      keys.delete(built.dedupeKey);
      report.skipped.push({ name: label, reason: `could not be stored: ${shortReason(error)}` });
      return;
    }
    report.imported++;

    const ids = await storeAttachments(recordId, built, label);
    if (ids.length > 0) {
      await target.setMail(recordId, { ...built.meta, attachmentIds: ids });
    }
    progress(built.record.subject || built.name);
  };

  const inFlight = new Set<Promise<void>>();
  for (const source of sources) {
    if (controller.signal.aborted) {
      break;
    }
    try {
      await splitMbox(
        source,
        async (raw, index) => {
          while (inFlight.size >= MAIL_IN_FLIGHT) {
            await Promise.race(inFlight);
          }
          // Stop may have come while waiting for a slot.
          if (controller.signal.aborted) {
            return;
          }
          const name = `Message ${index + 1} in ${source.name}`;
          const job: Promise<void> = handle(raw, source.name, name)
            .catch((error: unknown) => {
              report.skipped.push({ name, reason: shortReason(error) });
            })
            .finally(() => {
              inFlight.delete(job);
              progress();
            });
          inFlight.add(job);
        },
        controller.signal,
        {
          // Never held whole: the splitter hands over its head to name it.
          maxMessageBytes: MESSAGE_MAX,
          onOversized: async (head, index) => {
            report.skipped.push({
              name: subjectOf(head) || `Message ${index + 1} in ${source.name}`,
              reason: "larger than 50 MB",
            });
            progress();
          },
        },
      );
    } catch (error) {
      report.skipped.push({ name: source.name, reason: shortReason(error) });
    }
  }
  await Promise.all(inFlight);

  for (const file of target.files()) {
    if (stored.has(file.id)) {
      report.dates += (file.facts ?? []).filter((fact) => isTracked(fact) && DATED_KINDS.has(fact.kind)).length;
    }
  }

  const said = describeImport(report, controller.signal.aborted);
  target.finish(said.title, said.detail);
  return report;
}
