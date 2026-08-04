import { digestMatches } from "@engramer/crypto";
import { api } from "./api";
import { diag } from "./diag";

/**
 * Checking a whole vault, on request.
 *
 * A digest is only checked when a file is read, so corruption in something
 * nobody has opened lately goes unnoticed. This walks everything and reads
 * it, which is the only way to know: there is no server-side answer to ask
 * for, because the server cannot see any of this.
 *
 * It downloads every file, so it is deliberate rather than automatic, and it
 * can be stopped. Files stored before digests existed are reported as
 * unchecked rather than counted as passing: they decrypt, which proves the
 * server returned what it was given, but nothing recorded what the file held
 * before that. Calling them verified would be a lie, and quietly recording a
 * digest for them now would bless whatever damage they already carry.
 */

export interface VerifiableFile {
  id: string;
  name: string;
  size: number;
  digest?: string;
}

export type FileVerdict = "ok" | "damaged" | "unchecked" | "unreadable";

export interface VerifyResult {
  ok: number;
  damaged: number;
  unchecked: number;
  unreadable: number;
  /** Named so they can be acted on: re-uploaded, or downloaded and inspected. */
  problems: { name: string; id: string; verdict: FileVerdict }[];
}

export interface VerifyProgress {
  done: number;
  total: number;
  current: string;
  /** Size of the file being read, so a large one does not look like a hang. */
  currentBytes: number;
  bytesDone: number;
  bytesTotal: number;
}

/**
 * Smallest first. The check reads whole files, so a vault that begins with a
 * gigabyte of video shows nothing happening for minutes and looks stalled.
 * Going up in size means the count moves immediately and the expensive ones
 * arrive last, by which point the cost is visible and can be stopped.
 */
export function smallestFirst(files: VerifiableFile[]): VerifiableFile[] {
  return [...files].sort((a, b) => a.size - b.size);
}

/**
 * Reads and judges each file. The reader is injected so the walk can be
 * tested without a server, and so the caller decides how bytes are fetched.
 */
export async function verifyFiles(
  files: VerifiableFile[],
  read: (file: VerifiableFile) => Promise<Uint8Array>,
  options: {
    onProgress?: (progress: VerifyProgress) => void;
    onVerdict?: (file: VerifiableFile, verdict: FileVerdict) => void;
    signal?: AbortSignal;
  } = {},
): Promise<VerifyResult> {
  const result: VerifyResult = { ok: 0, damaged: 0, unchecked: 0, unreadable: 0, problems: [] };
  const bytesTotal = files.reduce((sum, file) => sum + file.size, 0);
  let done = 0;
  let bytesDone = 0;
  for (const file of files) {
    if (options.signal?.aborted) {
      break;
    }
    options.onProgress?.({
      done,
      total: files.length,
      current: file.name,
      currentBytes: file.size,
      bytesDone,
      bytesTotal,
    });
    let verdict: FileVerdict;
    try {
      const bytes = await read(file);
      if (file.digest === undefined) {
        verdict = "unchecked";
      } else if (digestMatches(bytes, file.digest)) {
        verdict = "ok";
      } else {
        verdict = "damaged";
        diag("integrity", `${file.name} does not match the digest recorded for it`);
      }
    } catch (err) {
      // Could not be fetched or decrypted at all, which is worth reporting
      // separately: a network failure and a damaged file are not the same.
      verdict = "unreadable";
      diag("integrity", `${file.name} could not be read: ${err instanceof Error ? err.message : "unknown"}`);
    }
    result[verdict] += 1;
    if (verdict !== "ok") {
      result.problems.push({ name: file.name, id: file.id, verdict });
    }
    options.onVerdict?.(file, verdict);
    done += 1;
    bytesDone += file.size;
    options.onProgress?.({
      done,
      total: files.length,
      current: file.name,
      currentBytes: file.size,
      bytesDone,
      bytesTotal,
    });
  }
  return result;
}

export type StorageVerdict = "intact" | "changed" | "recorded" | "unreadable" | "missing";

