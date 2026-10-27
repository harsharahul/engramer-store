/**
 * When a file is read by a model, and when it is never read again.
 *
 * Every reading leaves one synced stamp: which reader, at what rank and
 * version, of which contents, for which tasks, and the outcome. A file is
 * read again only for four reasons: its contents changed; a stronger reader
 * for a wanted task is here; the owner asks; or the reader's version changed,
 * and then only files whose reading came back empty or declined, or that are
 * from the last 90 days. A different answer, another device's read, a
 * restart, a sync, or our own write is never a reason.
 */

import type { ReadingStamp } from "@engramer/crypto";

export type { ReadingStamp };

/** The on-device model on the Mac and iPhone (Apple Foundation Models). */
export const MODEL_READER = "apple";

/** Strength per reader, 1 strongest. Ranks 1, 3 and 4 are reserved for a
 * larger Mac model, Chrome's built-in model and a web model pack. */
export const READER_RANK: Readonly<Record<string, number>> = { [MODEL_READER]: 2 };

/** Raised when a reader's prompt or model changes, never for a storage change. */
export const READER_VERSION: Readonly<Record<string, number>> = { [MODEL_READER]: 1 };

const RECENT_DAYS = 90;
const DAY = 86_400_000;
const EMPTY_OUTCOMES = new Set<ReadingStamp["outcome"]>(["none", "declined", "unsupported", "language"]);
const FINAL_OUTCOMES = new Set<ReadingStamp["outcome"]>(["failed", "user"]);

export interface ReadingCandidate {
  trashed: boolean;
  mime: string;
  hasText: boolean;
  inlineText: boolean;
  digest?: string;
  createdAt: number;
  reading?: ReadingStamp;
  /** The pair builds before the stamp wrote. */
  assistVersion?: number;
  noSummary?: string;
  mail?: { date: number };
}

const LEGACY_OUTCOMES: Record<string, ReadingStamp["outcome"]> = {
  short: "short",
  unsupported: "unsupported",
  declined: "declined",
  language: "language",
  user: "user",
  failed: "failed",
};

/** The reading a file carries, reading an older build's pair as the model's first version. */
export function stampOf(file: ReadingCandidate): ReadingStamp | undefined {
  if (file.reading) {
    return file.reading;
  }
  if ((file.assistVersion ?? 0) < 1) {
    return undefined;
  }
  // Older builds read summary and dates in one pass and kept no record of
  // which; counting both done is what keeps an upgrade from re-reading the
  // whole library.
  return {
    reader: MODEL_READER,
    rank: READER_RANK[MODEL_READER]!,
    version: file.assistVersion!,
    tasks: ["summary", "facts"],
    outcome: (file.noSummary && LEGACY_OUTCOMES[file.noSummary]) || "found",
    tries: 1,
    at: 0,
  };
}

/** A document a model can read at all: text, not media, not in the trash. */
export function readable(file: ReadingCandidate): boolean {
  return !file.trashed && !/^(image|video|audio)\//.test(file.mime) && (file.hasText || file.inlineText);
}

export function needsReading(
  file: ReadingCandidate,
  reader: string,
  opts: { factsWanted: boolean; now: number },
): boolean {
  if (!readable(file)) {
    return false;
  }
  const stamp = stampOf(file);
  if (!stamp) {
    return true;
  }
  if (FINAL_OUTCOMES.has(stamp.outcome)) {
    return false;
  }
  if (file.digest && stamp.digest && file.digest !== stamp.digest) {
    // New contents are a new item, whoever read the old ones.
    return true;
  }
  const rank = READER_RANK[reader] ?? Number.POSITIVE_INFINITY;
  if (rank > stamp.rank) {
    // A weaker reader never reads after a stronger one, even one that found nothing.
    return false;
  }
  if (rank < stamp.rank) {
    return true;
  }
  if (opts.factsWanted && !stamp.tasks.includes("facts")) {
    return true;
  }
  if (stamp.reader === reader && (READER_VERSION[reader] ?? 0) > stamp.version) {
    const when = file.mail?.date || file.createdAt;
    return EMPTY_OUTCOMES.has(stamp.outcome) || opts.now - when <= RECENT_DAYS * DAY;
  }
  return false;
}

/** The pair builds before the stamp read, so they see a stamped file as read. */
export function legacyOf(stamp: ReadingStamp): { assistVersion: number; noSummary?: string } {
  const noSummary = stamp.outcome === "found" ? undefined : stamp.outcome === "none" ? "unsupported" : stamp.outcome;
  return noSummary ? { assistVersion: 1, noSummary } : { assistVersion: 1 };
}

/** Writes a stamp and the legacy pair together into metadata about to be stored. */
export function stampInto(
  meta: { reading?: ReadingStamp; assistVersion?: number; noSummary?: string },
  stamp: ReadingStamp,
): void {
  const legacy = legacyOf(stamp);
  meta.reading = stamp;
  meta.assistVersion = legacy.assistVersion;
  meta.noSummary = legacy.noSummary;
}

/** A stamp for the model's reading of this file now. */
export function modelStamp(args: {
  digest?: string;
  factsWanted: boolean;
  outcome: ReadingStamp["outcome"];
  tries?: number;
  reason?: string;
  now: number;
}): ReadingStamp {
  return {
    reader: MODEL_READER,
    rank: READER_RANK[MODEL_READER]!,
    version: READER_VERSION[MODEL_READER]!,
    ...(args.digest ? { digest: args.digest } : {}),
    tasks: args.factsWanted ? ["summary", "facts"] : ["summary"],
    outcome: args.outcome,
    tries: args.tries ?? 1,
    ...(args.reason ? { reason: args.reason } : {}),
    at: args.now,
  };
}
