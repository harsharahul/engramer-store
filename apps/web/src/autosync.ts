import { nativeOutboxDrain } from "./native";
import { useStore } from "./store";

/**
 * Keeps an open vault current without rituals. Sync is a client-driven
 * cursor pull, so a window that just sits there never learns about a
 * newly shared document, a share-sheet upload from the phone, or an
 * edit made on another device. This installs the missing heartbeat: a
 * refresh whenever the window returns to the foreground, and a gentle
 * poll while it stays visible. Each pass first flushes the share
 * sheet's staged uploads (iOS shell only; a no-op elsewhere), so the
 * refresh that follows already sees them.
 */

const FOREGROUND_COOLDOWN_MS = 15_000;
const POLL_INTERVAL_MS = 60_000;

let installed = false;

export function installAutoSync(): void {
  if (installed) {
    return;
  }
  installed = true;
  let lastRun = 0;
  let inFlight = false;

  const kick = () => {
    if (inFlight || Date.now() - lastRun < FOREGROUND_COOLDOWN_MS) {
      return;
    }
    const store = useStore.getState();
    if (!store.session || !store.synced) {
      return;
    }
    inFlight = true;
    void (async () => {
      await nativeOutboxDrain();
      await useStore.getState().refresh();
    })()
      .catch(() => {})
      .finally(() => {
        inFlight = false;
        lastRun = Date.now();
      });
  };

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      kick();
    }
  });
  window.addEventListener("focus", kick);
  window.setInterval(() => {
    if (document.visibilityState === "visible") {
      kick();
    }
  }, POLL_INTERVAL_MS);
}
