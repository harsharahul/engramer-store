import { scheduleBackfill } from "./backfill";
import { nativeFilesProviderSignal, nativeOutboxDrain } from "./native";
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
      // An empty delta leaves the maps untouched, so a changed reference
      // IS the "something arrived" signal.
      const filesBefore = useStore.getState().files;
      const foldersBefore = useStore.getState().folders;
      await useStore.getState().refresh();
      const after = useStore.getState();
      if (after.session && (after.files !== filesBefore || after.folders !== foldersBefore)) {
        // The system drive shows the change within this poll cycle
        // instead of whenever Finder or Files next asks on its own.
        await nativeFilesProviderSignal(after.session.email);
      }
      // Sync may have brought files that arrived without derivatives
      // (Files-app ingest, a deferred backup from the phone); whoever is
      // open picks the work up after the device's own delay.
      scheduleBackfill();
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
