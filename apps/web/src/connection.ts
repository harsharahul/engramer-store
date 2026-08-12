import { nativeNetworkStatus, type NativeNetworkStatus } from "./native";

/**
 * What "Wi-Fi only" actually promises: no backup or backfill spend on a
 * connection the owner pays for by the byte. The web view only knows
 * online or offline, so the interface type comes from the shell's
 * network monitor; in a plain browser there is no monitor and nothing
 * to enforce, which keeps the knob meaningful exactly where metered
 * networks exist (the phone and the Mac app).
 */

/**
 * The pure decision, separated for tests. Cellular is metered by
 * definition; expensive covers personal hotspots that look like Wi-Fi;
 * constrained is Low Data Mode, the owner asking every app to hold
 * back. An unknown report (monitor not answering yet) fails open:
 * backup quietly not running is the dishonest failure, and the offline
 * gate beside this one already covers the dead-network case.
 */
export function unmeteredConnection(status: NativeNetworkStatus | null): boolean {
  if (!status || !status.known) {
    return true;
  }
  return !(status.cellular || status.expensive || status.constrained);
}

/** Asks the shell for the current path and applies the decision. */
export async function connectionIsUnmetered(): Promise<boolean> {
  return unmeteredConnection(await nativeNetworkStatus());
}
