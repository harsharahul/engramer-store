/**
 * Preferences that follow the account.
 *
 * Every switch here used to live only in a device's local storage: the
 * same toggles had to be flipped on every device, and again whenever iOS
 * decided to evict the storage. They now travel as ONE blob, sealed on
 * the client with the master key; the server stores and stamps it and can
 * read nothing.
 *
 * Deliberately per-device, never synced: the backup on/off switch (bound
 * to that device's photo-library permission), the failure memories and
 * the upload ledger (per-device by design), and the theme.
 *
 * Conflict rule: last write wins, ordered by the server's stamp. A
 * device applies a remote blob only when the stamp is beyond what it has
 * already seen, so applying is idempotent and a device's own push never
 * bounces back onto it.
 */

import { secretBoxOpen, secretBoxSeal, utf8Encode, type SecretBox } from "@engramer/crypto";
import { api } from "./api";
import { autoBackfillEnabled, setAutoBackfillEnabled } from "./backfill";
import { loadPolicy, savePolicy, type BackupWindow } from "./backuppolicy";
import { diag } from "./diag";
import { entitiesEnabled, setEntitiesEnabled } from "./intel/entities";
import { ocrEnabled, setOcrEnabled } from "./intel/ocr";
import { factsEnabled, setFactsEnabled } from "./intel/scan";
import { semanticEnabled, setSemanticEnabled } from "./intel/semantic";
import { onSettingChanged } from "./settingsbus";

export interface SyncedSettings {
  version: 1;
  ocr: boolean;
  semantic: boolean;
  facts: boolean;
  entities: boolean;
  autoFill: boolean;
  backup: {
    window: BackupWindow;
    windowAnchorMs?: number;
    includeVideos: boolean;
    includeScreenshots: boolean;
    wifiOnly: boolean;
  };
}

/** Fires after a remote blob is applied, so open views re-read the
 * switches they hold in state. Its own target rather than `window`: the
 * test environment has no window, and nothing else needs to overhear. */
export const SETTINGS_APPLIED_EVENT = "engram-settings-applied";
export const settingsEvents = new EventTarget();

function markKey(account: string): string {
  return `engram-settings-rev:${account}`;
}

function readMark(account: string): number {
  try {
    return Number(localStorage.getItem(markKey(account)) ?? 0) || 0;
  } catch {
    return 0;
  }
}

function writeMark(account: string, updatedAt: number): void {
  try {
    localStorage.setItem(markKey(account), String(updatedAt));
  } catch {
    // Best-effort: without the mark the next pull re-applies, harmlessly.
  }
}

export function snapshotSettings(): SyncedSettings {
  const policy = loadPolicy();
  return {
    version: 1,
    ocr: ocrEnabled(),
    semantic: semanticEnabled(),
    facts: factsEnabled(),
    entities: entitiesEnabled(),
    autoFill: autoBackfillEnabled(),
    backup: {
      window: policy.window,
      ...(policy.windowAnchorMs !== undefined ? { windowAnchorMs: policy.windowAnchorMs } : {}),
      includeVideos: policy.includeVideos,
      includeScreenshots: policy.includeScreenshots,
      wifiOnly: policy.wifiOnly,
    },
  };
}

/** True while a remote blob is being written into the local setters, so
 * their announcements do not echo straight back as a push. */
let applying = false;

export function applySettings(values: SyncedSettings): void {
  applying = true;
  try {
    applyInner(values);
  } finally {
    applying = false;
  }
  settingsEvents.dispatchEvent(new Event(SETTINGS_APPLIED_EVENT));
}

function applyInner(values: SyncedSettings): void {
  setOcrEnabled(values.ocr);
  setSemanticEnabled(values.semantic);
  setFactsEnabled(values.facts);
  setEntitiesEnabled(values.entities);
  setAutoBackfillEnabled(values.autoFill);
  const local = loadPolicy();
  savePolicy({
    ...local,
    // The on/off switch is this device's own; only the knobs travel.
    window: values.backup.window,
    ...(values.backup.windowAnchorMs !== undefined
      ? { windowAnchorMs: values.backup.windowAnchorMs }
      : {}),
    includeVideos: values.backup.includeVideos,
    includeScreenshots: values.backup.includeScreenshots,
    wifiOnly: values.backup.wifiOnly,
  });
}

function seal(values: SyncedSettings, masterKey: Uint8Array): string {
  return JSON.stringify(secretBoxSeal(utf8Encode(JSON.stringify(values)), masterKey));
}

function open(blob: string, masterKey: Uint8Array): SyncedSettings | null {
  try {
    const box = JSON.parse(blob) as SecretBox;
    const bytes = secretBoxOpen(box, masterKey);
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as SyncedSettings;
    return parsed && parsed.version === 1 ? parsed : null;
  } catch {
    // A blob from a future version, or a foreign key: leave local alone.
    return null;
  }
}

/** Pushes this device's switches; the account's newest word is now ours. */
export async function pushSettings(account: string, masterKey: Uint8Array): Promise<void> {
  const { updatedAt } = await api.putSettings(seal(snapshotSettings(), masterKey));
  writeMark(account, updatedAt);
}

/**
 * Fetches the account's settings and applies them when they are newer
 * than what this device has seen. An account with none yet is seeded
 * from this device, so the first device's choices become the account's.
 */
export async function pullSettings(account: string, masterKey: Uint8Array): Promise<void> {
  const remote = await api.getSettings();
  if (remote.updatedAt === 0 || remote.blob === null) {
    await pushSettings(account, masterKey);
    return;
  }
  if (remote.updatedAt <= readMark(account)) {
    return;
  }
  const values = open(remote.blob, masterKey);
  if (!values) {
    diag("settings", "the account blob is unreadable here; keeping local switches");
    return;
  }
  applySettings(values);
  writeMark(account, remote.updatedAt);
}

/** How long a flurry of toggle flips coalesces before one push. */
const PUSH_DEBOUNCE_MS = 1_500;

let installed = false;

/**
 * Wires the setters' announcements to a debounced push. `session` is
 * read per change, so sign-out simply stops the pushes.
 */
export function installSettingsSync(
  session: () => { email: string; masterKey: Uint8Array } | null,
): void {
  if (installed) {
    return;
  }
  installed = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  onSettingChanged(() => {
    if (applying) {
      return;
    }
    const live = session();
    if (!live) {
      return;
    }
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      const current = session();
      if (current) {
        void pushSettings(current.email, current.masterKey).catch(() => {
          // Offline now; the next pull-or-toggle tries again.
        });
      }
    }, PUSH_DEBOUNCE_MS);
  });
}
