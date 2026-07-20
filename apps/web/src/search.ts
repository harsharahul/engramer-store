import type { FileEntry, FolderEntry } from "./store";
import { fileKind } from "./format";

export interface SearchHit {
  file: FileEntry;
  score: number;
  matchedText: string | null;
}

export interface ParsedQuery {
  terms: string;
  tags: string[];
  types: string[];
  folder: string | null;
  favorite: boolean;
}

/**
 * Query grammar: free text plus `tag:receipts`, `type:image`, `type:pdf`,
 * `in:folder-name`, `is:favorite`. Filters narrow; free text ranks.
 */
export function parseQuery(query: string): ParsedQuery {
  const parsed: ParsedQuery = { terms: "", tags: [], types: [], folder: null, favorite: false };
  const words: string[] = [];
  for (const token of query.trim().split(/\s+/)) {
    const match = /^(tag|type|in|is):(.*)$/i.exec(token);
    if (!match || !match[2]) {
      if (token) {
        words.push(token);
      }
      continue;
    }
    const value = match[2].toLowerCase();
    switch (match[1]!.toLowerCase()) {
      case "tag":
        parsed.tags.push(value);
        break;
      case "type":
        parsed.types.push(value);
        break;
      case "in":
        parsed.folder = value;
        break;
      case "is":
        if (value === "favorite" || value === "starred") {
          parsed.favorite = true;
        }
        break;
    }
  }
  parsed.terms = words.join(" ").toLowerCase();
  return parsed;
}

/**
 * Client-side search over decrypted metadata: filters plus fuzzy name match
 * and substring match on extracted content. Never touches the network.
 */
export function searchFiles(
  files: Iterable<FileEntry>,
  query: string,
  folders?: ReadonlyMap<string, FolderEntry>,
): SearchHit[] {
  const parsed = parseQuery(query);
  if (!parsed.terms && parsed.tags.length === 0 && parsed.types.length === 0 && !parsed.folder && !parsed.favorite) {
    return [];
  }
  const hits: SearchHit[] = [];
  for (const file of files) {
    if (file.trashed || !passesFilters(file, parsed, folders)) {
      continue;
    }
    if (!parsed.terms) {
      hits.push({ file, score: 1, matchedText: null });
      continue;
    }
    const nameScore = fuzzyScore(file.name.toLowerCase(), parsed.terms);
    const tagScore = file.tags.some((t) => t.includes(parsed.terms)) ? 0.8 : 0;
    let contentSnippet: string | null = null;
    if (file.text) {
      const index = file.text.toLowerCase().indexOf(parsed.terms);
      if (index >= 0) {
        contentSnippet = snippet(file.text, index, parsed.terms.length);
      }
    }
    const score = Math.max(nameScore, tagScore, contentSnippet ? 0.5 : 0);
    if (score > 0) {
      hits.push({ file, score, matchedText: contentSnippet });
    }
  }
  return hits.sort((a, b) => b.score - a.score);
}

function passesFilters(
  file: FileEntry,
  parsed: ParsedQuery,
  folders?: ReadonlyMap<string, FolderEntry>,
): boolean {
  if (parsed.favorite && !file.favorite) {
    return false;
  }
  for (const tag of parsed.tags) {
    if (!file.tags.some((t) => t.includes(tag))) {
      return false;
    }
  }
  for (const type of parsed.types) {
    const kind = fileKind(file.mime, file.name);
    const ext = file.name.slice(file.name.lastIndexOf(".") + 1).toLowerCase();
    const category = file.category?.toLowerCase() ?? "";
    if (kind !== type && ext !== type && category !== type) {
      return false;
    }
  }
  if (parsed.folder) {
    if (!folders || !file.folderId) {
      return false;
    }
    const folder = folders.get(file.folderId);
    if (!folder || !folder.name.toLowerCase().includes(parsed.folder)) {
      return false;
    }
  }
  return true;
}

/** Subsequence match: all query characters in order, rewarded for tightness. */
function fuzzyScore(haystack: string, needle: string): number {
  if (haystack.includes(needle)) {
    return 1 + needle.length / haystack.length;
  }
  let hi = 0;
  let firstMatch = -1;
  let lastMatch = -1;
  for (let ni = 0; ni < needle.length; ni++) {
    const found = haystack.indexOf(needle[ni]!, hi);
    if (found === -1) {
      return 0;
    }
    if (firstMatch === -1) {
      firstMatch = found;
    }
    lastMatch = found;
    hi = found + 1;
  }
  const spread = lastMatch - firstMatch + 1;
  return (needle.length / spread) * 0.9;
}

function snippet(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + length + 60);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end).replaceAll("\n", " ")}${suffix}`;
}
