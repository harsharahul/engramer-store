import { settingChanged } from "./settingsbus";

/**
 * What the user decided about the library, as the account's record.
 *
 * A notice dismissed, a trip refused, a notice read, a search made: each
 * of these used to live on the device that saw it (or only in a view's
 * memory), so the same notice came back on the next device and the same
 * question was asked again. They now ride the account's sealed settings
 * blob next to the switches. Every set merges by union, so a decision
 * made anywhere holds everywhere and nothing dismissed returns because
 * another device had not heard yet. The device keeps a mirror per
 * account so the decision applies before the network answers, and the
 * mirror is dropped at sign-out: dismissal keys and search terms are
 * plaintext fragments of the library.
 */

export type DecisionSet = "dismissedInsights" | "dismissedTrips" | "noticesSeen";

export interface RecentSearch {
  q: string;
  at: number;
}

/** A pin is a switch, not a dismissal: it can go both ways, so each key
 * keeps the time of its last word and the newest word wins on merge. */
export interface PinState {
  on: boolean;
  at: number;
}

export interface Decisions {
  dismissedInsights: string[];
  dismissedTrips: string[];
  noticesSeen: string[];
  recentSearches: RecentSearch[];
  /** Pinned collections by tag; absent in blobs from before pins travelled. */
  pins?: Record<string, PinState>;
}

/** Newest entries kept per set; the sets are memory, not an archive. */
const SET_LIMITS: Record<DecisionSet, number> = {
  dismissedInsights: 1_000,
  dismissedTrips: 1_000,
  noticesSeen: 500,
};
const RECENT_SEARCH_LIMIT = 6;

/** Fires after any change, local or applied from the account. */
export const DECISIONS_EVENT = "engram-decisions-changed";
export const decisionEvents = new EventTarget();

const storageKey = (account: string) => `engram-decisions:${account}`;

// Records from before decisions followed the account, adopted once.
const LEGACY_SEEN = (account: string) => `engram-notices-seen:${account}`;
const LEGACY_TRIPS = "engram-trips-dismissed";
const LEGACY_RECENTS = "engram-recent-searches";

function empty(): Decisions {
  return { dismissedInsights: [], dismissedTrips: [], noticesSeen: [], recentSearches: [], pins: {} };
}

function pinsOf(value: unknown): Record<string, PinState> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, PinState> = {};
  for (const [key, state] of Object.entries(value as Record<string, unknown>)) {
    const candidate = state as PinState;
    if (candidate && typeof candidate.on === "boolean" && typeof candidate.at === "number") {
      out[key] = { on: candidate.on, at: candidate.at };
    }
  }
  return out;
}

function mergePins(
  local: Record<string, PinState> | undefined,
  remote: Record<string, PinState> | undefined,
): { merged: Record<string, PinState>; localKnewMore: boolean } {
  const merged: Record<string, PinState> = { ...(remote ?? {}) };
  let localKnewMore = false;
  for (const [key, state] of Object.entries(local ?? {})) {
    const held = merged[key];
    if (!held || state.at > held.at) {
      merged[key] = state;
      localKnewMore = true;
    }
  }
  return { merged, localKnewMore };
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function searches(value: unknown): RecentSearch[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (v): v is RecentSearch =>
      !!v &&
      typeof v === "object" &&
      typeof (v as RecentSearch).q === "string" &&
      typeof (v as RecentSearch).at === "number",
  );
}

/** Reads a stored value, treating anything unreadable as absent. */
function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : undefined;
  } catch {
    return undefined;
  }
}

function normalize(value: unknown): Decisions {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    dismissedInsights: strings(record.dismissedInsights),
    dismissedTrips: strings(record.dismissedTrips),
    noticesSeen: strings(record.noticesSeen),
    recentSearches: searches(record.recentSearches),
    pins: pinsOf(record.pins),
  };
}

function adoptLegacy(account: string): Decisions {
  const adopted = empty();
  adopted.noticesSeen = strings(readJson(LEGACY_SEEN(account)));
  adopted.dismissedTrips = strings(readJson(LEGACY_TRIPS));
  const now = Date.now();
  adopted.recentSearches = strings(readJson(LEGACY_RECENTS)).map((q, index) => ({
    q,
    // The old list was newest first; keep that order under the new rule.
    at: now - index,
  }));
  try {
    localStorage.removeItem(LEGACY_SEEN(account));
    localStorage.removeItem(LEGACY_TRIPS);
    localStorage.removeItem(LEGACY_RECENTS);
  } catch {
    // Best-effort; a second adoption merges the same values again.
  }
  return adopted;
}

export function loadDecisions(account: string): Decisions {
  const stored = readJson(storageKey(account));
  if (stored !== undefined) {
    return normalize(stored);
  }
  const adopted = adoptLegacy(account);
  write(account, adopted);
  return adopted;
}

function write(account: string, decisions: Decisions): void {
  try {
    localStorage.setItem(storageKey(account), JSON.stringify(decisions));
  } catch {
    // Best-effort; the account's copy is the record.
  }
}

