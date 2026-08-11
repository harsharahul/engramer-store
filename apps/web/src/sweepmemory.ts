/**
 * What this device already tried, remembered across app opens.
 *
 * A session on a phone is one app open. While the record of a failed
 * attempt lived only in memory, a file this device could not process —
 * an undecodable video, a photo whose read stalls, anything attempted on
 * a bad connection — was downloaded and attempted again on every single
 * open, forever. That is the rescanning loop, and the cure is a record
 * that outlives the session.
 *
 * The record is deliberately per device: another device with a better
 * connection or more memory still gets its turn, and a hand-run pass
 * clears the slate, because asking for it explicitly means "try again".
 */

export type SweepKind = "thumbs" | "text" | "meaning" | "facts";

/**
 * How many automatic attempts a file gets on this device before it is
 * left alone. Three for work that can succeed on a later try (a stalled
 * download, a moment of memory pressure). One for the dates pass, which
 * is re-eligible by design: without a budget it would re-read the whole
 * library on every open.
 */
export function attemptCap(kind: SweepKind): number {
  return kind === "facts" ? 1 : 3;
}

function storageKey(account: string, kind: SweepKind): string {
  return `engram-sweep-${kind}:${account}`;
}

export class SweepMemory {
  private counts: Record<string, number>;

  constructor(
    private readonly account: string,
    private readonly kind: SweepKind,
  ) {
    this.counts = this.read();
  }

  private read(): Record<string, number> {
    try {
      const raw = localStorage.getItem(storageKey(this.account, this.kind));
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      // Anything unexpected reads as "nothing attempted yet": a corrupt
      // record must cost a redundant pass, never a wedged sweep.
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, number>)
        : {};
    } catch {
      return {};
    }
  }

  private write(): void {
    try {
      localStorage.setItem(storageKey(this.account, this.kind), JSON.stringify(this.counts));
    } catch {
      // Persistence is best-effort; the session's own copy still holds.
    }
  }

  attempts(id: string): number {
    return this.counts[id] ?? 0;
  }

  /** Whether this device has spent its automatic budget on this file. */
  exhausted(id: string): boolean {
    return this.attempts(id) >= attemptCap(this.kind);
  }

  /** Notes one attempt; success clears the file's history. */
  record(id: string, ok: boolean): void {
    if (ok && this.kind !== "facts") {
      delete this.counts[id];
    } else {
      this.counts[id] = this.attempts(id) + 1;
    }
    this.write();
  }

  /** Clears the record, so every file is fair game again. */
  forgetAll(): void {
    this.counts = {};
    try {
      localStorage.removeItem(storageKey(this.account, this.kind));
    } catch {
      // Best-effort, as above.
    }
  }
}
