/**
 * Bridge to the desktop shell, when there is one. The web app never assumes
 * a native layer: every helper degrades to "not available" in a plain
 * browser, and callers fall back to the browser-native path (WebAuthn).
 * The shell exposes exactly four commands, all about the unlock secret;
 * key material still lives and is used only inside this web context.
 */

type TauriInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

function tauriInvoke(): TauriInvoke | null {
  const shell = (
    window as { __TAURI__?: { core?: { invoke?: TauriInvoke } } }
  ).__TAURI__;
  return shell?.core?.invoke ?? null;
}

/** True when running inside the desktop shell. */
export function nativeShell(): boolean {
  return tauriInvoke() !== null;
}

/** True when the shell can gate secrets behind Touch ID (or the login
 * password on Macs without it). */
export async function nativeUnlockAvailable(): Promise<boolean> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return false;
  }
  try {
    return (await invoke("native_unlock_available")) === true;
  } catch {
    return false;
  }
}

/** Thrown message fragment when the user dismissed the biometric prompt. */
export const NATIVE_CANCELLED = "cancelled";

export async function nativeSecretStore(email: string, secret: string): Promise<void> {
  const invoke = tauriInvoke();
  if (!invoke) {
    throw new Error("no native shell");
  }
  await invoke("unlock_secret_store", { email, secret });
}

export async function nativeSecretGet(email: string): Promise<string> {
  const invoke = tauriInvoke();
  if (!invoke) {
    throw new Error("no native shell");
  }
  const secret = await invoke("unlock_secret_get", { email });
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error("no secret");
  }
  return secret;
}

export async function nativeSecretDelete(email: string): Promise<void> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return;
  }
  await invoke("unlock_secret_delete", { email }).catch(() => {});
}
