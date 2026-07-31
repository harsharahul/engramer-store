/**
 * A long upload dies with the screen: when the phone auto-locks, the page
 * suspends, the in-flight request is killed, and the picked file handle can
 * go stale. Holding a screen wake lock while transfers run keeps the device
 * awake; the lock is re-acquired if the OS releases it while work remains
 * and released the moment the last transfer finishes. Best-effort on
 * browsers without the API.
 */

let active = 0;
let sentinel: WakeLockSentinel | null = null;
let reacquire: (() => void) | null = null;

async function acquire(): Promise<void> {
  if (!("wakeLock" in navigator) || sentinel) {
    return;
  }
  try {
    sentinel = await navigator.wakeLock.request("screen");
    sentinel.addEventListener("release", () => {
      sentinel = null;
    });
    if (!reacquire) {
      // Backgrounding releases the lock; take it back when work remains.
      reacquire = () => {
        if (active > 0 && document.visibilityState === "visible") {
          void acquire();
        }
      };
      document.addEventListener("visibilitychange", reacquire);
    }
  } catch {
    sentinel = null;
  }
}

/** Marks a transfer as running; pair every call with releaseTransferLock. */
export function holdTransferLock(): void {
  active++;
  void acquire();
}

export function releaseTransferLock(): void {
  active = Math.max(0, active - 1);
  if (active === 0 && sentinel) {
    void sentinel.release().catch(() => {});
    sentinel = null;
  }
}
