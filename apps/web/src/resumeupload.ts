/**
 * Memory for interrupted uploads.
 *
 * The upload journal writes a record here as a large media upload
 * happens: the file row, the server session, the format header, which
 * parts landed, and the file key sealed under the master key. Whatever
 * moment the app dies at, the record describes it, and the next open can
 * offer to continue from the last finished part instead of starting a
 * multi-hundred-megabyte file over.
 *
 * Records exist only for path-backed native sources (their bytes survive
 * the kill on disk) and only while an upload is incomplete: finishing,
 * failing, or discarding removes them, key and all.
 */

import { fromB64, secretBoxOpen, secretBoxSeal, toB64, type SecretBox } from "@engramer/crypto";
import type { ResumePart, UploadJournal, UploadResumeState } from "./transfer";

/** Where the interrupted upload's bytes live, and how to read them back. */
export interface ResumeRecordSource {
  path: string;
  family: "picked" | "watched";
  name: string;
  type: string;
  size: number;
  mtime: number;
  sourceId?: string;
  folderId: string | null;
}

export interface ResumeRecord extends ResumeRecordSource {
  v: 1;
  fileId: string;
  session: string;
  headerB64: string;
  wrappedKey: SecretBox;
  parts: ResumePart[];
  startedAt: number;
}

function storageKey(account: string): string {
  return `engram-upload-resume:${account}`;
}

function readAll(account: string): Record<string, ResumeRecord> {
  try {
    const raw = localStorage.getItem(storageKey(account));
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, ResumeRecord>)
      : {};
  } catch {
    return {};
  }
}

function writeAll(account: string, records: Record<string, ResumeRecord>): void {
  try {
    if (Object.keys(records).length === 0) {
      localStorage.removeItem(storageKey(account));
    } else {
      localStorage.setItem(storageKey(account), JSON.stringify(records));
    }
  } catch {
    // Best-effort: without the record the upload restarts from zero.
  }
}

export function loadResumeRecords(account: string): ResumeRecord[] {
  return Object.values(readAll(account)).filter((r) => r && r.v === 1);
}

export function clearResumeRecord(account: string, fileId: string): void {
  const records = readAll(account);
  delete records[fileId];
  writeAll(account, records);
}

/** The journal an upload writes through; every call persists. */
export function makeJournal(
  account: string,
  masterKey: Uint8Array,
  source: ResumeRecordSource,
): UploadJournal {
  let fileId: string | null = null;
  return {
    begin(info) {
      fileId = info.fileId;
      const records = readAll(account);
      // A resumed run begins again over the same record; what its earlier
      // life already landed stays known.
      const existing = records[info.fileId];
      records[info.fileId] = {
        v: 1,
        ...source,
        fileId: info.fileId,
        session: info.session,
        headerB64: toB64(info.header),
        wrappedKey: secretBoxSeal(info.fileKey, masterKey),
        parts: existing?.parts ?? [],
        startedAt: existing?.startedAt ?? Date.now(),
      };
      writeAll(account, records);
    },
    part(part) {
      if (!fileId) {
        return;
      }
      const records = readAll(account);
      const record = records[fileId];
      if (!record) {
        return;
      }
      const existing = record.parts.find((p) => p.no === part.no);
      if (existing) {
        Object.assign(existing, part);
      } else {
        record.parts.push({ ...part });
      }
      writeAll(account, records);
    },
    finish() {
      if (fileId) {
        clearResumeRecord(account, fileId);
      }
    },
  };
}

/** Opens a record back into what the upload machinery resumes from. */
export function resumeStateOf(record: ResumeRecord, masterKey: Uint8Array): UploadResumeState {
  return {
    fileId: record.fileId,
    session: record.session,
    header: fromB64(record.headerB64),
    fileKey: secretBoxOpen(record.wrappedKey, masterKey),
    parts: record.parts.map((p) => ({ ...p })),
  };
}
