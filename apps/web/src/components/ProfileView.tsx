import { useEffect, useRef, useState } from "react";
import {
  disableHandoff,
  enableHandoff,
  handoffEnabled,
  handoffSupported,
  reconnectHandoff,
} from "../handoff";
import {
  backupAvailable,
  forgetBackupFailures,
  loadPolicy,
  requestBackupAccess,
  runBackup,
  savePolicy,
  type BackupPolicy,
  type BackupProgress,
  type BackupWindow,
} from "../backup";
import { resetBackupLedger } from "../backupledger";
import { assistantState, describeAssistantState, type AssistantState } from "../intel/assistant";
import { notificationsEnabled, setNotificationsEnabled } from "../notifications";
import { settingsEvents, SETTINGS_APPLIED_EVENT } from "../settingsync";
import { IntegrityError, downloadAndDecrypt } from "../transfer";
import {
  checkStoredFiles,
  describeStorageCheck,
  describeVerify,
  smallestFirst,
  verifyFiles,
  type FileVerdict,
  type VerifyProgress,
  type VerifyResult,
} from "../verify";
import { pendingDerivatives, useStore } from "../store";
import {
  autoBackfillEnabled,
  runBackfill,
  scheduleBackfill,
  setAutoBackfillEnabled,
  stopBackfill,
} from "../backfill";
import { CLIP_MODEL_VERSION } from "../intel/semantic";
import { ASSIST_VERSION } from "../intel/summarize";
import { SCENES_VERSION } from "../intel/scenes";
import { describeProcessing } from "../activity";
import { SweepMemory, type SweepKind } from "../sweepmemory";
import { publicKeyFingerprint } from "@engramer/crypto";
import { api } from "../api";
import { changePassword } from "../changepassword";
import { IDLE_LOCK_CHOICES, idleLockMinutes, setIdleLockMinutes } from "../idlelock";
import { revealRecoveryKey, rotateRecoveryKey } from "../recoverykey";
import { RecoveryKeyModal } from "./RecoveryKeyModal";
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
  nativeFilesProviderAvailable,
  nativeNotificationPermission,
  nativeUnlockAvailable,
  pickFolder,
  watchedAdd,
  watchedFolders,
  watchedRemove,
} from "../native";
import { isHandheld } from "../analysisslot";
import {
  folderName,
  setWatchMode,
  syncWatchedNow,
  watchMode,
  type WatchMode,
} from "../watchfolders";
import { diagEntries, diagText, onDiag } from "../diag";
import { AdminBody } from "./AdminPanel";
import {
  ClockGlyph,
  KeyGlyph,
  LockGlyph,
  MoonGlyph,
  ScanTextGlyph,
  SparkGlyph,
  SunGlyph,
} from "./Icon";

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
  factsOn: boolean;
  onToggleFacts: () => void;
  entitiesOn: boolean;
  onToggleEntities: () => void;
  assistantOn: boolean;
  onToggleAssistant: () => void;
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
  const [nameDraft, setNameDraft] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [shell] = useState(() => nativeShell());
  // null hides the row entirely (no shared keychain on this platform).
  const [handoffOn, setHandoffOn] = useState<boolean | null>(null);
  // Which system drive this shell registers, named the way its Finder
  // or Files app names it; null while unknown or unavailable.
  const [driveWord, setDriveWord] = useState<"files" | "finder" | null>(null);
  // Where this deployment hosts its Mac app; the row shows only in a
  // plain desktop browser, where getting the app is a sensible ask.
  const [macAppUrl, setMacAppUrl] = useState<string | null>(null);
  // Probed fresh on every open: a downloading model becomes ready without
  // any event, and the row must say what is true now.
  const [assistant, setAssistant] = useState<AssistantState | null>(null);
  const [notifyOn, setNotifyOn] = useState(() => notificationsEnabled());
  const [notifyPermission, setNotifyPermission] = useState<"granted" | "denied" | "prompt" | null>(null);
  useEffect(() => {
    let live = true;
    void nativeNotificationPermission().then((state) => {
      if (live) {
        setNotifyPermission(state);
      }
    });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    let live = true;
    void assistantState({ refresh: true }).then((state) => {
      if (live) {
        setAssistant(state);
      }
    });
    return () => {
      live = false;
    };
  }, []);
  const [reconnectNote, setReconnectNote] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [backupOk, setBackupOk] = useState(false);
  const [policy, setPolicy] = useState<BackupPolicy>(() => loadPolicy());
  const [backupRun, setBackupRun] = useState<BackupProgress | null>(null);
  const [changingPassword, setChangingPassword] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [delConfirm, setDelConfirm] = useState("");
  const [delPassword, setDelPassword] = useState("");
  const [delCode, setDelCode] = useState("");
  const [delBusy, setDelBusy] = useState(false);
  const [delError, setDelError] = useState<string | null>(null);
  const [pwCurrent, setPwCurrent] = useState("");
  const [pwNext, setPwNext] = useState("");
  const [pwConfirm, setPwConfirm] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);
  // Recovery-key view/rotate: a password check, then a one-time display.
  const [recoveryAction, setRecoveryAction] = useState<"view" | "rotate" | null>(null);
  const [rkPassword, setRkPassword] = useState("");
  const [rkBusy, setRkBusy] = useState(false);
  const [rkError, setRkError] = useState<string | null>(null);
  const [shownRecoveryKey, setShownRecoveryKey] = useState<{ key: string; rotated: boolean } | null>(
    null,
  );
  useEffect(() => {
    void handoffSupported().then((supported) => {
      if (supported) {
        setHandoffOn(handoffEnabled(store.session?.email ?? ""));
      }
    });
    void backupAvailable().then(setBackupOk);
    void nativeFilesProviderAvailable().then((ok) => {
      if (ok) {
        setDriveWord(isHandheld() ? "files" : "finder");
      }
    });
    if (!nativeShell() && !isHandheld()) {
      void api
        .registration()
        .then((info) => setMacAppUrl(info.macAppUrl ?? null))
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updatePolicy = (patch: Partial<BackupPolicy>) => {
    const next = { ...policy, ...patch };
    setPolicy(next);
    savePolicy(next);
    return next;
  };

  const backupAbort = useRef<{ aborted: boolean } | null>(null);
  // The reset question is asked in place: the iOS shell never renders
  // window.confirm.
  const [resetArmed, setResetArmed] = useState(false);

  // Settings applied from another device change the knobs this view holds
  // in state; re-read them so what is shown is what is true.
  useEffect(() => {
    const refresh = () => {
      setPolicy(loadPolicy());
      setAutoFill(autoBackfillEnabled());
    };
    settingsEvents.addEventListener(SETTINGS_APPLIED_EVENT, refresh);
    return () => settingsEvents.removeEventListener(SETTINGS_APPLIED_EVENT, refresh);
  }, []);

  const startBackup = async (next: BackupPolicy) => {
    const status = await requestBackupAccess();
    if (status !== "authorized") {
      props.onToast(
        status === "limited"
          ? "Full library access is needed for automatic backup. Grant it in Settings."
          : "Photo access was declined. You can grant it in Settings.",
      );
      updatePolicy({ enabled: false });
      return;
    }
    props.onToast("Backing up your photos…");
    // Asking by hand means "try everything": exports this device had
    // given up on get their budget back.
    forgetBackupFailures(store.session?.email ?? "");
    backupAbort.current = { aborted: false };
    const result = await runBackup(next, setBackupRun, backupAbort.current);
    backupAbort.current = null;
    setBackupRun(null);
    if (!result) {
      props.onToast("A backup pass is already running.");
      return;
    }
    props.onToast(
      result.failed > 0
        ? `Backed up ${result.done}; ${result.failed} could not be read.`
        : result.done > 0
          ? `Backed up ${result.done} ${result.done === 1 ? "item" : "items"}.`
          : "Everything is already backed up.",
    );
    // Backup ships photos with their heavy scanners deferred; catch up
    // now, while the app is open and the uploads are done.
    void runBackfill();
  };
  // The same shell crate runs on Macs and iPhones; the words should say
  // which device is talking. WKWebView reports iPhone/iPad in the agent.
  const [phoneShell] = useState(() => nativeShell() && /iPhone|iPad/i.test(navigator.userAgent));

  useEffect(() => {
    void api
      .user()
      .then((account) => setNameDraft(account.displayName ?? ""))
      .catch(() => {});
  }, []);
  const [watched, setWatched] = useState<string[]>([]);
  const [modes, setModes] = useState<Record<string, WatchMode>>({});
  const [verifying, setVerifying] = useState(false);
  const [verifyProgress, setVerifyProgress] = useState<VerifyProgress | null>(null);
  const [verifySummary, setVerifySummary] = useState<string | null>(null);
  const [verifyProblems, setVerifyProblems] = useState<VerifyResult["problems"]>([]);
  const verifyAbort = useRef<AbortController | null>(null);
  // Named on the button, because the cost is the thing worth knowing first.
  const totalToCheck = [...store.files.values()]
    .filter((file) => !file.trashed)
    .reduce((sum, file) => sum + file.size, 0);

  const runStorageCheck = async () => {
    const controller = new AbortController();
    verifyAbort.current = controller;
    setVerifying(true);
    setVerifySummary(null);
    setVerifyProblems([]);
    const files = smallestFirst(
      [...store.files.values()]
        .filter((file) => !file.trashed)
        .map((file) => ({ id: file.id, name: file.name, size: file.size, digest: file.digest })),
    );
    try {
      const result = await checkStoredFiles(files, {
        signal: controller.signal,
        onProgress: setVerifyProgress,
      });
      setVerifyProblems(
        result.problems.map((p) => ({ ...p, verdict: p.verdict as unknown as FileVerdict })),
      );
      setVerifySummary(describeStorageCheck(result, controller.signal.aborted));
    } catch {
      setVerifySummary("The check could not finish; try again on a steadier connection.");
    } finally {
      setVerifying(false);
      setVerifyProgress(null);
      verifyAbort.current = null;
    }
  };

  // What each derivative sweep still has to do, by the sweeps' own
  // predicates, so these numbers are exactly the remaining work. The
  // second count excludes kinds whose switch is off: that is what the
  // automatic sweeps will actually take up, and it is what the summary
  // line answers for.
  const pending = pendingDerivatives(store.files, CLIP_MODEL_VERSION, {
    scenesVersion: SCENES_VERSION,
    assistVersion: ASSIST_VERSION,
  });
  const autoPending = pendingDerivatives(store.files, CLIP_MODEL_VERSION, {
    ocr: props.ocrOn,
    semantic: props.semanticOn,
    scenesVersion: SCENES_VERSION,
  });
  // The pass in hand, as the bell shows it: one object, one truth.
  const processing = store.activity.job?.kind === "processing" ? store.activity.job : null;
  const [autoFill, setAutoFill] = useState(autoBackfillEnabled);
  /**
   * Asking for a pass by hand means "try again", including the files
   * this device gave up on: the persisted record is what keeps the
   * automatic passes quiet, and it must never trap a file forever.
   */
  const retryEverything = (kind: SweepKind) => {
    const email = store.session?.email;
    if (email) {
      new SweepMemory(email, kind).forgetAll();
    }
  };
  // One stop covers a hand-run pass and the automatic one alike: the
  // button that started the work is the button that ends it, and the
  // job's own Stop (the bell's) ends the file in hand too.
  const indexStop = useRef(false);
  const stopIndexing = () => {
    indexStop.current = true;
    stopBackfill();
    store.activity.job?.stop?.();
  };
  const indexStopProbe = () => indexStop.current;

  // Files with nothing to check against: stored before digests existed, or
  // renamed while a metadata patch still dropped the digest.
  const digestless = (() => {
    const files = [...store.files.values()].filter((f) => !f.trashed && !f.digest);
    return { count: files.length, bytes: files.reduce((sum, f) => sum + f.size, 0) };
  })();

  /**
   * Reads each digest-less file back and records a checksum for what it
   * holds now. Deliberately named recording rather than verifying: it gives
   * every later check something to compare against, and it cannot know what
   * these files held before today. That honesty is why it is a button and
   * not something that happens quietly.
   */
  const runBackfill = async () => {
    const controller = new AbortController();
    verifyAbort.current = controller;
    setVerifying(true);
    setVerifySummary(null);
    setVerifyProblems([]);
    const files = smallestFirst(
      [...store.files.values()]
        .filter((file) => !file.trashed && !file.digest)
        .map((file) => ({ id: file.id, name: file.name, size: file.size })),
    );
    let recorded = 0;
    let failed = 0;
    const bytesTotal = files.reduce((sum, file) => sum + file.size, 0);
    let bytesDone = 0;
    try {
      for (let i = 0; i < files.length; i++) {
        if (controller.signal.aborted) {
          break;
        }
        const file = files[i]!;
        setVerifyProgress({
          done: i,
          total: files.length,
          current: file.name,
          currentBytes: file.size,
          bytesDone,
          bytesTotal,
        });
        try {
          const entry = store.files.get(file.id)!;
          const bytes = await downloadAndDecrypt(entry.id, entry.key);
          await store.recordDigest(file.id, bytes);
          recorded++;
        } catch {
          failed++;
        }
        bytesDone += file.size;
      }
      setVerifySummary(
        `${controller.signal.aborted ? "Stopped. " : ""}Recorded checksums for ${recorded} file${
          recorded === 1 ? "" : "s"
        }${failed > 0 ? `; ${failed} could not be read` : ""}. Future checks can now verify them.`,
      );
    } finally {
      setVerifying(false);
      setVerifyProgress(null);
      verifyAbort.current = null;
    }
  };

  const runVerify = async () => {
    const controller = new AbortController();
    verifyAbort.current = controller;
    setVerifying(true);
    setVerifySummary(null);
    setVerifyProblems([]);
    const files = smallestFirst(
      [...store.files.values()]
        .filter((file) => !file.trashed)
        .map((file) => ({ id: file.id, name: file.name, size: file.size, digest: file.digest })),
    );
    try {
      const result = await verifyFiles(
        files,
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
            } else if (verdict === "ok") {
              store.markVerified(file.id);
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

  const submitRecoveryAction = async () => {
    if (!recoveryAction) {
      return;
    }
    setRkError(null);
    setRkBusy(true);
    try {
      const key =
        recoveryAction === "view"
          ? await revealRecoveryKey(rkPassword, { api })
          : await rotateRecoveryKey(rkPassword, { api });
      setShownRecoveryKey({ key, rotated: recoveryAction === "rotate" });
      setRecoveryAction(null);
      setRkPassword("");
    } catch {
      // A wrong password fails locally at the master-key open.
      setRkError("That password is not correct.");
    } finally {
      setRkBusy(false);
    }
  };

  const [idleMinutes, setIdleMinutes] = useState(() => idleLockMinutes());
  useEffect(() => {
    // Another device's choice arrives through the synced settings.
    const refresh = () => setIdleMinutes(idleLockMinutes());
    settingsEvents.addEventListener(SETTINGS_APPLIED_EVENT, refresh);
    return () => settingsEvents.removeEventListener(SETTINGS_APPLIED_EVENT, refresh);
  }, []);

  const [signingOutEverywhere, setSigningOutEverywhere] = useState(false);
  const signOutEverywhere = async () => {
    setSigningOutEverywhere(true);
    try {
      await store.signOutEverywhere();
      props.onToast("Every other device has been signed out. This one stays in.");
    } catch {
      props.onToast("Could not reach the server to sign other devices out. Try again.");
    } finally {
      setSigningOutEverywhere(false);
    }
  };

  const submitPasswordChange = async () => {
    if (pwNext.length < 10) {
      setPwError("Use at least 10 characters; this password protects your keys.");
      return;
    }
    if (pwNext !== pwConfirm) {
      setPwError("The new passwords do not match.");
      return;
    }
    setPwError(null);
    setPwBusy(true);
    try {
      // The renewed token goes everywhere a sign-in would put it, so this
      // tab's reload record and its unlock record survive the epoch bump.
      await changePassword(pwCurrent, pwNext, { api, setAuthToken: store.adoptToken });
      setChangingPassword(false);
      setPwCurrent("");
      setPwNext("");
      setPwConfirm("");
      props.onToast("Password changed. Your other devices have been signed out.");
    } catch (err) {
      // A wrong current password fails locally at the master-key open, or
      // the server rejects the digest; both surface here.
      setPwError(
        err instanceof Error && /password/i.test(err.message)
          ? "That current password is not correct."
          : "Could not change the password. Check your current password and try again.",
      );
    } finally {
      setPwBusy(false);
    }
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
          {shell && (
            <div className="profile-sub">
              Server: <b>{location.host}</b> · sign out to switch
            </div>
          )}
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
          <button
            className="btn"
            title="Every other device and browser is signed out now; this one stays in"
            disabled={signingOutEverywhere}
            onClick={() => void signOutEverywhere()}
          >
            {signingOutEverywhere ? <span className="spinner" /> : null}
            Sign out everywhere
          </button>
        </div>
      </section>

      <section className="profile-card">
        <h3>Your name</h3>
        <p className="profile-note">
          Shown to people you share a document with while you edit it together.
          Leave it empty and they see your email address instead. Only people
          invited to a document you are both in can see this.
        </p>
        <div className="profile-row">
          <input
            type="text"
            maxLength={64}
            placeholder="Your name"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
          />
          <button
            className="btn"
            disabled={savingName}
            onClick={() => {
              setSavingName(true);
              void api
                .setDisplayName(nameDraft.trim() || null)
                .then(() => props.onToast("Saved. This is what collaborators will see."))
                .catch(() => props.onToast("Could not save that name."))
                .finally(() => setSavingName(false));
            }}
          >
            Save
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
          {shell && (
            <div className="profile-row">
              <div className="profile-row-main">
                <b>
                  Offline files: {store.offline.filter((e) => e.pinned).length} · Cache:{" "}
                  {formatBytes(store.offline.filter((e) => !e.pinned).reduce((sum, e) => sum + e.bytes, 0))}
                </b>
                <div className="profile-row-sub">
                  Files kept offline stay until you remove them; the cache is what opens and
                  playback left behind, reclaimed on its own when space is needed.
                </div>
              </div>
              <button
                className="btn"
                onClick={() => {
                  void store.clearOfflineCache().then((freed) =>
                    props.onToast(
                      freed > 0 ? `Cleared ${formatBytes(freed)} of cached files.` : "The cache is already empty.",
                    ),
                  );
                }}
              >
                Clear cache
              </button>
            </div>
          )}
        </section>
      )}

      <section className="profile-card">
        <h3>Security</h3>
        <div className="profile-row">
          <div className="profile-row-main">
            <b>Password</b>
            <div className="profile-row-sub">
              Changing it re-wraps your keys on this device and signs your other devices out. Your
              files and recovery key stay the same.
            </div>
          </div>
          <button className="btn" onClick={() => setChangingPassword(true)}>
            <KeyGlyph size={13} /> Change
          </button>
        </div>
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
            <b>Delete account</b>
            <div className="profile-row-sub">
              Removes your account and every file in it from the server, for good. Download
              anything you want to keep first.
            </div>
          </div>
          <button className="btn danger" onClick={() => setDeletingAccount(true)}>
            Delete…
          </button>
        </div>
        <div className="profile-row">
          <div className="profile-row-main">
            <b>Device unlock</b>
            <div className="profile-row-sub">
              {unlockState === "on"
                ? phoneShell
                  ? "On for this device: Face ID opens the vault."
                  : "On for this device: Touch ID or a passkey opens the vault."
                : unlockState === "native"
                  ? phoneShell
                    ? "Skip typing the password: Face ID guards the vault through this device's keychain."
                    : "Skip typing the password: Touch ID guards the vault through the Mac's Keychain."
                  : unlockState === "available"
                    ? "Skip typing the password: unlock with Touch ID or a passkey."
                    : unlockState === "unsupported"
                      ? shell
                        ? "Not available on this device yet."
                        : "Not available in this browser. Safari, Chrome, and the apps support it."
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
            <b>Lock after inactivity</b>
            <div className="profile-row-sub">
              A quiet spell locks the vault the way the Lock button does; device unlock or the
              password reopens it. The choice follows your account to every device.
            </div>
          </div>
          <select
            aria-label="Lock after inactivity"
            value={idleMinutes}
            onChange={(e) => {
              const minutes = Number(e.target.value);
              setIdleLockMinutes(minutes);
              setIdleMinutes(minutes);
            }}
          >
            {IDLE_LOCK_CHOICES.map((choice) => (
              <option key={choice.minutes} value={choice.minutes}>
                {choice.label}
              </option>
            ))}
          </select>
        </div>
        {store.session && (
          <div className="profile-row">
            <div className="profile-row-main">
              <b>Your key fingerprint</b>
              <div className="profile-row-sub">
                When someone releases a document to you, this is shown beside your address. Read it
                to them over a call or in person: if it matches what they see, the key the server
                gave them is yours.
              </div>
              <div className="profile-row-sub mono">{publicKeyFingerprint(store.session.publicKey)}</div>
            </div>
          </div>
        )}
        <div className="profile-row">
          <div className="profile-row-main">
            <b>Recovery key</b>
            <div className="profile-row-sub">
              The way back into this account if the password is lost. Show it again after a password
              check, or rotate it: rotating invalidates the old key at once.
            </div>
          </div>
          <div className="profile-row-actions">
            <button
              className="btn"
              onClick={() => {
                setRkError(null);
                setRkPassword("");
                setRecoveryAction("view");
              }}
            >
              Show
            </button>
            <button
              className="btn"
              onClick={() => {
                setRkError(null);
                setRkPassword("");
                setRecoveryAction("rotate");
              }}
            >
              Rotate
            </button>
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

        <div className="profile-row">
          <div className="profile-row-main">
            <b>
              <ClockGlyph size={13} /> Read dates in documents
            </b>
            <div className="profile-row-sub">
              Finds expiry dates, amounts due and reference numbers in what you store, and tells
              you before they matter. Everything is read on this device, nothing is acted on until
              you confirm it, and reference numbers are kept as their last four digits.
            </div>
          </div>
          <button
            className="profile-switch"
            role="switch"
            aria-checked={props.factsOn}
            onClick={props.onToggleFacts}
          >
            <span className={`switch${props.factsOn ? " on" : ""}`} />
          </button>
        </div>
        <div className="profile-row">
          <div className="profile-row-main">
            <b>
              <SparkGlyph size={13} /> Find connections
            </b>
            <div className="profile-row-sub">
              Lets a small on-device model find the names and places your documents mention, so
              files that share no printed reference can still be offered together, a booking and
              its hotel as one trip. Runs only when you ask, downloads about 180MB from this
              server the first time, and nothing it finds is stored or sent anywhere.
            </div>
          </div>
          <button
            className="profile-switch"
            role="switch"
            aria-checked={props.entitiesOn}
            onClick={props.onToggleEntities}
          >
            <span className={`switch${props.entitiesOn ? " on" : ""}`} />
          </button>
        </div>
        <div className="profile-row">
          <div className="profile-row-main">
            <b>
              <SparkGlyph size={13} /> On-device assistant
            </b>
            <div className="profile-row-sub">
              Reads a search written in plain words, such as receipts from last december, and
              turns it into the filters search already understands; the words as typed stay one
              click away. Uses Apple's model on this device, in the Mac and iPhone apps on macOS
              26 and iOS 26; nothing leaves the device.
            </div>
          </div>
          <button
            className="profile-switch"
            role="switch"
            aria-checked={props.assistantOn}
            onClick={props.onToggleAssistant}
          >
            <span className={`switch${props.assistantOn ? " on" : ""}`} />
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
        {shell && (
          <div className="profile-row">
            <div className="profile-row-main">
              <b>Server</b>
              <div className="profile-row-sub">
                This app is connected to <b>{location.host}</b>. To use a different server, sign
                out and choose Change under the sign-in form.
              </div>
            </div>
          </div>
        )}
        <div className="profile-row">
          <div className="profile-row-main">
            <b>
              <SparkGlyph size={13} /> On-device assistant
            </b>
            <div className="profile-row-sub">
              {assistant ? describeAssistantState(assistant) : "Checking…"}
            </div>
          </div>
        </div>
        <div className="profile-row">
          <div className="profile-row-main">
            <b>Notifications</b>
            <div className="profile-row-sub">
              A date approaching or past reaches you here even when the app is not in front,
              once per document; the bell in the toolbar holds everything that needs attention.
              {notifyPermission === "granted"
                ? " This device allows them."
                : notifyPermission === "denied"
                  ? " This device has them turned off in its system settings."
                  : notifyPermission === "prompt"
                    ? " This device will be asked the first time there is something to say."
                    : ""}
            </div>
          </div>
          <button
            className="profile-switch"
            role="switch"
            aria-checked={notifyOn}
            onClick={() => {
              const next = !notifyOn;
              setNotificationsEnabled(next);
              setNotifyOn(next);
            }}
          >
            <span className={`switch${notifyOn ? " on" : ""}`} />
          </button>
        </div>
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
        {macAppUrl !== null && (
          <div className="profile-row">
            <div className="profile-row-main">
              <b>Get the Mac app</b>
              <div className="profile-row-sub">
                Your vault as a drive in Finder's sidebar: files fetched as you open them,
                shared straight from a right-click, everything encrypted on your devices as
                always. A notarized app; download, drag to Applications, done.
              </div>
            </div>
            <a className="btn" href={macAppUrl}>
              Download
            </a>
          </div>
        )}
        {handoffOn !== null && (
          <div className="profile-row">
            <div className="profile-row-main">
              <b>Extensions on this device</b>
              <div className="profile-row-sub">
                {driveWord === "finder"
                  ? "Shows your vault as a drive in Finder's sidebar, with files fetched as " +
                    "you open them. "
                  : "Turns on sharing into the vault from any app, and shows your vault in " +
                    "the Files app as a drive. "}
                Your vault key is stored behind the device passcode, on this device only, never
                in iCloud. It stays through a lock; signing out removes it.
              </div>
            </div>
            <button
              className="btn"
              onClick={() => {
                const session = store.session;
                if (!session) {
                  return;
                }
                if (handoffOn) {
                  void disableHandoff(session.email).then(() => {
                    setHandoffOn(false);
                    props.onToast("Extensions are off. The stored key was removed.");
                  });
                } else {
                  void enableHandoff(session)
                    .then(() => {
                      setHandoffOn(true);
                      props.onToast("Extensions can use this vault now.");
                    })
                    .catch(() => props.onToast("The Keychain refused to store the record."));
                }
              }}
            >
              {handoffOn ? "Turn off" : "Turn on"}
            </button>
          </div>
        )}
        {handoffOn === true && (
          <div className="profile-row">
            <div className="profile-row-main">
              <b>Extension connection</b>
              <div className="profile-row-sub">
                {reconnectNote ??
                  (driveWord === "finder"
                    ? "Rewrites the stored key and checks it reads back the way the Finder " +
                      "drive asks for it."
                    : "Rewrites the stored key and checks it reads back the way the Share " +
                      "sheet and the Files app ask for it.")}
              </div>
            </div>
            <button
              className="btn"
              disabled={reconnecting}
              onClick={() => {
                const session = store.session;
                if (!session) {
                  return;
                }
                setReconnecting(true);
                setReconnectNote(null);
                void reconnectHandoff(session)
                  .then((probe) => {
                    if (probe.state === "found") {
                      setReconnectNote(
                        "Connected. If the Files app still asks you to connect, pull down to refresh there.",
                      );
                    } else if (probe.state === "missing") {
                      setReconnectNote(
                        "The key was stored but did not read back. Turn Extensions off and on, then reconnect.",
                      );
                    } else {
                      setReconnectNote(`The Keychain refused the lookup (${probe.detail}).`);
                    }
                  })
                  .catch(() => setReconnectNote("The Keychain refused to store the record."))
                  .finally(() => setReconnecting(false));
              }}
            >
              {reconnecting ? "Checking…" : "Reconnect"}
            </button>
          </div>
        )}
        {store.liveFeed !== "off" && (
          <div className="profile-row">
            <div className="profile-row-main">
              <b>Live updates</b>
              <div className="profile-row-sub">
                {store.liveFeed === "live"
                  ? "Connected. Changes from your other devices reach the drive within " +
                    "seconds, even while this window is closed. Turning Extensions off " +
                    "ends it."
                  : store.liveFeed === "connecting"
                    ? "Reaching the server's change feed. Until it connects, the drive " +
                      "refreshes on the regular sync cycle."
                    : "This server does not offer the change feed, so the drive refreshes " +
                      "on the regular sync cycle instead."}
              </div>
            </div>
          </div>
        )}
        {backupOk && (
          <div className="profile-row profile-row-stack">
            <div className="profile-row-main">
              <b>Automatic photo backup</b>
              <div className="profile-row-sub">
                Backs up your photos and videos to the vault, each one encrypted on this device
                before it leaves. Turning this on asks for access to your whole photo library.
                Backup runs while the app is open; iOS decides when it may also run in the
                background, so keep the app open now and then to catch up.
              </div>
              {policy.enabled && (
                <div className="backup-knobs">
                  <label>
                    Back up
                    <select
                      value={policy.window}
                      onChange={(e) => {
                        const window = e.target.value as BackupWindow;
                        updatePolicy(
                          window === "today"
                            ? { window, windowAnchorMs: new Date().setHours(0, 0, 0, 0) }
                            : { window },
                        );
                      }}
                    >
                      <option value="all">All photos</option>
                      <option value="today">From today on</option>
                      <option value="30d">Last 30 days</option>
                      <option value="90d">Last 90 days</option>
                    </select>
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={policy.wifiOnly}
                      onChange={(e) => updatePolicy({ wifiOnly: e.target.checked })}
                    />
                    Wi-Fi only
                  </label>
                  {policy.wifiOnly && store.backupHold === "wifi" && (
                    <div className="profile-row-sub">Waiting for Wi-Fi to back up.</div>
                  )}
                  {store.backupHold === "shell-videos" && (
                    <div className="profile-row-sub">
                      Videos wait for an updated app to back up safely; photos continue.
                    </div>
                  )}
                  <label>
                    <input
                      type="checkbox"
                      checked={policy.includeVideos}
                      onChange={(e) => updatePolicy({ includeVideos: e.target.checked })}
                    />
                    Include videos
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={policy.includeScreenshots}
                      onChange={(e) => updatePolicy({ includeScreenshots: e.target.checked })}
                    />
                    Include screenshots
                  </label>
                  {resetArmed ? (
                    <div className="profile-row-sub">
                      Backup remembers every photo it ever uploaded, even ones you later deleted.
                      Clearing that history makes photos you deleted forever upload again on the
                      next pass; anything in the Trash can simply be restored instead.
                      <div className="profile-head-actions">
                        <button
                          className="btn"
                          onClick={() => {
                            resetBackupLedger(store.session?.email ?? "");
                            forgetBackupFailures(store.session?.email ?? "");
                            setResetArmed(false);
                            props.onToast("Backup history cleared.");
                          }}
                        >
                          Clear history
                        </button>
                        <button className="btn btn-ghost" onClick={() => setResetArmed(false)}>
                          Keep it
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button className="btn btn-ghost" onClick={() => setResetArmed(true)}>
                      Reset backup history
                    </button>
                  )}
                </div>
              )}
              {backupRun && (
                <div className="profile-row-sub">
                  Backing up {backupRun.done} of {backupRun.total}
                  {backupRun.failed > 0 ? ` (${backupRun.failed} failed)` : ""}
                  {backupRun.skipped > 0 ? ` (${backupRun.skipped} set aside)` : ""}…
                </div>
              )}
            </div>
            <div className="profile-head-actions">
              {policy.enabled ? (
                <>
                  <button
                    className="btn"
                    onClick={() => {
                      if (backupRun) {
                        if (backupAbort.current) {
                          backupAbort.current.aborted = true;
                        }
                        return;
                      }
                      void startBackup(policy);
                    }}
                  >
                    {backupRun ? "Stop" : "Back up now"}
                  </button>
                  <button className="btn btn-ghost" onClick={() => updatePolicy({ enabled: false })}>
                    Turn off
                  </button>
                </>
              ) : (
                <button
                  className="btn btn-primary"
                  onClick={() => void startBackup(updatePolicy({ enabled: true }))}
                >
                  Turn on
                </button>
              )}
            </div>
          </div>
        )}
      </section>

      <section className="profile-card">
        <h3>Integrity</h3>
        <div className="profile-row">
          <div className="profile-row-main">
            <b>Check stored files</b>
            <div className="profile-row-sub">
              Asks the server whether what it holds is still what it was given. Nothing is
              downloaded, so a vault of any size is checked in seconds. This catches what
              happens to data at rest: a truncated write, a replaced object, bit rot.
            </div>
            {verifying && (
              <div className="profile-row-sub">
                {verifyProgress ? (
                  <>
                    Checked {verifyProgress.done} of {verifyProgress.total},{" "}
                    {formatBytes(verifyProgress.bytesDone)} of {formatBytes(verifyProgress.bytesTotal)}
                    <br />
                    Reading {verifyProgress.current} ({formatBytes(verifyProgress.currentBytes)})
                    {verifyProgress.currentBytes > 50 * 1024 * 1024 &&
                      ", which takes a while to fetch"}
                  </>
                ) : (
                  "Starting…"
                )}
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
              void runStorageCheck();
            }}
          >
            {verifying ? "Stop" : "Check stored files"}
          </button>
        </div>
        <div className="profile-row">
          <div className="profile-row-main">
            <b>Deep check</b>
            <div className="profile-row-sub">
              Reads every file back and compares it against the digest taken on your device
              before it was encrypted. It proves the contents, not just the storage, and it
              is the only thing that can. It downloads everything: {formatBytes(totalToCheck)}
              , so it is worth doing on a connection you do not pay by the megabyte.
            </div>
          </div>
          <button
            className="btn"
            disabled={verifying}
            onClick={() => void runVerify()}
          >
            Deep check
          </button>
        </div>
        {digestless.count > 0 && (
          <div className="profile-row">
            <div className="profile-row-main">
              <b>Record missing checksums</b>
              <div className="profile-row-sub">
                {digestless.count} file{digestless.count === 1 ? "" : "s"} carry no checksum:
                stored before checksums existed, or renamed while an old bug dropped them.
                This reads each one back ({formatBytes(digestless.bytes)}) and records a
                checksum for what it holds today, so every later check has something to
                compare against. It is a baseline, not a verification: it cannot know what
                these files held before now.
              </div>
            </div>
            <button
              className="btn"
              disabled={verifying}
              onClick={() => void runBackfill()}
            >
              Record
            </button>
          </div>
        )}
      </section>

      <section className="profile-card">
        <h3>Library index</h3>
        <div className="profile-row">
          <div className="profile-row-main">
            <div className="profile-row-sub">
              Thumbnails, search text, and meaning vectors are made on your devices, never on
              the server. Anything a device could not produce at upload fills in automatically
              while a vault is open somewhere; these numbers are what is left right now.
              {autoPending.thumbs === 0 &&
                autoPending.text === 0 &&
                autoPending.meaning === 0 &&
                autoPending.tags === 0 &&
                autoPending.scenes === 0 && (
                <>
                  {" "}
                  <b>
                    {pending.text > 0 || pending.meaning > 0
                      ? "Everything set to index is done."
                      : "Everything is indexed."}
                  </b>
                </>
              )}
            </div>
          </div>
        </div>
        <div className="profile-row">
          <div className="profile-row-main">
            <b>Fill in automatically</b>
            <div className="profile-row-sub">
              Filling in downloads a file's contents to this device to work on them. Turn
              this off on a connection you pay by the megabyte; the buttons below always
              work by hand.
            </div>
          </div>
          <button
            className="btn"
            onClick={() => {
              const next = !autoFill;
              setAutoBackfillEnabled(next);
              setAutoFill(next);
              if (next) {
                // Turning it on means "go": the next pass starts after
                // the device's usual delay, not at some later sync.
                scheduleBackfill();
              }
              props.onToast(
                next
                  ? "Missing items will fill in automatically while the app is open."
                  : "Automatic filling is off on this device. Nothing downloads without you.",
              );
            }}
          >
            {autoFill ? "Turn off" : "Turn on"}
          </button>
        </div>
        <div className="profile-row">
          <div className="profile-row-main">
            <b>Fill in now</b>
            <div className="profile-row-sub">
              One pass over every file below: its contents come down once and every missing
              piece is made from that one read.
            </div>
            {processing && (
              <div className="profile-row-sub">
                {processing.title}
                {processing.current ? ` · ${processing.current}` : ""} · {processing.done} of{" "}
                {processing.total}
              </div>
            )}
          </div>
          <button
            className="btn"
            disabled={
              !processing &&
              autoPending.thumbs === 0 &&
              autoPending.text === 0 &&
              autoPending.meaning === 0 &&
              autoPending.tags === 0 &&
              autoPending.scenes === 0
            }
            onClick={() => {
              if (processing) {
                stopIndexing();
                return;
              }
              indexStop.current = false;
              retryEverything("process");
              void store.processLibrary({ stop: indexStopProbe }).then((counts) => {
                const said = describeProcessing(counts);
                props.onToast(said.detail ? `${said.title} · ${said.detail}` : said.title);
              });
            }}
          >
            {processing ? "Stop" : "Fill in now"}
          </button>
        </div>
        <div className="profile-row">
          <div className="profile-row-main">
            <b>Previews</b>
            <div className="profile-row-sub">
              {pending.thumbs === 0
                ? "Every image and video has a thumbnail."
                : `${pending.thumbs} media file${pending.thumbs === 1 ? "" : "s"} without a thumbnail, usually added from outside this app.`}
            </div>
          </div>
        </div>
        <div className="profile-row">
          <div className="profile-row-main">
            <b>Category and tags</b>
            <div className="profile-row-sub">
              {pending.tags === 0
                ? "Every file has a category and its basic tags."
                : `${pending.tags} file${pending.tags === 1 ? "" : "s"} stored without a category or tags, usually added from the Files app.`}
            </div>
          </div>
        </div>
        <div className="profile-row">
          <div className="profile-row-main">
            <b>Summaries</b>
            <div className="profile-row-sub">
              {!props.assistantOn
                ? pending.summaries === 0
                  ? "The on-device assistant is off (the switch under Preferences)."
                  : `The on-device assistant is off (the switch under Preferences), so ${pending.summaries} document${pending.summaries === 1 ? "" : "s"} will not be summarized.`
                : pending.summaries === 0
                  ? "Every document has been summarized, or judged too short to need it."
                  : assistant?.state === "available"
                    ? `${pending.summaries} document${pending.summaries === 1 ? "" : "s"} not yet summarized, on this device.`
                    : `${pending.summaries} document${pending.summaries === 1 ? "" : "s"} wait for a device that can summarize (a Mac or iPhone on macOS 26 or iOS 26).`}
            </div>
          </div>
        </div>
        <div className="profile-row">
          <div className="profile-row-main">
            <b>Search text</b>
            <div className="profile-row-sub">
              {!props.ocrOn
                ? pending.text === 0
                  ? "Reading is off on this device."
                  : `Reading is off on this device (the switch above), so ${pending.text} image${pending.text === 1 ? "" : "s"} will only be read by hand.`
                : pending.text === 0
                  ? "Every image and scan has been read, or judged to hold no text."
                  : `${pending.text} image${pending.text === 1 ? "" : "s"} and scan${pending.text === 1 ? "" : "s"} not yet read for search, on-device.`}
            </div>
          </div>
        </div>
        <div className="profile-row">
          <div className="profile-row-main">
            <b>Meaning and scene labels</b>
            <div className="profile-row-sub">
              {!props.semanticOn
                ? pending.meaning + pending.scenes === 0
                  ? "Meaning search is off on this device."
                  : `Meaning search is off on this device (the switch above), so ${pending.meaning + pending.scenes} file${pending.meaning + pending.scenes === 1 ? "" : "s"} will only be indexed by hand.`
                : pending.meaning + pending.scenes === 0
                  ? "Every photo and video is searchable by meaning and labeled by what is in it."
                  : `${pending.meaning} file${pending.meaning === 1 ? "" : "s"} not yet searchable by meaning${pending.scenes > 0 ? `, ${pending.scenes} not yet labeled` : ""}.`}
            </div>
          </div>
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

      {deletingAccount && (
        <div
          className="overlay"
          onClick={() => {
            if (!delBusy) {
              setDeletingAccount(false);
            }
          }}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Delete your account</h2>
            <p className="modal-sub">
              Every file, folder, share and setting on the server goes, along with the account
              itself. Nothing can be recovered afterwards, not with the recovery key either. Your
              other devices are signed out. Files you shared with others disappear for them too.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (delConfirm.trim().toLowerCase() !== (store.session?.email ?? "").toLowerCase()) {
                  setDelError("Type your email address exactly to confirm.");
                  return;
                }
                setDelBusy(true);
                setDelError(null);
                void store
                  .deleteAccount(delPassword, delCode.trim() || undefined)
                  .then(() => props.onToast("Your account has been deleted."))
                  .catch((err: unknown) => {
                    const message = err instanceof Error ? err.message : "Could not delete the account.";
                    setDelError(/two-factor/i.test(message) ? "Enter the current two-factor code." : message);
                  })
                  .finally(() => setDelBusy(false));
              }}
            >
              <label className="field">
                <span>Type your email address to confirm</span>
                <input
                  value={delConfirm}
                  onChange={(e) => setDelConfirm(e.target.value)}
                  placeholder={store.session?.email ?? ""}
                  autoComplete="off"
                  autoFocus
                />
              </label>
              <label className="field">
                <span>Your password</span>
                <input
                  type="password"
                  value={delPassword}
                  onChange={(e) => setDelPassword(e.target.value)}
                  autoComplete="current-password"
                />
              </label>
              <label className="field">
                <span>Two-factor code, if you have it on</span>
                <input
                  value={delCode}
                  onChange={(e) => setDelCode(e.target.value)}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                />
              </label>
              {delError && <div className="error-text">{delError}</div>}
              <div className="modal-actions">
                <button type="button" className="btn" onClick={() => setDeletingAccount(false)} disabled={delBusy}>
                  Keep my account
                </button>
                <button
                  type="submit"
                  className="btn danger"
                  disabled={delBusy || !delPassword || !delConfirm}
                >
                  {delBusy ? "Deleting…" : "Delete everything"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {changingPassword && (
        <div
          className="overlay"
          onClick={() => {
            if (!pwBusy) {
              setChangingPassword(false);
            }
          }}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Change password</h2>
            <p className="modal-sub">
              Your other signed-in devices will be signed out. Your files and recovery key are not
              affected.
            </p>
            <form
              className="auth-form"
              onSubmit={(e) => {
                e.preventDefault();
                void submitPasswordChange();
              }}
            >
              <label htmlFor="pw-current">Current password</label>
              <input
                id="pw-current"
                type="password"
                autoComplete="current-password"
                value={pwCurrent}
                onChange={(e) => setPwCurrent(e.target.value)}
              />
              <label htmlFor="pw-next">New password</label>
              <input
                id="pw-next"
                type="password"
                autoComplete="new-password"
                value={pwNext}
                onChange={(e) => setPwNext(e.target.value)}
              />
              <label htmlFor="pw-confirm">Confirm new password</label>
              <input
                id="pw-confirm"
                type="password"
                autoComplete="new-password"
                value={pwConfirm}
                onChange={(e) => setPwConfirm(e.target.value)}
              />
              {pwError && <div className="error-text">{pwError}</div>}
              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={pwBusy}
                  onClick={() => setChangingPassword(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={pwBusy || !pwCurrent || !pwNext}
                >
                  {pwBusy ? <span className="spinner" /> : null}
                  {pwBusy ? "Changing" : "Change password"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {recoveryAction && (
        <div
          className="overlay"
          onClick={() => {
            if (!rkBusy) {
              setRecoveryAction(null);
            }
          }}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{recoveryAction === "view" ? "Show your recovery key" : "Rotate your recovery key"}</h2>
            <p className="modal-sub">
              {recoveryAction === "view"
                ? "Enter your password to see your recovery key again."
                : "Enter your password to generate a new recovery key. The old one stops working immediately."}
            </p>
            <form
              className="auth-form"
              onSubmit={(e) => {
                e.preventDefault();
                void submitRecoveryAction();
              }}
            >
              <label htmlFor="rk-password">Password</label>
              <input
                id="rk-password"
                type="password"
                autoComplete="current-password"
                autoFocus
                value={rkPassword}
                onChange={(e) => setRkPassword(e.target.value)}
              />
              {rkError && <div className="error-text">{rkError}</div>}
              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={rkBusy}
                  onClick={() => setRecoveryAction(null)}
                >
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={rkBusy || !rkPassword}>
                  {rkBusy ? <span className="spinner" /> : null}
                  {rkBusy
                    ? recoveryAction === "view"
                      ? "Checking"
                      : "Rotating"
                    : recoveryAction === "view"
                      ? "Show recovery key"
                      : "Rotate recovery key"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {shownRecoveryKey && (
        <RecoveryKeyModal
          recoveryKeyHex={shownRecoveryKey.key}
          title={shownRecoveryKey.rotated ? "Your new recovery key" : "Your recovery key"}
          sub={
            shownRecoveryKey.rotated
              ? "Store this somewhere safe and offline. Your previous recovery key no longer works."
              : "Store this somewhere safe and offline. This is the only way back into your vault if you forget your password."
          }
          confirmLabel="I saved it"
          onClose={() => setShownRecoveryKey(null)}
        />
      )}
    </div>
  );
}
