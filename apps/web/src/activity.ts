/**
 * What the app is doing in the background, and what it did.
 *
 * One job at a time narrates through the bell in the toolbar, with a Stop;
 * when it ends, one entry says what happened, in numbers that count only
 * what was actually done, and stays until dismissed. The entries are kept
 * per account on this device, so a person who stepped away can read what
 * finished while they were gone.
 */

export type ActivityKind =
  | "processing"
  | "moving"
  | "trashing"
  | "backup"
  | "uploading"
  | "downloading"
  | "connecting"
  | "importing";

export interface ActivityJob {
  kind: ActivityKind;
  title: string;
  done: number;
  total: number;
  failed: number;
  /** The item in hand, when there is one to name. */
  current?: string;
  startedAt: number;
  /** Ends the job after the item in hand; absent when it cannot be stopped. */
  stop?: () => void;
}

export interface ActivityEntry {
  id: string;
  at: number;
  kind: ActivityKind;
  title: string;
  detail?: string;
  unread: boolean;
}

export const ACTIVITY_LOG_LIMIT = 50;

const storageKey = (account: string) => `engram-activity:${account}`;

export function loadActivityLog(account: string): ActivityEntry[] {
  try {
    const raw = localStorage.getItem(storageKey(account));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as ActivityEntry[]) : [];
  } catch {
    return [];
  }
}

export function saveActivityLog(account: string, log: readonly ActivityEntry[]): void {
  try {
    localStorage.setItem(storageKey(account), JSON.stringify(log.slice(0, ACTIVITY_LOG_LIMIT)));
  } catch {
    // Best-effort; the in-memory log still shows.
  }
}

export function clearActivityLog(account: string): void {
  try {
    localStorage.removeItem(storageKey(account));
  } catch {
    // Nothing to clear.
  }
}

/** Newest first, capped. */
export function withEntry(log: readonly ActivityEntry[], entry: ActivityEntry): ActivityEntry[] {
  return [entry, ...log].slice(0, ACTIVITY_LOG_LIMIT);
}

export function unreadCount(log: readonly ActivityEntry[]): number {
  return log.filter((e) => e.unread).length;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A job's count: against its total, or as a running count while the total is unknown. */
export function progressLabel(done: number, total: number): string {
  return total > 0 ? `${done} of ${total}` : `${done} so far`;
}

export interface ProcessingCounts {
  files: number;
  previews: number;
  text: number;
  meaning: number;
  tagged: number;
  facts: number;
  summaries: number;
  /** Summaries the model would not read now (app in the background). */
  summaryPaused: number;
  failed: string[];
  stopped: boolean;
  remaining: number;
}

/** One sentence per outcome, in product words, counting only what landed. */
export function describeProcessing(counts: ProcessingCounts): { title: string; detail?: string } {
  if (counts.files === 0 && !counts.stopped) {
    return { title: "Nothing to fill in" };
  }
  const parts: string[] = [];
  if (counts.previews > 0) {
    parts.push(plural(counts.previews, "preview"));
  }
  if (counts.text > 0) {
    parts.push(`${counts.text} with text`);
  }
  if (counts.meaning > 0) {
    parts.push(`${counts.meaning} by meaning`);
  }
  if (counts.tagged > 0) {
    parts.push(`${counts.tagged} tagged`);
  }
  if (counts.facts > 0) {
    parts.push(`${plural(counts.facts, "date", "dates")} found`);
  }
  if (counts.summaries > 0) {
    parts.push(`${counts.summaries} summarized`);
  }
  const title = counts.stopped
    ? `Stopped after ${counts.files} of ${counts.files + counts.remaining}`
    : `Processed ${plural(counts.files, "file")}`;
  const failed =
    counts.failed.length > 0
      ? `${counts.failed.length} could not be processed: ${counts.failed.slice(0, 3).join(", ")}${
          counts.failed.length > 3 ? "…" : ""
        }`
      : null;
  const paused =
    counts.summaryPaused > 0
      ? `${plural(counts.summaryPaused, "summary", "summaries")} wait for the app to be in front`
      : null;
  const tail = counts.stopped ? "continues next time the app is open" : null;
  const detail = [parts.join(" · "), failed, paused, tail].filter(Boolean).join(" · ");
  return detail ? { title, detail } : { title };
}

/** What a mail import did, in one line, with what it left out named after. */
export function describeImport(
  report: {
    imported: number;
    alreadyPresent: number;
    skipped: { name: string; reason: string }[];
    attachments: number;
  },
  stopped: boolean,
): { title: string; detail?: string } {
  const did =
    report.imported > 0
      ? `Imported ${plural(report.imported, "email")}${
          report.attachments > 0 ? ` and ${plural(report.attachments, "attachment")}` : ""
        }`
      : report.attachments > 0
        ? `Stored ${plural(report.attachments, "missing attachment")}`
        : "No new emails";
  const parts = [did];
  if (report.alreadyPresent > 0) {
    parts.push(`${report.alreadyPresent} already present`);
  }
  if (report.skipped.length > 0) {
    parts.push(`${report.skipped.length} skipped`);
  }
  const title = `${stopped ? "Stopped. " : ""}${parts.join("; ")}`;
  const skipped =
    report.skipped.length > 0
      ? `${report.skipped
          .slice(0, 3)
          .map((s) => `${s.name}: ${s.reason}`)
          .join(" · ")}${report.skipped.length > 3 ? "…" : ""}`
      : null;
  // Importing again skips what is stored, so it picks up where this stopped.
  const tail = stopped ? "import the same file again to continue" : null;
  const detail = [skipped, tail].filter(Boolean).join(" · ");
  return detail ? { title, detail } : { title };
}
