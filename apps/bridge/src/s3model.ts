import type { Vault, VaultFile } from "./vault.js";
import { fileEtag } from "./vault.js";
import type { ListObjectsResult } from "./xml.js";

/**
 * Maps the vault's folder tree onto the S3 flat namespace. Each top-level
 * folder is a bucket; files at the vault root live in a synthetic bucket. An
 * object key is the file's path within its bucket, and ListObjectsV2's prefix
 * and delimiter reconstruct the folder view over that flat key space.
 */

export const ROOT_BUCKET = "vault-root";
const CREATION_DATE = new Date(0).toISOString();

interface Entry {
  bucket: string;
  key: string;
  file: VaultFile;
}

/** Folder names from the vault root down to (and including) folderId. */
function folderPath(vault: Vault, folderId: string | null): string[] {
  const names: string[] = [];
  let cursor = folderId;
  const guard = new Set<string>();
  while (cursor && !guard.has(cursor)) {
    guard.add(cursor);
    const folder = vault.folders.get(cursor);
    if (!folder) {
      break;
    }
    names.unshift(folder.name);
    cursor = folder.parentId;
  }
  return names;
}

/** Every file expressed as a (bucket, key) pair. */
function allEntries(vault: Vault): Entry[] {
  const out: Entry[] = [];
  for (const file of vault.files.values()) {
    const path = folderPath(vault, file.folderId);
    if (path.length === 0) {
      out.push({ bucket: ROOT_BUCKET, key: file.name, file });
    } else {
      out.push({ bucket: path[0]!, key: [...path.slice(1), file.name].join("/"), file });
    }
  }
  return out;
}

export function bucketNames(vault: Vault): string[] {
  const names = new Set<string>();
  for (const folder of vault.folders.values()) {
    if (folder.parentId === null) {
      names.add(folder.name);
    }
  }
  const list = [...names].sort();
  if ([...vault.files.values()].some((f) => f.folderId === null)) {
    list.unshift(ROOT_BUCKET);
  }
  return list;
}

export function bucketExists(vault: Vault, bucket: string): boolean {
  return bucketNames(vault).includes(bucket);
}

/** Resolve a bucket + object key to a file, or null. */
export function resolveObject(vault: Vault, bucket: string, key: string): VaultFile | null {
  for (const entry of allEntries(vault)) {
    if (entry.bucket === bucket && entry.key === key) {
      return entry.file;
    }
  }
  return null;
}

export interface ListParams {
  prefix: string;
  delimiter: string;
  continuationToken?: string;
  maxKeys: number;
}

/** ListObjectsV2 with prefix, delimiter, and continuation-token pagination. */
export function listObjects(vault: Vault, bucket: string, params: ListParams): ListObjectsResult {
  const { prefix, delimiter, maxKeys } = params;
  const contents = new Map<string, VaultFile>();
  const commonPrefixes = new Set<string>();

  for (const entry of allEntries(vault)) {
    if (entry.bucket !== bucket || !entry.key.startsWith(prefix)) {
      continue;
    }
    const rest = entry.key.slice(prefix.length);
    const cut = delimiter ? rest.indexOf(delimiter) : -1;
    if (cut >= 0) {
      commonPrefixes.add(prefix + rest.slice(0, cut + delimiter.length));
    } else {
      contents.set(entry.key, entry.file);
    }
  }

  // Merge folders and files into one lexicographically sorted, paginated view.
  type Row = { sortKey: string } & ({ prefix: string } | { key: string; file: VaultFile });
  const rows: Row[] = [
    ...[...commonPrefixes].map((p) => ({ sortKey: p, prefix: p })),
    ...[...contents.entries()].map(([key, file]) => ({ sortKey: key, key, file })),
  ].sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));

  const after = params.continuationToken
    ? Buffer.from(params.continuationToken, "base64").toString("utf8")
    : "";
  const remaining = after ? rows.filter((r) => r.sortKey > after) : rows;
  const page = remaining.slice(0, maxKeys);
  const isTruncated = remaining.length > maxKeys;
  const last = page[page.length - 1];

  return {
    bucket,
    prefix,
    delimiter,
    maxKeys,
    keyCount: page.length,
    isTruncated,
    continuationToken: params.continuationToken,
    nextContinuationToken:
      isTruncated && last ? Buffer.from(last.sortKey, "utf8").toString("base64") : undefined,
    contents: page
      .filter((r): r is Row & { key: string; file: VaultFile } => "key" in r)
      .map((r) => ({
        key: r.key,
        lastModified: new Date(r.file.mtime).toISOString(),
        etag: fileEtag(r.file),
        size: r.file.size,
      })),
    commonPrefixes: page
      .filter((r): r is Row & { prefix: string } => "prefix" in r)
      .map((r) => r.prefix),
  };
}

export { CREATION_DATE };
