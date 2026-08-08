import {
  nativePhotoFile,
  nativePhotosAuthorize,
  nativePhotosAvailable,
  nativePhotosList,
  type NativePhotoAsset,
} from "./native";
import { useStore } from "./store";

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

/** Which slice of the library backup covers, by capture date. */
export type BackupWindow = "all" | "today" | "30d" | "90d";

export interface BackupPolicy {
  enabled: boolean;
  includeVideos: boolean;
  includeScreenshots: boolean;
  wifiOnly: boolean;
  window: BackupWindow;
  /**
   * The fixed floor for the "today" window: start of the day the option
   * was chosen, so the meaning never drifts as days pass.
   */
  windowAnchorMs?: number;
}

export const DEFAULT_POLICY: BackupPolicy = {
  enabled: false,
  includeVideos: true,
  includeScreenshots: true,
  wifiOnly: true,
  window: "all",
};

/** The oldest capture time the policy's window admits. */
export function windowStartMs(policy: BackupPolicy, now = Date.now()): number {
  switch (policy.window) {
    case "today":
      return policy.windowAnchorMs ?? 0;
    case "30d":
      return now - 30 * 86_400_000;
    case "90d":
      return now - 90 * 86_400_000;
    default:
      return 0;
  }
}

const POLICY_KEY = "engram-backup-policy";

export function loadPolicy(): BackupPolicy {
  try {
    const raw = localStorage.getItem(POLICY_KEY);
    return raw ? { ...DEFAULT_POLICY, ...JSON.parse(raw) } : { ...DEFAULT_POLICY };
  } catch {
    return { ...DEFAULT_POLICY };
  }
}

export function savePolicy(policy: BackupPolicy): void {
  localStorage.setItem(POLICY_KEY, JSON.stringify(policy));
}

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

/**
 * Runs one backup pass: everything in the library the vault does not
 * already hold, one photo at a time (an iPhone cannot decode several
 * originals at once). Reports progress; never throws for a single
 * asset's failure, so one unreadable photo does not stop the rest.
 */
export async function runBackup(
  policy: BackupPolicy,
  onProgress?: (progress: BackupProgress) => void,
  signal?: { aborted: boolean },
): Promise<BackupProgress> {
  const store = useStore.getState();
  const since = windowStartMs(policy);
  const assets = (await nativePhotosList()).filter((a) => keep(a, policy, since));
  const already = store.backedUpSourceIds();
  const pending = assets.filter((a) => !already.has(a.id));

  const progress: BackupProgress = { done: 0, total: pending.length, failed: 0 };
  onProgress?.({ ...progress });

  for (const asset of pending) {
    if (signal?.aborted) {
      break;
    }
    try {
      const file = await nativePhotoFile(asset.id);
      if (!file) {
        progress.failed++;
      } else {
        await useStore.getState().backupAsset(file, asset.id);
        progress.done++;
      }
    } catch {
      // A ledger of failures is better than a stalled loop; the next
      // pass retries whatever is still missing.
      progress.failed++;
    }
    onProgress?.({ ...progress });
  }
  return progress;
}
