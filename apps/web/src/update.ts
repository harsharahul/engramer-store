import { APP_VERSION } from "./version";
import { diag } from "./diag";

/**
 * Notices when the deployment has moved on from the build in this page.
 *
 * The client is long-lived by design: it is a home-screen app, a desktop
 * window that reopens rather than relaunches, and a tab people leave open for
 * days. Its service worker will fetch a new build in the background, but the
 * page keeps running the code it started with until something reloads it, so
 * a deployment can be hours old and still unseen. The desktop shell makes
 * this sharper: it loads the hosted client, so a frontend release reaches it
 * on a reload and never needs the app itself rebuilt.
 *
 * So this asks the server what it is serving now and compares it with what is
 * running here. A version file is the whole mechanism: small, uncached, and
 * true regardless of what any cache in between believes.
 */

const VERSION_URL = "/version.json";
/** Quiet: a released version is not urgent, and this runs for days. */
const EVERY = 30 * 60 * 1000;

async function deployedVersion(): Promise<string | null> {
  try {
    // Past every cache: the service worker, the HTTP cache, and whatever a
    // proxy in front has decided. A stale answer here is worse than none.
    const response = await fetch(`${VERSION_URL}?at=${Date.now()}`, {
      cache: "no-store",
      headers: { "cache-control": "no-cache" },
    });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : null;
  } catch {
    // Offline, or a deployment mid-flight. Neither is worth reporting.
    return null;
  }
}

/**
 * Calls back once, with the version now being served, when it differs from
 * this build. Returns a function that stops watching.
 */
export function watchForUpdate(onAvailable: (version: string) => void): () => void {
  let stopped = false;
  let announced = false;

  const check = async () => {
    if (stopped || announced) {
      return;
    }
    const deployed = await deployedVersion();
    if (!deployed || deployed === APP_VERSION) {
      return;
    }
    announced = true;
    diag("app", `version ${deployed} is deployed; this page is running ${APP_VERSION}`);
    onAvailable(deployed);
  };

  // On returning to the app as well as on a timer: someone coming back to a
  // window left open overnight is exactly who is running an old build.
  const onVisible = () => {
    if (document.visibilityState === "visible") {
      void check();
    }
  };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", onVisible);
  const timer = setInterval(() => void check(), EVERY);
  // Not at the instant of load: the page has better things to do, and a
  // version that just changed is not urgent.
  const initial = setTimeout(() => void check(), 20_000);

  return () => {
    stopped = true;
    clearInterval(timer);
    clearTimeout(initial);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", onVisible);
  };
}

/**
 * Reloads onto the new build. The service worker is asked to step aside
 * first, so the reload fetches the new shell rather than being handed the
 * precached copy of the old one.
 */
export async function reloadForUpdate(): Promise<void> {
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    await registration?.update();
  } catch {
    // A worker that will not update is not a reason to refuse the reload.
  }
  window.location.reload();
}
