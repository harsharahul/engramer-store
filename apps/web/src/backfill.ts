import { isHandheld } from "./analysisslot";
import { loadPolicy } from "./backuppolicy";
import { settingChanged } from "./settingsbus";
import { connectionIsUnmetered } from "./connection";
import { ocrEnabled } from "./intel/ocr";
import { factsEnabled } from "./intel/scan";
import { semanticEnabled } from "./intel/semantic";
import { useStore } from "./store";
import { SweepMemory, type SweepKind } from "./sweepmemory";

/**
 * Finishes whatever some other path could not: thumbnails for images that
 * arrived through the iOS Files app (a provider process cannot decode
 * media, and the server never sees pixels), and the scanners the photo
 * backup deliberately defers to keep its uploads fast.
 *
 * Every signed-in device derives the same to-do list from the synced
 * library, so coordination is optimistic: a desktop starts almost
 * immediately after sync, a phone waits with jitter, and whoever finishes
 * first publishes the result; the others re-check per file and find
 * nothing left. Duplicate work in the rare race is idempotent, the same
 * bytes either way. There are no locks to break.
 */

/** Auto runs on a phone leave big originals for a desktop or a hand-run. */
export const HANDHELD_AUTO_MAX_BYTES = 32 * 1024 * 1024;

const AUTO_PREF_KEY = "engram-backfill-auto";

/**
 * Whether this device volunteers for automatic backfill. On by default:
 * the feature exists so gaps close without anyone thinking about them.
 * The off switch exists because backfill downloads originals to make
 * derivatives, and on a metered connection that is the user's call, not
 * the app's. Hand-run buttons and palette commands ignore this.
 */
export function autoBackfillEnabled(): boolean {
  try {
    return localStorage.getItem(AUTO_PREF_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setAutoBackfillEnabled(on: boolean): void {
  try {
    localStorage.setItem(AUTO_PREF_KEY, on ? "1" : "0");
    settingChanged();
  } catch {
    // Preference persistence is best-effort.
  }
}

let stopAsked = false;

/** Stops the running pass after the file in hand; the next pass starts fresh. */
export function stopBackfill(): void {
  stopAsked = true;
}

/**
 * How many failures in a row end a pass. A file that cannot be processed
 * is one thing; four in a row is the connection or the device, and
 * grinding through the rest of the library proves nothing while costing
 * data and battery on exactly the connection that is already struggling.
 */
const BREAKER_FAILURES = 4;

const DESKTOP_DELAY_MS = 3_000;
const HANDHELD_DELAY_MS = 90_000;
const HANDHELD_JITTER_MS = 30_000;

/**
 * How long after a sync a device waits before sweeping. Desktops go almost
 * at once; phones hold back long enough that an online desktop usually
 * drains the queue first, jittered so two phones do not move in lockstep.
 */
export function backfillDelayMs(
  handheld: boolean,
  random: () => number = Math.random,
): number {
  return handheld
    ? HANDHELD_DELAY_MS + Math.floor(random() * HANDHELD_JITTER_MS)
    : DESKTOP_DELAY_MS;
}

// Session-long memory of what each pass already attempted, kept per pass:
// a file the thumbnailer failed on may still OCR fine.
let attemptedThumbs = new Set<string>();
let attemptedOcr = new Set<string>();
let attemptedClip = new Set<string>();
let attemptedFacts = new Set<string>();

/** Forgets this session's attempts; the persisted record still stands. */
export function resetBackfillSession(): void {
  attemptedThumbs = new Set();
  attemptedOcr = new Set();
  attemptedClip = new Set();
  attemptedFacts = new Set();
}

let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;

export interface BackfillResult {
  thumbs: number;
  text: number;
  meaning: number;
  facts: number;
}

/**
 * One automatic pass over everything missing. Thumbnails first: they are
 * the visible gap, and a video needs its poster frame stored before it can
 * be indexed by meaning. Each scanner runs only when its preference is on,
 * exactly the gate its inline counterpart honors at upload.
 */
export async function runBackfill(): Promise<BackfillResult | null> {
  if (running || !autoBackfillEnabled()) {
    return null;
  }
  const store = useStore.getState();
  const uploading = store.uploads.some(
    (u) => u.status !== "done" && u.status !== "error",
  );
  if (!store.session || !store.synced || uploading) {
    return null;
  }
  // Offline is not the moment to start downloading originals; the next
  // sync or foreground brings the device back and schedules another pass.
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return null;
  }
  // The backup policy's Wi-Fi promise covers this downloader too:
  // originals are exactly the bytes a metered connection should not pay
  // for. Only while backup is enabled, though: that is where the knob
  // is visible, and a promise nobody can see or change is not one.
  // Manual sweeps from the Library index card bypass this on purpose;
  // asking is consent.
  const backupPolicy = loadPolicy();
  if (backupPolicy.enabled && backupPolicy.wifiOnly && !(await connectionIsUnmetered())) {
    return null;
  }
  running = true;
  stopAsked = false;
  let consecutiveFailures = 0;
  const stop = () => stopAsked || consecutiveFailures >= BREAKER_FAILURES;
  const account = store.session.email;

  /**
   * One pass's bookkeeping: this device's persisted record decides who
   * is skipped, every outcome is written back, and a run of failures
   * trips the breaker for the whole run.
   */
  const pass = (kind: SweepKind, session: Set<string>) => {
    const memory = new SweepMemory(account, kind);
    return {
      // Asked per file rather than seeded, so nothing has to enumerate
      // candidates here: this session's attempts plus whatever this
      // device has already given up on across earlier opens.
      skip: {
        has: (id: string) => session.has(id) || memory.exhausted(id),
        add: (id: string) => void session.add(id),
      },
      stop,
      onOutcome: (id: string, ok: boolean) => {
        memory.record(id, ok);
        session.add(id);
        consecutiveFailures = ok ? 0 : consecutiveFailures + 1;
      },
    };
  };

  try {
    const cap = isHandheld() ? { maxBytes: HANDHELD_AUTO_MAX_BYTES } : {};
    const thumbs = await store.backfillThumbnails({ ...pass("thumbs", attemptedThumbs), ...cap });
    const text =
      !stop() && ocrEnabled()
        ? await useStore.getState().recognizeAllImages(pass("text", attemptedOcr))
        : 0;
    const meaning =
      !stop() && semanticEnabled()
        ? await useStore.getState().embedAllImages(pass("meaning", attemptedClip))
        : 0;
    const facts =
      !stop() && factsEnabled()
        ? await useStore.getState().scanLibraryForFacts(pass("facts", attemptedFacts))
        : 0;
    return { thumbs, text, meaning, facts };
  } finally {
    running = false;
  }
}

/**
 * Asks for a pass after the device's delay. Calls coalesce: one timer,
 * and a pass already running counts as the answer.
 */
export function scheduleBackfill(): void {
  if (timer !== null || running) {
    return;
  }
  timer = setTimeout(() => {
    timer = null;
    void runBackfill().catch(() => {});
  }, backfillDelayMs(isHandheld()));
}
