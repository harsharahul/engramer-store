/**
 * What needs attention, as the notice center and system notifications
 * see it. One computation feeds both: the keys the bell counts as unseen,
 * and the few dated items close enough to interrupt for when the app is
 * not in front. Pure functions over the library, plus two memories: what
 * the bell has shown, which is the account's record (decisions.ts) so a
 * notice read anywhere is read everywhere; and what this device has
 * already notified, kept on the device because a notification is for
 * wherever the user might be looking, so nothing is ever said twice here.
 */

import { decide, decided, DECISIONS_EVENT, decisionEvents } from "./decisions";
import { daysUntil } from "./intel/dates";
import { describeFact } from "./intel/describe";
import { duplicatesByDigest } from "./intel/duplicates";
import { DATED_KINDS, type Fact } from "./intel/facts";
import { insightsFor, type Severity } from "./intel/insights";

export interface NoticeFile {
  id: string;
  name: string;
  digest?: string;
  tags: readonly string[];
  facts: Fact[];
  trashed: boolean;
  createdAt: number;
}

/** Near enough to be worth saying without being asked. */
export const HORIZON_DAYS = 120;
export const RECENTLY_PAST_DAYS = 30;
/** Near enough to interrupt for. */
export const DUE_DAYS = 30;

const MEMORY_LIMIT = 500;

export interface Upcoming<F extends NoticeFile = NoticeFile> {
  file: F;
  fact: Fact;
  days: number;
}

export interface Notice {
  key: string;
  title: string;
  body: string;
  fileId: string | null;
  severity: Severity;
}

function isDated(fact: Fact): boolean {
  return DATED_KINDS.has(fact.kind);
}

/** Confirmed dated facts within the horizon, soonest first. */
export function upcomingFacts<F extends NoticeFile>(files: readonly F[], now: number): Upcoming<F>[] {
  return files
    .filter((file) => !file.trashed)
    .flatMap((file) =>
      file.facts
        .filter((fact) => fact.confirmed && !fact.dismissed && isDated(fact))
        .map((fact) => ({ file, fact, days: daysUntil(fact.value, now) })),
    )
    .filter((entry) => entry.days > -RECENTLY_PAST_DAYS && entry.days < HORIZON_DAYS)
    .sort((a, b) => a.days - b.days);
}

export function tripTags(files: readonly NoticeFile[]): string[] {
  const tags = new Set<string>();
  for (const file of files) {
    if (file.trashed) {
      continue;
    }
    for (const tag of file.tags) {
      if (tag.startsWith("trip:")) {
        tags.add(tag);
      }
    }
  }
  return [...tags].sort();
}

/** One stable key per item the notice center shows. */
export function noticeKeys(files: readonly NoticeFile[], now: number): string[] {
  const live = files.filter((file) => !file.trashed);
  const keys: string[] = [];
  for (const tag of tripTags(live)) {
    keys.push(`trip:${tag}`);
  }
  for (const { file, fact } of upcomingFacts(live, now)) {
    keys.push(`fact:${file.id}:${fact.id}`);
  }
  for (const insight of insightsFor(live, now)) {
    keys.push(`insight:${insight.id}`);
  }
  for (const group of duplicatesByDigest(live)) {
    keys.push(`dup:${group.digest}`);
  }
  return keys;
}

/** The items worth a system notification: dated, and close. */
export function dueNotices(files: readonly NoticeFile[], now: number): Notice[] {
  const live = files.filter((file) => !file.trashed);
  const notices: Notice[] = upcomingFacts(live, now)
    .filter((entry) => entry.days <= DUE_DAYS)
    .map(({ file, fact, days }) => ({
      key: `fact:${file.id}:${fact.id}`,
      title: describeFact(fact),
      body: file.name,
      fileId: file.id,
      severity: days < 0 ? "overdue" : "soon",
    }));
  for (const insight of insightsFor(live, now)) {
    if (insight.severity === "info") {
      continue;
    }
    notices.push({
      key: `insight:${insight.id}`,
      title: insight.title,
      body: live.find((file) => file.id === insight.fileId)?.name ?? "",
      fileId: insight.fileId ?? null,
      severity: insight.severity,
    });
  }
  return notices;
}

// ----- per-account memories -----

function readSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : []);
  } catch {
    return new Set();
  }
}

function writeSet(key: string, values: Set<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...values].slice(-MEMORY_LIMIT)));
  } catch {
    // Best-effort; the worst case is a notice shown as new once more.
  }
}

const notifiedKey = (account: string) => `engram-notified:${account}`;

/** Which notices the user has read: the account's record, so a notice
 * opened on one device is not new again on the next. */
export function loadSeen(account: string): Set<string> {
  return decided(account, "noticesSeen");
}

/** Fires after the seen record changes, here or on another device, so
 * the bell's badge re-reads. */
export const NOTICES_SEEN_EVENT = "engram-notices-seen";
export const noticeEvents = new EventTarget();
decisionEvents.addEventListener(DECISIONS_EVENT, () => {
  noticeEvents.dispatchEvent(new Event(NOTICES_SEEN_EVENT));
});

export function markSeen(account: string, keys: readonly string[]): void {
  decide(account, "noticesSeen", keys);
}

export function unseenCount(keys: readonly string[], seen: ReadonlySet<string>): number {
  return keys.filter((key) => !seen.has(key)).length;
}

export function loadNotified(account: string): Set<string> {
  return readSet(notifiedKey(account));
}

export function markNotified(account: string, keys: readonly string[]): void {
  const notified = loadNotified(account);
  for (const key of keys) {
    notified.add(key);
  }
  writeSet(notifiedKey(account), notified);
}

export function newDue(due: readonly Notice[], notified: ReadonlySet<string>): Notice[] {
  return due.filter((notice) => !notified.has(notice.key));
}
