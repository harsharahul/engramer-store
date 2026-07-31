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

// ----- watched folders (desktop shell only) -----

export interface WatchedFile {
  path: string;
  name: string;
  rel_dirs: string[];
  size: number;
  mtime: number;
}

export async function watchedFolders(): Promise<string[]> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return [];
  }
  return (await invoke("watched_folders")) as string[];
}

export async function watchedAdd(path: string): Promise<string[]> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return [];
  }
  return (await invoke("watched_add", { path })) as string[];
}

export async function watchedRemove(path: string): Promise<string[]> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return [];
  }
  return (await invoke("watched_remove", { path })) as string[];
}

export async function watchedScan(): Promise<WatchedFile[]> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return [];
  }
  return (await invoke("watched_scan")) as WatchedFile[];
}

export async function watchedFileRead(path: string): Promise<ArrayBuffer> {
  const invoke = tauriInvoke();
  if (!invoke) {
    throw new Error("no native shell");
  }
  return (await invoke("watched_file_read", { path })) as ArrayBuffer;
}

/** Native folder picker; null when dismissed. */
export async function pickFolder(): Promise<string | null> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return null;
  }
  const chosen = await invoke("plugin:dialog|open", {
    options: { directory: true, multiple: false },
  });
  return typeof chosen === "string" ? chosen : null;
}

/** Subscribes to shell events; returns an unsubscribe, or a no-op outside
 * the shell. */
export async function nativeListen<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  const shell = (
    window as {
      __TAURI__?: {
        event?: { listen?: (e: string, cb: (ev: { payload: T }) => void) => Promise<() => void> };
      };
    }
  ).__TAURI__;
  if (!shell?.event?.listen) {
    return () => {};
  }
  return shell.event.listen(event, (ev) => handler(ev.payload));
}
