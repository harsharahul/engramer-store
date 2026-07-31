import { useEffect, useState } from "react";
import { useStore } from "../store";
import { formatBytes } from "../format";
import { ACCENTS, type ThemeMode } from "../theme";
import {
  clearNativeUnlock,
  deviceUnlockSupported,
  enrollDeviceUnlock,
  enrollNativeUnlock,
  hasDeviceUnlock,
} from "../unlock";
import {
  nativeShell,
  nativeUnlockAvailable,
  pickFolder,
  watchedAdd,
  watchedFolders,
  watchedRemove,
} from "../native";
import { syncWatchedNow } from "../watchfolders";
import { AdminBody } from "./AdminPanel";
import { KeyGlyph, LockGlyph, MoonGlyph, ScanTextGlyph, SparkGlyph, SunGlyph } from "./Icon";

type UnlockState = "checking" | "on" | "available" | "native" | "unsupported";

/**
 * One page for the whole account: identity, storage, security, preferences,
 * this device, and (for operators) server administration. Everything here
 * reuses the same state the sidebar controls use, so the two never disagree.
 */
export function ProfileView(props: {
  ocrOn: boolean;
  onToggleOcr: () => void;
  semanticOn: boolean;
  onToggleSemantic: () => void;
  theme: ThemeMode;
  onToggleTheme: () => void;
  accent: string;
  onAccent: (id: string) => void;
  onOpenTwoFactor: () => void;
  onLock: () => void;
  onToast: (message: string) => void;
}) {
  const store = useStore();
  const [unlockState, setUnlockState] = useState<UnlockState>("checking");
  const [enrolling, setEnrolling] = useState(false);
  const [shell] = useState(() => nativeShell());
  const [watched, setWatched] = useState<string[]>([]);

  useEffect(() => {
    if (shell) {
      void watchedFolders().then(setWatched);
    }
  }, [shell]);

  const addWatchedFolder = async () => {
    const path = await pickFolder();
    if (!path) {
      return;
    }
    try {
      setWatched(await watchedAdd(path));
      props.onToast("Folder is being watched. New files there upload automatically.");
      void syncWatchedNow();
    } catch (err) {
      props.onToast(err instanceof Error ? err.message : "could not watch that folder");
    }
  };

  useEffect(() => {
    if (hasDeviceUnlock()) {
      setUnlockState("on");
      return;
    }
    void (async () => {
      if (await nativeUnlockAvailable()) {
        setUnlockState("native");
      } else {
        setUnlockState((await deviceUnlockSupported()) ? "available" : "unsupported");
      }
    })();
  }, []);

  const email = store.session?.email ?? "";
  const usage = store.usage;
  const usagePercent = usage ? Math.min(100, (usage.usedBytes / usage.quotaBytes) * 100) : 0;

  const setUpUnlock = async () => {
    const session = store.session;
    if (!session) {
      return;
    }
    setEnrolling(true);
    const viaShell = unlockState === "native";
    const result = viaShell ? await enrollNativeUnlock(session) : await enrollDeviceUnlock(session);
    setEnrolling(false);
    if (result === "enrolled") {
      setUnlockState("on");
      props.onToast("Device unlock is on. Next launch, one touch opens the vault.");
    } else if (result === "cancelled") {
      props.onToast("Setup cancelled. You can try again any time.");
    } else {
      setUnlockState("unsupported");
      props.onToast(
        viaShell ? "The Keychain refused to store the unlock secret." : "This device could not create a vault passkey.",
      );
    }
  };

  const turnOffUnlock = () => {
    clearNativeUnlock();
    void (async () =>
      setUnlockState(
        (await nativeUnlockAvailable())
          ? "native"
          : (await deviceUnlockSupported())
            ? "available"
            : "unsupported",
      ))();
    props.onToast("Device unlock is off. Your password unlocks the vault from now on.");
  };

  return (
    <div className="profile">
      <section className="profile-card profile-head">
        <div className="profile-avatar">{(email[0] ?? "?").toUpperCase()}</div>
        <div className="profile-id">
          <h2>{email}</h2>
          <div className="profile-sub">
            {store.isAdmin ? "Administrator · " : ""}
            End-to-end encrypted vault
          </div>
        </div>
        <button className="btn" onClick={props.onLock}>
          <LockGlyph size={14} /> Lock and sign out
        </button>
      </section>

      {usage && (
        <section className="profile-card">
          <h3>Storage</h3>
          <div className="profile-row">
            <div className="profile-row-main">
              <b>
                {formatBytes(usage.usedBytes)} of {formatBytes(usage.quotaBytes)}
              </b>
              <div className="profile-row-sub">Everything is encrypted before it leaves a device.</div>
            </div>
          </div>
          <div className="meter profile-meter">
            <div style={{ width: `${usagePercent}%` }} />
          </div>
        </section>
      )}

      <section className="profile-card">
        <h3>Security</h3>
        <div className="profile-row">
          <div className="profile-row-main">
            <b>Two-factor authentication</b>
            <div className="profile-row-sub">
              Time-based codes protect sign-in; your vault keys never depend on them.
            </div>
          </div>
          <button className="btn" onClick={props.onOpenTwoFactor}>
            <KeyGlyph size={13} /> Manage
          </button>
        </div>
        <div className="profile-row">
          <div className="profile-row-main">
            <b>Device unlock</b>
            <div className="profile-row-sub">
              {unlockState === "on"
                ? "On for this device: Touch ID or a passkey opens the vault."
                : unlockState === "native"
                  ? "Skip typing the password: Touch ID guards the vault through the Mac's Keychain."
                  : unlockState === "available"
                    ? "Skip typing the password: unlock with Touch ID or a passkey."
                    : unlockState === "unsupported"
                      ? "Not available in this browser. Safari, Chrome, and the desktop app support it."
                      : "Checking this device…"}
            </div>
          </div>
          {unlockState === "on" ? (
            <button className="btn" onClick={turnOffUnlock}>
              Turn off
            </button>
          ) : unlockState === "available" || unlockState === "native" ? (
            <button className="btn btn-primary" disabled={enrolling} onClick={() => void setUpUnlock()}>
              {enrolling ? "Waiting…" : "Set up"}
            </button>
          ) : null}
        </div>
        <div className="profile-row">
          <div className="profile-row-main">
            <b>Recovery key</b>
            <div className="profile-row-sub">
              Shown once at signup. It is the only way back into this account if the password is
              lost; nobody can reset it for you, by design.
            </div>
          </div>
        </div>
      </section>

      <section className="profile-card">
        <h3>Preferences</h3>
        <div className="profile-row">
          <div className="profile-row-main">
            <b>Appearance</b>
            <div className="profile-row-sub">Theme and accent apply to this device.</div>
          </div>
          <div className="profile-appearance">
            <button className="btn" onClick={props.onToggleTheme}>
              {props.theme === "dark" ? <MoonGlyph size={13} /> : <SunGlyph size={13} />}
              {props.theme === "dark" ? " Night" : " Day"}
            </button>
            <div className="profile-accents">
              {ACCENTS.map((a) => (
                <button
                  key={a.id}
                  className={`accent-dot${props.accent === a.id ? " on" : ""}`}
                  title={`${a.label} theme`}
                  style={{ background: `linear-gradient(135deg, ${a.from}, ${a.to})` }}
                  onClick={() => props.onAccent(a.id)}
                />
              ))}
            </div>
          </div>
        </div>
        <div className="profile-row">
          <div className="profile-row-main">
            <b>
              <ScanTextGlyph size={13} /> Read text in images
            </b>
            <div className="profile-row-sub">
              On-device text recognition makes screenshots and scans searchable.
            </div>
          </div>
          <button
            className="profile-switch"
            role="switch"
            aria-checked={props.ocrOn}
            onClick={props.onToggleOcr}
          >
            <span className={`switch${props.ocrOn ? " on" : ""}`} />
          </button>
        </div>
        <div className="profile-row">
          <div className="profile-row-main">
            <b>
              <SparkGlyph size={13} /> Find media by meaning
            </b>
            <div className="profile-row-sub">
              A small on-device model makes photos and videos findable by what is in them; nothing
              leaves this device.
            </div>
          </div>
          <button
            className="profile-switch"
            role="switch"
            aria-checked={props.semanticOn}
            onClick={props.onToggleSemantic}
          >
            <span className={`switch${props.semanticOn ? " on" : ""}`} />
          </button>
        </div>
      </section>

      {shell && (
        <section className="profile-card">
          <h3>Watched folders</h3>
          <div className="profile-row">
            <div className="profile-row-main">
              <b>Automatic uploads</b>
              <div className="profile-row-sub">
                New files in these folders upload themselves, encrypted, with subfolders
                preserved. One-way: nothing is ever deleted, and a file whose name and size
                already exist in the vault is skipped.
              </div>
            </div>
            <button className="btn btn-primary" onClick={() => void addWatchedFolder()}>
              Add folder
            </button>
          </div>
          {watched.map((path) => (
            <div key={path} className="profile-row">
              <div className="profile-row-main">
                <b className="watched-path">{path}</b>
              </div>
              <button
                className="btn"
                onClick={() =>
                  void watchedRemove(path).then((rest) => {
                    setWatched(rest);
                    props.onToast("Folder is no longer watched; nothing was deleted.");
                  })
                }
              >
                Stop watching
              </button>
            </div>
          ))}
        </section>
      )}

      <section className="profile-card">
        <h3>This device</h3>
        <div className="profile-row">
          <div className="profile-row-main">
            <b>Resync library</b>
            <div className="profile-row-sub">
              Rebuilds this device's encrypted cache from the server; fixes a listing that looks
              stale.
            </div>
          </div>
          <button
            className="btn"
            onClick={() => {
              props.onToast("Resyncing your library…");
              void store
                .resyncLibrary()
                .then(() => props.onToast("Library resynced."))
                .catch(() => props.onToast("Resync failed; check the connection."));
            }}
          >
            Resync
          </button>
        </div>
      </section>

      {store.isAdmin && (
        <section className="profile-card">
          <h3>Server administration</h3>
          <AdminBody onToast={props.onToast} />
        </section>
      )}
    </div>
  );
}
