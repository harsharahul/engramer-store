/**
 * The backup policy: what automatic photo backup covers and the promises
 * it keeps while running. A leaf module so the passes that honor the
 * policy (backup, backfill) and the surfaces that edit it can all read
 * one definition without importing each other.
 */

import { settingChanged } from "./settingsbus";

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
  settingChanged();
}
