import { uploadLanes } from "./analysisslot";
import { scheduleBackfill } from "./backfill";
import { BackupLedger } from "./backupledger";
import { loadPolicy, windowStartMs, type BackupPolicy } from "./backuppolicy";
import { connectionIsUnmetered } from "./connection";
import { SweepMemory } from "./sweepmemory";
import {
  nativePhotoFile,
  nativePhotosAuthorize,
  nativePhotosAvailable,
  nativePhotosList,
  pickedStreamingAvailable,
  type NativePhotoAsset,
} from "./native";
import { useStore } from "./store";
import { sourceDigest } from "./transfer";
import { boundedRun } from "./uploader";

/**
 * Automatic photo backup, foreground pass.
 *
 * The honest shape of this on iOS: most backup happens while the app is
 * open, because the system wakes a background task only when it feels
 * like it. So the loop lives here, in the web layer, reusing the same
 * encrypt-and-upload every manual upload uses. Native code lists the
 * library and exports originals; nothing decrypts or uploads outside the
 * web view. The set of already-backed-up photos comes from the synced
 * library itself (each file carries its asset id), so a reinstall
 * re-derives it without re-uploading.
 *
 * Full-library access is a real step up from the picker, which asks for
 * nothing. Consent is explicit: the caller shows the explainer, then this
 * requests access, and the loop runs only if it was granted.
 */

export * from "./backuppolicy";

export async function backupAvailable(): Promise<boolean> {
  return nativePhotosAvailable();
}

/** Requests full-library access; returns the granted status. */
export async function requestBackupAccess(): Promise<string> {
  return nativePhotosAuthorize();
}

export interface BackupProgress {
  done: number;
  total: number;
  failed: number;
  /** Photos this device gave up on after repeated export failures; a
   * hand-run pass clears the record and tries them again. */
  skipped: number;
  /** The photo most recently taken up, once its name is known. */
  current?: string;
}

/** Clears the per-device export-failure record, so a manual pass means
 * "try everything again". */
export function forgetBackupFailures(account: string): void {
  new SweepMemory(account, "backup").forgetAll();
}

function keep(asset: NativePhotoAsset, policy: BackupPolicy, since: number): boolean {
  if (asset.kind === "video" && !policy.includeVideos) {
    return false;
  }
  if (asset.screenshot && !policy.includeScreenshots) {
    return false;
  }
  if (asset.created_ms < since) {
    return false;
  }
  return true;
}

/** One pass at a time, whoever asked: a manual run overlapping the
 * automatic one would upload the same pending set twice. */
let passActive = false;

/**
 * Runs one backup pass: everything in the library this account has never
 * uploaded, with transfers overlapped the same way the picker path
 * overlaps them. What counts as uploaded comes from the persisted ledger,
 * fed by the synced library, so trashing or deleting vault copies never
 * re-arms a re-upload on its own. Exports that keep failing are budgeted
 * per device and then skipped, visibly. Reports progress; never throws
 * for a single asset's failure, so one unreadable photo does not stop
 * the rest. Returns null when a pass is already running.
 */
export async function runBackup(
  policy: BackupPolicy,
  onProgress?: (progress: BackupProgress) => void,
  signal?: { aborted: boolean },
): Promise<BackupProgress | null> {
  if (passActive) {
    return null;
  }
  passActive = true;
  try {
    const store = useStore.getState();
    const account = store.session?.email ?? "";
    const ledger = new BackupLedger(account);
    ledger.absorb(store.files.values());
    const memory = new SweepMemory(account, "backup");
    const since = windowStartMs(policy);
    let assets = (await nativePhotosList()).filter((a) => keep(a, policy, since));
    // A shell that can only read files whole must not read videos at all:
    // that is the memory kill. They wait for the updated shell, and the
    // wait is shown beside the knob, not burned as failed attempts.
    const heldVideos = (await pickedStreamingAvailable())
      ? 0
      : assets.filter((a) => a.kind === "video").length;
    if (heldVideos > 0) {
      assets = assets.filter((a) => a.kind !== "video");
    }
    useStore.setState({ backupHold: heldVideos > 0 ? "shell-videos" : null });
    const fresh = assets.filter((a) => !ledger.has(a.id));
    const pending = fresh.filter((a) => !memory.exhausted(a.id));
    // Content answers what the id cannot: a photo added by hand before
    // the picker carried identities has no stamp, but its bytes are in
    // the vault. Candidates are hashed before uploading (they were about
    // to be read in full anyway) and a match becomes ledger knowledge
    // instead of a duplicate.
    const digests = new Set<string>();
    for (const file of store.files.values()) {
      if (file.digest) {
        digests.add(file.digest);
      }
    }

    const progress: BackupProgress = {
      done: 0,
      total: pending.length,
      failed: 0,
      skipped: fresh.length - pending.length,
    };
    onProgress?.({ ...progress });

    await boundedRun(pending, uploadLanes(), async (asset) => {
      if (signal?.aborted) {
        return;
      }
      try {
        const file = await nativePhotoFile(asset.id, asset.filename);
        if (!file) {
          progress.failed++;
          memory.record(asset.id, false);
        } else {
          progress.current = file.name;
          onProgress?.({ ...progress });
          if (digests.size > 0 && digests.has(await sourceDigest(file))) {
            // Already stored, byte for byte; remember that instead of
            // uploading it again, and drop the staged export.
            await file.dispose?.();
            ledger.add(asset.id);
            memory.record(asset.id, true);
            progress.done++;
          } else {
            await useStore.getState().backupAsset(file, asset.id);
            ledger.add(asset.id);
            memory.record(asset.id, true);
            progress.done++;
          }
        }
      } catch {
        // Budgeted rather than endless: without the record, one export
        // the device can never finish re-ran on every pass forever.
        progress.failed++;
        memory.record(asset.id, false);
      }
      onProgress?.({ ...progress });
    });
    return progress;
  } finally {
    passActive = false;
  }
}

