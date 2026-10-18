/**
 * Local mode: the vault lives on this device, served by the app's own
 * backend on a loopback origin. The backend says so before any account
 * exists (`registration.local`, with whether the vault has its account
 * yet) and on the user record (`user.local`, with each feature pack's
 * state and the vault's size). This module holds what the client says and
 * does about that: the one account behind the device label, the sentences,
 * and the download of a feature pack followed in Activity.
 */

import {
  api,
  ApiError,
  type ConnectRequest,
  type ConnectStatus,
  type LocalCapability,
  type PackName,
  type PackStatus,
} from "./api";
import type { KeyAttributes } from "@engramer/crypto";
import { deletionProof } from "./accountdeletion";
import { isHandheld } from "./analysisslot";
import { formatBytes } from "./format";

/** One account per vault, never shown: the backend keeps the server's
 * account rules, and the person sees the device label instead. */
export const LOCAL_ACCOUNT = "vault@this.device";

/** The sentence every server-only control carries in local mode. */
export const NEEDS_SERVER = "needs a server";

/** The label a new vault starts with; editable as the account's name. */
export function defaultDeviceLabel(): string {
  if (typeof navigator !== "undefined" && /iPad/i.test(navigator.userAgent)) {
    return "This iPad";
  }
  return isHandheld() ? "This iPhone" : "This Mac";
}

export const PACK_TITLES: Record<PackName, string> = {
  office: "the office editor",
  intelligence: "on-device intelligence",
};

/** The pack as a row heading. */
export function packDisplayName(name: PackName): string {
  return name === "office" ? "Office editor" : "On-device intelligence";
}

/** The question a pack's entry point asks; the size is the manifest's. */
export function packPromptTitle(name: PackName, archiveBytes: number): string {
  return `Download ${PACK_TITLES[name]} (${formatBytes(archiveBytes)})?`;
}

const PRIVACY =
  "One download from the release host, then it works offline. Nothing about your vault leaves this device.";

export function packPromptBody(name: PackName): string {
  return name === "office"
    ? `Documents open in an editor that is not part of the app. ${PRIVACY}`
    : `Search by meaning, text in images, scene labels and Ask run on models that are not part of the app. ${PRIVACY}`;
}

/**
 * What an entry point does for the pack it needs: run (no vault on this
 * device, a pack the manifest does not name, or an installed pack), wait
 * (a download is already running) or ask (the pack is missing).
 */
export function packGate(local: LocalCapability | null, name: PackName): "run" | "wait" | "ask" {
  const state = local?.packs[name];
  if (!local || state === undefined || state === "installed") {
    return "run";
  }
  return state === "downloading" ? "wait" : "ask";
}

export function packReadySentence(name: PackName): string {
  return name === "office" ? "The office editor is ready." : "On-device intelligence is ready.";
}

/** What Activity shows while a pack downloads. */
export interface PackJob {
  kind: "downloading";
  title: string;
  done: number;
  total: number;
  failed: number;
  current?: string;
}

export interface PackJobHooks {
  begin(job: PackJob): void;
  update(patch: Partial<PackJob>): void;
  end(entry: { kind: "downloading"; title: string; detail?: string }): void;
}

const MB = 1024 * 1024;

function megabytes(bytes: number): number {
  return Math.round(bytes / MB);
}

function progressLine(status: PackStatus): string {
  return `${formatBytes(status.downloadedBytes)} of ${formatBytes(status.archiveBytes)}`;
}

type FollowOptions = { pollMs?: number; sleep?: (ms: number) => Promise<void> };

/** The downloads this page is following right now: a second entry point
 * joins the first instead of starting another job for the same pack. */
const inFlight = new Map<PackName, Promise<void>>();

export function packDownloading(name: PackName): boolean {
  return inFlight.has(name);
}

/**
 * Starts (or resumes) a pack's download and follows it in Activity until
 * the backend reports it installed. Resolves then; rejects with the
 * backend's own sentence when the attempt did not install the pack, so
 * the entry point can say why. A download already being followed is
 * returned as is; the later caller's hooks are not used.
 */
export function downloadPack(name: PackName, hooks: PackJobHooks, options: FollowOptions = {}): Promise<void> {
  const running = inFlight.get(name);
  if (running) {
    return running;
  }
  const run = followPack(name, hooks, options).finally(() => inFlight.delete(name));
  inFlight.set(name, run);
  return run;
}