function announce(): void {
  decisionEvents.dispatchEvent(new Event(DECISIONS_EVENT));
  settingChanged();
}

function capped(values: Iterable<string>, limit: number): string[] {
  const unique = [...new Set(values)];
  return unique.slice(Math.max(0, unique.length - limit));
}

function mergeSearches(a: RecentSearch[], b: RecentSearch[]): RecentSearch[] {
  const newest = new Map<string, number>();
  for (const entry of [...a, ...b]) {
    const held = newest.get(entry.q);
    if (held === undefined || entry.at > held) {
      newest.set(entry.q, entry.at);
    }
  }
  return [...newest]
    .map(([q, at]) => ({ q, at }))
    .sort((x, y) => y.at - x.at)
    .slice(0, RECENT_SEARCH_LIMIT);
}

/**
 * The union of two records. `localKnewMore` says whether the local side
 * held anything the remote side lacked, which is when the merged record
 * must go back up so the account converges on it.
 */
export function mergeDecisions(
  local: Decisions,
  remote: Decisions,
): { merged: Decisions; localKnewMore: boolean } {
  const merged = empty();
  let localKnewMore = false;
  for (const set of Object.keys(SET_LIMITS) as DecisionSet[]) {
    const remoteSet = new Set(remote[set]);
    if (local[set].some((key) => !remoteSet.has(key))) {
      localKnewMore = true;
    }
    merged[set] = capped([...remote[set], ...local[set]], SET_LIMITS[set]);
  }
  merged.recentSearches = mergeSearches(local.recentSearches, remote.recentSearches);
  const remoteSearches = new Map(remote.recentSearches.map((r) => [r.q, r.at]));
  if (
    merged.recentSearches.some((r) => {
      const held = remoteSearches.get(r.q);
      return held === undefined || r.at > held;
    })
  ) {
    localKnewMore = true;
  }
  const pins = mergePins(local.pins, remote.pins);
  merged.pins = pins.merged;
  if (pins.localKnewMore) {
    localKnewMore = true;
  }
  return { merged, localKnewMore };
}

/** The collections the user pinned, as tags. */
export function pinned(account: string): Set<string> {
  return new Set(
    Object.entries(loadDecisions(account).pins ?? {})
      .filter(([, state]) => state.on)
      .map(([tag]) => tag),
  );
}

export function setPin(account: string, tag: string, on: boolean, at = Date.now()): void {
  const current = loadDecisions(account);
  const held = current.pins?.[tag];
  if (held && held.on === on) {
    return;
  }
  current.pins = { ...(current.pins ?? {}), [tag]: { on, at } };
  write(account, current);
  announce();
}

export function decided(account: string, set: DecisionSet): Set<string> {
  return new Set(loadDecisions(account)[set]);
}

/** Records decisions for the account; a repeat is a no-op. */
export function decide(account: string, set: DecisionSet, keys: readonly string[]): void {
  const current = loadDecisions(account);
  const held = new Set(current[set]);
  if (keys.every((key) => held.has(key))) {
    return;
  }
  current[set] = capped([...current[set], ...keys], SET_LIMITS[set]);
  write(account, current);
  announce();
}

export function recentSearches(account: string): string[] {
  return loadDecisions(account).recentSearches.map((r) => r.q);
}

export function rememberSearch(account: string, query: string, at = Date.now()): string[] {
  const trimmed = query.trim();
  if (!trimmed) {
    return recentSearches(account);
  }
  const current = loadDecisions(account);
  current.recentSearches = mergeSearches(current.recentSearches, [{ q: trimmed, at }]);
  write(account, current);
  announce();
  return current.recentSearches.map((r) => r.q);
}

/**
 * Applies the account's record: the local mirror becomes the union.
 * Returns whether this device knew of decisions the account did not, so
 * the caller pushes the union back. Applying announces the change to
 * views but never as a settings change of its own (the caller decides).
 */
export function applyDecisions(account: string, remote: Decisions | undefined): boolean {
  if (!remote) {
    // A blob from before decisions travelled: whatever this device
    // holds is news to the account.
    return hasAny(loadDecisions(account));
  }
  const { merged, localKnewMore } = mergeDecisions(loadDecisions(account), normalize(remote));
  write(account, merged);
  decisionEvents.dispatchEvent(new Event(DECISIONS_EVENT));
  return localKnewMore;
}

function hasAny(decisions: Decisions): boolean {
  return (
    decisions.dismissedInsights.length > 0 ||
    decisions.dismissedTrips.length > 0 ||
    decisions.noticesSeen.length > 0 ||
    decisions.recentSearches.length > 0 ||
    Object.keys(decisions.pins ?? {}).length > 0
  );
}

/** Drops the device's mirror; the account's copy is untouched. */
export function clearDecisions(account: string): void {
  try {
    localStorage.removeItem(storageKey(account));
  } catch {
    // Nothing to do.
  }
  decisionEvents.dispatchEvent(new Event(DECISIONS_EVENT));
}
