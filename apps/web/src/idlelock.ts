import { settingChanged } from "./settingsbus";

/**
 * Lock after inactivity. A quiet spell of the chosen length locks the
 * vault the way the Lock button does: keys leave memory, device unlock
 * or the password reopens it. Off by default; the choice follows the
 * account through the synced settings.
 */

const MINUTES_KEY = "engram-idle-lock-minutes";

export const IDLE_LOCK_CHOICES: ReadonlyArray<{ minutes: number; label: string }> = [
  { minutes: 0, label: "Off" },
  { minutes: 5, label: "5 minutes" },
  { minutes: 15, label: "15 minutes" },
  { minutes: 30, label: "30 minutes" },
  { minutes: 60, label: "1 hour" },
];

/** 0 means off. */
export function idleLockMinutes(): number {
  try {
    const value = Number(localStorage.getItem(MINUTES_KEY) ?? 0);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

export function setIdleLockMinutes(minutes: number): void {
  try {
    if (minutes > 0) {
      localStorage.setItem(MINUTES_KEY, String(minutes));
    } else {
      localStorage.removeItem(MINUTES_KEY);
    }
  } catch {
    // Storage may be unavailable; the watch simply reads "off".
  }
  settingChanged();
}

const ACTIVITY_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart", "scroll"] as const;

export interface IdleLockOptions {
  /** Read on every check, so a changed setting applies without a reinstall. */
  minutes: () => number;
  onLock: () => void;
  /** Where activity arrives; the document in a browser. */
  target?: EventTarget;
  now?: () => number;
  checkEveryMs?: number;
}

/**
 * Watches for activity and locks once the quiet spell exceeds the
 * setting. Returning from a hidden tab or a sleeping machine checks at
 * once, so a laptop closed for the night is locked the moment its lid
 * opens, not a check interval later. Locks at most once per install; the
 * vault unmounts on lock and reinstalls on the next unlock.
 */
export function installIdleLock(options: IdleLockOptions): () => void {
  const target = options.target ?? (typeof document !== "undefined" ? document : null);
  if (!target) {
    return () => {};
  }
  // Read through the global each time rather than capturing the function:
  // a test clock installed after the watch exists must still be honored.
  const now = options.now ?? (() => Date.now());
  let last = now();
  let locked = false;

  const touch = () => {
    last = now();
  };
  const check = () => {
    const minutes = options.minutes();
    if (locked || minutes <= 0) {
      return;
    }
    if (now() - last >= minutes * 60_000) {
      locked = true;
      options.onLock();
    }
  };

  const listen = { passive: true, capture: true } as const;
  for (const type of ACTIVITY_EVENTS) {
    target.addEventListener(type, touch, listen);
  }
  target.addEventListener("visibilitychange", check);
  const timer = setInterval(check, options.checkEveryMs ?? 15_000);

  return () => {
    clearInterval(timer);
    for (const type of ACTIVITY_EVENTS) {
      target.removeEventListener(type, touch, listen);
    }
    target.removeEventListener("visibilitychange", check);
  };
}
