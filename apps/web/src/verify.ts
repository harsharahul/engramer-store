import { digestMatches } from "@engramer/crypto";
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
  let done = 0;
  for (const file of files) {
    if (options.signal?.aborted) {
      break;
    }
    options.onProgress?.({ done, total: files.length, current: file.name });
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
    options.onProgress?.({ done, total: files.length, current: file.name });
  }
  return result;
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