async function followPack(name: PackName, hooks: PackJobHooks, options: FollowOptions): Promise<void> {
  const pollMs = options.pollMs ?? 1000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let status: PackStatus | undefined = (await api.localPackStart(name)).packs[name];
  if (!status) {
    throw new Error("unknown pack");
  }
  if (status.state === "installed") {
    return;
  }
  const title = `Downloading ${PACK_TITLES[name]}`;
  hooks.begin({
    kind: "downloading",
    title,
    done: megabytes(status.downloadedBytes),
    total: megabytes(status.archiveBytes),
    failed: 0,
    current: progressLine(status),
  });
  try {
    // A stalled transfer ends on the backend's own read timeout, which
    // reports it as a failed attempt, so this loop always sees an end.
    while (status.state === "downloading") {
      await sleep(pollMs);
      status = (await api.localPacks()).packs[name] ?? status;
      hooks.update({
        done: megabytes(status.downloadedBytes),
        total: megabytes(status.archiveBytes),
        current: progressLine(status),
      });
    }
  } catch (err) {
    // The backend carries on by itself; only this page lost sight of it.
    const reason = err instanceof Error ? err.message : String(err);
    hooks.end({
      kind: "downloading",
      title,
      detail: `Lost track of the download: ${reason}. The Profile row shows where it stands.`,
    });
    throw err;
  }
  if (status.state === "installed") {
    hooks.end({
      kind: "downloading",
      title,
      detail: `${packReadySentence(name)} ${formatBytes(status.installedBytes)} on this device.`,
    });
    return;
  }
  const reason = status.error ?? "the download did not finish";
  hooks.end({ kind: "downloading", title, detail: `Not installed: ${reason}.` });
  throw new Error(reason);
}

// ----- connecting the vault to a server -----

/**
 * The login key a sign-in at the server would send, derived from the
 * vault's passphrase with the vault's own key attributes. A wrong
 * passphrase is refused here, before anything leaves this device.
 */
export function loginKeyFor(passphrase: string, keyAttributes: KeyAttributes): string {
  try {
    return deletionProof(passphrase, keyAttributes);
  } catch {
    throw new Error("That is not your passphrase.");
  }
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** One line for the Profile card and the bell, from where the copy stands. */
export function connectSentence(status: ConnectStatus): string {
  const host = status.host ?? "the server";
  switch (status.step) {
    case null:
      return "";
    case "reaching":
      return `Reaching ${host}…`;
    case "account":
      return `Signing in at ${host}…`;
    case "folders":
      return `Folders: ${status.foldersDone} of ${status.foldersTotal}.`;
    case "files":
      return `Files: ${status.filesDone} of ${status.filesTotal} · ${formatBytes(status.bytesDone)} of ${formatBytes(status.bytesTotal)}.`;
    case "settings":
      return "Settings and the account's name…";
    case "verifying":
      return `${host} is reading its copy back…`;
    case "done": {
      if (status.stale) {
        return `The vault changed since the copy on ${host} was checked. Connect again to copy the changes.`;
      }
      const v = status.verified;
      return v
        ? `Verified: ${count(v.folders, "folder")}, ${count(v.files, "file")}, ${formatBytes(v.bytes)} on ${host}; the server read every file back.`
        : `Done on ${host}.`;
    }
    case "failed":
      return status.error === "stopped"
        ? "Stopped. Connect again to continue where it left off."
        : `Not connected: ${status.error ?? "the copy did not finish"}.`;
  }
}

/** What Activity shows while the vault is copied. */
export interface ConnectJob {
  kind: "connecting";
  title: string;
  done: number;
  total: number;
  failed: number;
  current?: string;
}

export interface ConnectJobHooks {
  begin(job: ConnectJob): void;
  update(patch: Partial<ConnectJob>): void;
  end(entry: { kind: "connecting"; title: string; detail?: string }): void;
  /** Every answer from the backend, so a row can show the live step. */
  status?(status: ConnectStatus): void;
}

/**
 * Starts (or resumes) the copy of this vault to a server and follows it
 * in Activity until the backend reports it verified. Resolves with the
 * final status; rejects with the backend's own sentence when the copy
 * did not verify, so the card can say why. A copy already running is
 * followed instead of started twice.
 */
export async function followConnect(
  request: ConnectRequest,
  hooks: ConnectJobHooks,
  options: FollowOptions = {},
): Promise<ConnectStatus> {
  const pollMs = options.pollMs ?? 1000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let status: ConnectStatus;
  try {
    status = await api.localConnectStart(request);
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      // A copy is already running: follow it only if it is the one asked
      // for, never a copy to some other server.
      status = await api.localConnect();
      const asked = request.server
        .trim()
        .replace(/^[a-z]+:\/\//i, "")
        .replace(/\/+$/, "");
      if (status.host && asked !== status.host && request.server.trim() !== status.server) {
        throw new Error(`a copy to ${status.host} is already running; stop it first`);
      }
    } else {
      throw err;
    }
  }
  const title = `Connecting to ${status.host ?? request.server}`;
  hooks.status?.(status);
  hooks.begin({
    kind: "connecting",
    title,
    done: status.filesDone,
    total: status.filesTotal,
    failed: 0,
    current: connectSentence(status),
  });
  try {
    while (status.running) {
      await sleep(pollMs);
      status = await api.localConnect();
      hooks.status?.(status);
      hooks.update({ done: status.filesDone, total: status.filesTotal, current: connectSentence(status) });
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    hooks.end({
      kind: "connecting",
      title,
      detail: `Lost track of the copy: ${reason}. Profile shows where it stands.`,
    });
    throw err;
  }
  hooks.end({ kind: "connecting", title, detail: connectSentence(status) });
  if (status.step !== "done") {
    throw new Error(status.error ?? "the copy did not finish");
  }
  return status;
}
