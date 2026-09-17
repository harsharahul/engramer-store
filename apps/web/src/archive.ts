import { gunzipSync, strFromU8, unzipSync } from "fflate";

/**
 * Archives, read on the device: what is inside a zip, tar or tar.gz, and
 * the entries themselves when the user asks to extract them. Nothing is
 * executed; entries are files that go through the ordinary upload path
 * one by one, so they are encrypted, indexed and processed like any
 * other upload. Paths are cleaned so an entry can never name a place
 * outside the folder it is extracted into.
 */

export interface ArchiveEntry {
  /** The cleaned path inside the archive, "/"-separated. */
  path: string;
  size: number;
  directory: boolean;
}

export interface ExtractedEntry {
  path: string;
  data: Uint8Array;
}

export type ArchiveFormat = "zip" | "tar" | "tgz";

export function archiveFormat(name: string): ArchiveFormat | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".tar")) return "tar";
  if (lower.endsWith(".tgz") || lower.endsWith(".tar.gz")) return "tgz";
  return null;
}

/** Strips traversal, absolute roots and empty segments from an entry path. */
export function cleanPath(raw: string): string {
  return raw
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .join("/");
}

function readTar(bytes: Uint8Array): ExtractedEntry[] {
  const entries: ExtractedEntry[] = [];
  let offset = 0;
  let longName: string | null = null;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) {
      break;
    }
    const name = strFromU8(header.subarray(0, 100)).replace(/\0.*$/, "");
    const size = parseInt(strFromU8(header.subarray(124, 136)).replace(/\0.*$/, "").trim() || "0", 8);
    const type = String.fromCharCode(header[156] ?? 48);
    const prefix = strFromU8(header.subarray(345, 500)).replace(/\0.*$/, "");
    const data = bytes.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") {
      // GNU long name: the next header's name is this entry's data.
      longName = strFromU8(data).replace(/\0.*$/, "");
      continue;
    }
    const fullName = longName ?? (prefix ? `${prefix}/${name}` : name);
    longName = null;
    if (type === "5" || fullName.endsWith("/")) {
      continue;
    }
    if (type !== "0" && type !== "\0" && type !== "7") {
      continue;
    }
    const path = cleanPath(fullName);
    if (path) {
      entries.push({ path, data: data.slice() });
    }
  }
  return entries;
}

/** Every file entry with its bytes. Directories are implied by paths. */
export function extractArchive(bytes: Uint8Array, name: string): ExtractedEntry[] {
  const format = archiveFormat(name);
  if (format === "zip") {
    const files = unzipSync(bytes, {
      filter: (file) => !file.name.endsWith("/") && !/(^|\/)__MACOSX(\/|$)/.test(file.name) && !/(^|\/)\.DS_Store$/.test(file.name),
    });
    return Object.entries(files)
      .map(([raw, data]) => ({ path: cleanPath(raw), data }))
      .filter((entry) => entry.path);
  }
  if (format === "tar") {
    return readTar(bytes);
  }
  if (format === "tgz") {
    return readTar(gunzipSync(bytes));
  }
  throw new Error("not an archive this app can open");
}

/** What is inside, for the listing, sorted by path. */
export function listArchive(bytes: Uint8Array, name: string): ArchiveEntry[] {
  const seen = new Set<string>();
  const entries: ArchiveEntry[] = [];
  for (const { path, data } of extractArchive(bytes, name)) {
    const parts = path.split("/");
    for (let depth = 1; depth < parts.length; depth++) {
      const dir = parts.slice(0, depth).join("/");
      if (!seen.has(dir)) {
        seen.add(dir);
        entries.push({ path: dir, size: 0, directory: true });
      }
    }
    entries.push({ path, size: data.length, directory: false });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

export function totalSize(entries: readonly ArchiveEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.size, 0);
}