export interface StorageCheckResult {
  intact: number;
  changed: number;
  /** Had no digest on the server until now; a baseline, not a verification. */
  recorded: number;
  unreadable: number;
  missing: number;
  problems: { name: string; id: string; verdict: StorageVerdict }[];
}

/** Small enough that a slow answer is still progress, large enough to be quick. */
const BATCH = 25;

/**
 * Asks the server whether what it stores is still what it was given.
 *
 * This is the check worth running habitually. It reads nothing back, so a
 * terabyte costs a few kilobytes of requests, and it catches everything that
 * happens to data at rest: a truncated write, a half-replaced object, bit
 * rot. What it cannot see is whether the right bytes were sent in the first
 * place, because the server only ever saw what it was handed; that is what
 * the checks at upload are for, and what a deep check re-reads to confirm.
 */
export async function checkStoredFiles(
  files: VerifiableFile[],
  options: {
    onProgress?: (progress: VerifyProgress) => void;
    signal?: AbortSignal;
  } = {},
): Promise<StorageCheckResult> {
  const result: StorageCheckResult = {
    intact: 0,
    changed: 0,
    recorded: 0,
    unreadable: 0,
    missing: 0,
    problems: [],
  };
  const byId = new Map(files.map((file) => [file.id, file]));
  const bytesTotal = files.reduce((sum, file) => sum + file.size, 0);
  let done = 0;
  let bytesDone = 0;
  for (let at = 0; at < files.length; at += BATCH) {
    if (options.signal?.aborted) {
      break;
    }
    const batch = files.slice(at, at + BATCH);
    options.onProgress?.({
      done,
      total: files.length,
      current: batch[0]?.name ?? "",
      currentBytes: 0,
      bytesDone,
      bytesTotal,
    });
    const { results } = await api.verifyStored(batch.map((file) => file.id));
    for (const entry of results) {
      const verdict = entry.verdict as StorageVerdict;
      const file = byId.get(entry.id);
      result[verdict] = (result[verdict] ?? 0) + 1;
      if (verdict !== "intact" && file) {
        result.problems.push({ name: file.name, id: file.id, verdict });
      }
      if (verdict === "changed") {
        diag("integrity", `${file?.name ?? entry.id} is not what the server was given`);
      }
    }
    done += batch.length;
    bytesDone += batch.reduce((sum, file) => sum + file.size, 0);
    options.onProgress?.({
      done,
      total: files.length,
      current: batch[batch.length - 1]?.name ?? "",
      currentBytes: 0,
      bytesDone,
      bytesTotal,
    });
  }
  return result;
}

/** A plain sentence for a storage check. */
export function describeStorageCheck(result: StorageCheckResult, stopped: boolean): string {
  const parts: string[] = [];
  parts.push(
    result.changed > 0
      ? `${result.changed} file${result.changed === 1 ? "" : "s"} no longer match what was stored`
      : `${result.intact} file${result.intact === 1 ? "" : "s"} still match what was stored`,
  );
  if (result.recorded > 0) {
    parts.push(`${result.recorded} had nothing recorded to compare against and now do`);
  }
  if (result.unreadable + result.missing > 0) {
    parts.push(`${result.unreadable + result.missing} could not be found`);
  }
  return `${stopped ? "Stopped. " : ""}${parts.join("; ")}.`;
}

/** A plain sentence for the result, because counts alone invite squinting. */
export function describeVerify(result: VerifyResult, stopped: boolean): string {
  const checked = result.ok + result.damaged;
  const parts: string[] = [];
  parts.push(
    result.damaged > 0
      ? `${result.damaged} file${result.damaged === 1 ? "" : "s"} did not match, of ${checked} checked`
      : `${checked} file${checked === 1 ? "" : "s"} checked, all intact`,
  );
  if (result.unchecked > 0) {
    parts.push(`${result.unchecked} stored before this check existed and carry nothing to check against`);
  }
  if (result.unreadable > 0) {
    parts.push(`${result.unreadable} could not be read at all`);
  }
  return `${stopped ? "Stopped. " : ""}${parts.join("; ")}.`;
}
