import { useEffect, useRef, useState } from "react";
import { IntegrityError, downloadAndDecrypt } from "../transfer";
import {
  describeVerify,
  verifyFiles,
  type VerifyProgress,
  type VerifyResult,
} from "../verify";
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
import {
  folderName,
  setWatchMode,
  syncWatchedNow,
  watchMode,
  type WatchMode,
} from "../watchfolders";
import { diagEntries, diagText, onDiag } from "../diag";
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
  onSignOut: () => void;
  onToast: (message: string) => void;
}) {
  const store = useStore();
  const [unlockState, setUnlockState] = useState<UnlockState>("checking");
  const [enrolling, setEnrolling] = useState(false);
  const [shell] = useState(() => nativeShell());
  const [watched, setWatched] = useState<string[]>([]);
  const [modes, setModes] = useState<Record<string, WatchMode>>({});
  const [verifying, setVerifying] = useState(false);
  const [verifyProgress, setVerifyProgress] = useState<VerifyProgress | null>(null);
  const [verifySummary, setVerifySummary] = useState<string | null>(null);
  const [verifyProblems, setVerifyProblems] = useState<VerifyResult["problems"]>([]);
  const verifyAbort = useRef<AbortController | null>(null);

  const runVerify = async () => {
    const controller = new AbortController();
    verifyAbort.current = controller;
    setVerifying(true);
    setVerifySummary(null);
    setVerifyProblems([]);
    const files = [...store.files.values()].filter((file) => !file.trashed);
    try {
      const result = await verifyFiles(
        files.map((file) => ({ id: file.id, name: file.name, size: file.size, digest: file.digest })),
        async (file) => {
          const entry = store.files.get(file.id)!;
          try {
            return await downloadAndDecrypt(entry.id, entry.key, entry.digest);
          } catch (err) {
            // The bytes came back; it is the digest that disagreed. Judge it
            // here rather than counting it as unreadable.
            if (err instanceof IntegrityError) {
              return err.bytes;
            }
            throw err;
          }
        },
        {
          signal: controller.signal,
          onProgress: setVerifyProgress,
          onVerdict: (file, verdict) => {
            if (verdict === "damaged") {
              store.markCorrupt(file.id);
            }
          },
        },
      );
      setVerifyProblems(result.problems);
      setVerifySummary(describeVerify(result, controller.signal.aborted));
    } catch {
      setVerifySummary("The check could not finish; try again on a steadier connection.");
    } finally {
      setVerifying(false);
      setVerifyProgress(null);
      verifyAbort.current = null;
    }
  };
  const [showDiag, setShowDiag] = useState(false);
  const [diagLines, setDiagLines] = useState(() => [...diagEntries()]);

  useEffect(() => {
    if (!showDiag) {
      return;
    }
    setDiagLines([...diagEntries()]);
    return onDiag(() => setDiagLines([...diagEntries()]));
  }, [showDiag]);

  useEffect(() => {
    if (shell) {
      void watchedFolders().then((paths) => {
        setWatched(paths);
        setModes(Object.fromEntries(paths.map((path) => [path, watchMode(path)])));
      });
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
        <div className="profile-head-actions">
          {unlockState === "on" && (
            <button className="btn" title="Touch ID or your passkey reopens the vault" onClick={props.onLock}>
              <LockGlyph size={14} /> Lock
            </button>
          )}
          <button
            className="btn"
            title="Full sign-out: removes device unlock; password required next time"
            onClick={props.onSignOut}
          >
            Sign out
          </button>
        </div>
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
                <div className="watch-modes">
                  <button
                    className={`sheet-tab${modes[path] !== "mirrored" ? " active" : ""}`}
                    onClick={() => {
                      setWatchMode(path, "sorted");
                      setModes({ ...modes, [path]: "sorted" });
                      props.onToast("New arrivals will be sorted by kind and tagged with the folder name.");
                    }}
                  >
                    Sort by kind
                  </button>
                  <button
                    className={`sheet-tab${modes[path] === "mirrored" ? " active" : ""}`}
                    onClick={() => {
                      setWatchMode(path, "mirrored");
                      setModes({ ...modes, [path]: "mirrored" });
                      props.onToast(`New arrivals will go into a "${folderName(path)}" folder.`);
                    }}
                  >
                    Keep the folder
                  </button>
                </div>
                <div className="profile-note">
                  {modes[path] === "mirrored"
                    ? `Files land in a "${folderName(path)}" folder, subfolders and all.`
                    : `Files are filed by what they are, tagged "${folderName(path)}" so you can find them.`}
                </div>
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

      <section className="profile-card">
        <h3>Integrity</h3>
        <div className="profile-row">
          <div className="profile-row-main">
            <b>Check every file</b>
            <div className="profile-row-sub">
              Reads each file back and compares it against the digest taken when it was
              uploaded. Nothing else can tell you this: the server cannot read your files, so
              it cannot check them for you. It downloads everything, so it is worth doing on a
              connection you do not pay by the megabyte.
            </div>
            {verifying && (
              <div className="profile-row-sub">
                {verifyProgress
                  ? `Checked ${verifyProgress.done} of ${verifyProgress.total}: ${verifyProgress.current}`
                  : "Starting…"}
              </div>
            )}
            {verifySummary && <div className="profile-row-sub"><b>{verifySummary}</b></div>}
            {verifyProblems.length > 0 && (
              <ul className="verify-problems">
                {verifyProblems.slice(0, 20).map((problem) => (
                  <li key={problem.id}>
                    <span className={`verify-verdict ${problem.verdict}`}>{problem.verdict}</span>
                    {problem.name}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button
            className="btn"
            onClick={() => {
              if (verifying) {
                verifyAbort.current?.abort();
                return;
              }
              void runVerify();
            }}
          >
            {verifying ? "Stop" : "Check files"}
          </button>
        </div>
      </section>

      <section className="profile-card">
        <h3>Diagnostics</h3>
        <div className="profile-row">
          <div className="profile-row-main">
            <b>Activity log</b>
            <div className="profile-row-sub">
              What this device did recently: upload retries, playback stalls, watched-folder
              activity. Kept only in this tab's memory; never sent anywhere.
            </div>
          </div>
          <div className="profile-head-actions">
            <button
              className="btn"
              onClick={() => {
                void navigator.clipboard.writeText(diagText()).then(
                  () => props.onToast("Activity log copied."),
                  () => props.onToast("Could not copy the log."),
                );
              }}
            >
              Copy
            </button>
            <button className="btn" onClick={() => setShowDiag((v) => !v)}>
              {showDiag ? "Hide" : "Show"}
            </button>
          </div>
        </div>
        {showDiag && (
          <pre className="diag-log">
            {diagLines.length > 0
              ? diagLines
                  .map(
                    (e) =>
                      `${new Date(e.at).toLocaleTimeString()} [${e.tag}] ${e.message}`,
                  )
                  .join("\n")
              : "Nothing logged yet in this session."}
          </pre>
        )}
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