/**
 * Backup used to run only from the button in Profile, which quietly meant
 * "never" on a phone that opens the app to look at photos. The automatic
 * pass runs when the app opens or returns to the foreground, spaced by a
 * cooldown so focus-flapping does not re-list the photo library every few
 * seconds. It narrates itself through the shared batch pill, so the
 * activity is visible on any screen, not only in Profile.
 */
const AUTO_COOLDOWN_MS = 10 * 60_000;
let lastAutoPass = -Infinity;
let autoRunning = false;
let autoInstalled = false;
let autoAbort: { aborted: boolean } | null = null;

/** Stops the running automatic pass; in-flight photos finish, the rest wait. */
export function stopAutoBackup(): void {
  if (autoAbort) {
    autoAbort.aborted = true;
  }
}

export async function autoBackupPass(now = Date.now()): Promise<BackupProgress | null> {
  if (autoRunning || now - lastAutoPass < AUTO_COOLDOWN_MS) {
    return null;
  }
  // Taken synchronously, before the first await: two foreground events in
  // the same beat used to both clear this guard during the gates' async
  // checks and run the whole pass twice.
  autoRunning = true;
  try {
    const policy = loadPolicy();
    if (!policy.enabled) {
      return null;
    }
    if (!(await nativePhotosAvailable())) {
      return null;
    }
    const store = useStore.getState();
    const uploading = store.uploads.some((u) => u.status !== "done" && u.status !== "error");
    // serverSynced, not just synced: the cached library satisfies synced
    // before the network answers, and deciding what still needs uploading
    // against that stale ledger re-uploaded whatever the cache had missed.
    if (!store.session || !store.synced || !store.serverSynced || uploading || store.batch) {
      return null;
    }
    // Nothing to gain from starting an upload pass with no network; the
    // next foreground brings the device back and tries again.
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      return null;
    }
    // The Wi-Fi only knob is a promise, not a suggestion. Skipping happens
    // before the cooldown is spent, so the next foreground retries; the
    // hold is shown where the knob lives rather than passing silently.
    if (policy.wifiOnly && !(await connectionIsUnmetered())) {
      useStore.setState({ backupHold: "wifi" });
      return null;
    }
    useStore.setState({ backupHold: null });
    lastAutoPass = now;
    autoAbort = { aborted: false };
    // Visibility and control travel together: the pill that narrates the
    // pass is also where it can be stopped.
    useStore.setState({ batchStop: stopAutoBackup });
    try {
      const progress = await runBackup(
        policy,
        (p) => {
          if (p.total > 0) {
            useStore.setState({
              batch: { done: p.done, total: p.total, failed: p.failed, current: p.current ?? "" },
            });
          }
        },
        autoAbort,
      );
      if (progress) {
        // The pass ships photos with their heavy scanners deferred; let
        // the backfill catch up while the app is still open.
        scheduleBackfill();
      }
      return progress;
    } finally {
      useStore.setState({ batch: null, batchStop: null });
      autoAbort = null;
    }
  } finally {
    autoRunning = false;
  }
}

/** Installs the app-open and return-to-foreground triggers, once. */
export function installAutoBackup(): void {
  if (autoInstalled) {
    return;
  }
  autoInstalled = true;
  const kick = () => {
    void autoBackupPass().catch(() => {});
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      kick();
    }
  });
  kick();
}
