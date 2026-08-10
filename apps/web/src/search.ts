import type { FileEntry, FolderEntry } from "./store";
import { isReservedTag } from "./albums";
import { fileKind } from "./format";

export interface Highlight {
  start: number;
  end: number;
}

export interface SearchHit {
  file: FileEntry;
  score: number;
  /** Content snippet around the best match, when the match came from text. */
  matchedText: string | null;
  /** Match ranges within matchedText, for highlighting. */
  textRanges: Highlight[];
  /** Match ranges within the file name, for highlighting. */
  nameRanges: Highlight[];
  /** Which folder-name matched, when the hit came from location. */
  matchedFolder: string | null;
  /** The hit came from semantic similarity rather than the words typed. */
  semantic?: boolean;
}

/**
 * The one list search shows: literal hits first, meaning matches after,
 * a file never listed twice. The header count, the keyboard cursor and
 * the rendered rows must all read THIS list; when they compute their own,
 * they drift, and a meaning match sits under a "0 results" headline that
 * arrow keys cannot reach.
 */
export function mergeSearchHits(hits: SearchHit[], semanticHits: SearchHit[]): SearchHit[] {
  const seen = new Set(hits.map((h) => h.file.id));
  return [...hits, ...semanticHits.filter((s) => !seen.has(s.file.id))];
}

export interface ParsedQuery {
  terms: string[];
  tags: string[];
  types: string[];
  folder: string | null;
  favorite: boolean;
  before: number | null;
  after: number | null;
}

const KIND_SYNONYMS: Record<string, string> = {
  picture: "image",
  photo: "image",
  photos: "image",
  img: "image",
  movie: "video",
  videos: "video",
  doc: "doc",
  docx: "doc",
  word: "doc",
  sound: "audio",
  music: "audio",
  note: "text",
  notes: "text",
};

/**
 * Query grammar: free text plus `tag:receipts`, `type:image`, `in:folder`,
 * `is:favorite`, `before:2026-03`, `after:2025`. Filters narrow; free text
 * ranks. Dates accept YYYY, YYYY-MM, or YYYY-MM-DD.
 */
export function parseQuery(query: string): ParsedQuery {
  const parsed: ParsedQuery = {
    terms: [],
    tags: [],
    types: [],
    folder: null,
    favorite: false,
    before: null,
    after: null,
  };
  for (const token of query.trim().split(/\s+/)) {
    const match = /^(tag|type|in|is|before|after):(.*)$/i.exec(token);
    if (!match || !match[2]) {
      if (token) {
        parsed.terms.push(token.toLowerCase());
      }
      continue;
    }
    const value = match[2].toLowerCase();
    switch (match[1]!.toLowerCase()) {
      case "tag":
        parsed.tags.push(value);
        break;
      case "type":
        parsed.types.push(KIND_SYNONYMS[value] ?? value);
        break;
      case "in":
        parsed.folder = value;
        break;
      case "is":
        if (value === "favorite" || value === "starred") {
          parsed.favorite = true;
        }
        break;
      case "before":
        parsed.before = parseDate(value, true);
        break;
      case "after":
        parsed.after = parseDate(value, false);
        break;
    }
  }
  return parsed;
}

/** YYYY[-MM[-DD]] to a millisecond bound; end-of-period for `before`. */
function parseDate(value: string, endOfPeriod: boolean): number | null {
  const match = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/.exec(value);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = match[2] ? Number(match[2]) - 1 : endOfPeriod ? 11 : 0;
  const day = match[3] ? Number(match[3]) : endOfPeriod ? lastDay(year, month) : 1;
  const date = new Date(year, month, day);
  if (endOfPeriod) {
    date.setHours(23, 59, 59, 999);
  }
  return date.getTime();
}

function lastDay(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

interface Context {
  parsed: ParsedQuery;
  folders?: ReadonlyMap<string, FolderEntry>;
  now: number;
}

/**
 * Client-side search over decrypted metadata. Every query term must match
 * somewhere: file name (with typo tolerance), tags, category, the name of any
 * ancestor folder, or extracted text (including OCR). Nothing touches the
 * network, and results favor names over content and fresh files over stale.
 */
export function searchFiles(
  files: Iterable<FileEntry>,
  query: string,
  folders?: ReadonlyMap<string, FolderEntry>,
): SearchHit[] {
  const parsed = parseQuery(query);
  const empty =
    parsed.terms.length === 0 &&
    parsed.tags.length === 0 &&
    parsed.types.length === 0 &&
    !parsed.folder &&
    !parsed.favorite &&
    parsed.before === null &&
    parsed.after === null;
  if (empty) {
    return [];
  }
  const context: Context = { parsed, folders, now: Date.now() };
  const hits: SearchHit[] = [];
  for (const file of files) {
    if (file.trashed || !passesFilters(file, context)) {
      continue;
    }
    const hit = scoreFile(file, context);
    if (hit) {
      hits.push(hit);
    }
  }
  return hits.sort((a, b) => b.score - a.score);
}

function passesFilters(file: FileEntry, { parsed, folders }: Context): boolean {
  if (parsed.favorite && !file.favorite) {
    return false;
  }
  if (parsed.before !== null && file.mtime > parsed.before) {
    return false;
  }
  if (parsed.after !== null && file.mtime < parsed.after) {
    return false;
  }
  for (const tag of parsed.tags) {
    // A reserved-namespace query names one album or trip exactly. A free
    // query keeps substring matching, "tag:hol" finding "holiday" is the
    // point, but only over free tags: without that exclusion "tag:holiday"
    // would also drag in "album:holidays-2026".
    const matches = isReservedTag(tag)
      ? file.tags.includes(tag)
      : file.tags.some((t) => !isReservedTag(t) && t.includes(tag));
    if (!matches) {
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
    if (!folders || !folderChain(file, folders).some((n) => n.includes(parsed.folder!))) {
      return false;
    }
  }
  return true;
}

/** Lowercased names of every folder on the file's path, deepest first. */
function folderChain(file: FileEntry, folders?: ReadonlyMap<string, FolderEntry>): string[] {
  const names: string[] = [];
  let cursor = file.folderId;
  let guard = 0;
  while (cursor && folders && guard < 32) {
    const folder = folders.get(cursor);
    if (!folder) {
      break;
    }
    names.push(folder.name.toLowerCase());
    cursor = folder.parentId;
    guard++;
  }
  return names;
}

function scoreFile(file: FileEntry, context: Context): SearchHit | null {
  const { parsed, folders, now } = context;
  if (parsed.terms.length === 0) {
    // Pure filter query: order by freshness.
    return {
      file,
      score: 1 + recencyBoost(file, now),
      matchedText: null,
      textRanges: [],
      nameRanges: [],
      matchedFolder: null,
    };
  }

  const name = file.name.toLowerCase();
  const text = file.text?.toLowerCase();
  const chain = folderChain(file, folders);
  const category = file.category?.toLowerCase() ?? "";

  let total = 0;
  const nameRanges: Highlight[] = [];
  let firstTextIndex = -1;
  let matchedFolder: string | null = null;

  for (const term of parsed.terms) {
    let best = 0;

    // Name: substring, word prefix, small typo, loose subsequence.
    const index = name.indexOf(term);
    if (index >= 0) {
      const wordStart = index === 0 || !/[a-z0-9]/.test(name[index - 1]!);
      best = (wordStart ? 3.2 : 2.6) + term.length / name.length;
      nameRanges.push({ start: index, end: index + term.length });
    } else if (term.length >= 4) {
      const typo = nameWords(file.name).find((w) => withinOneEdit(w, term));
      if (typo) {
        best = 1.8;
      } else {
        best = subsequenceScore(name, term);
      }
    } else {
      best = subsequenceScore(name, term);
    }

    // Tags and category.
    for (const tag of file.tags) {
      if (tag === term) {
        best = Math.max(best, 2.4);
      } else if (tag.startsWith(term)) {
        best = Math.max(best, 1.9);
      }
    }
    if (category && (category === term || category.startsWith(term))) {
      best = Math.max(best, 1.4);
    }

    // Location: the term names a folder on the file's path. This is what
    // finds "that tax document" when only the folder was ever named "Taxes".
    const folderHit = chain.find((n) => n.includes(term));
    if (folderHit) {
      best = Math.max(best, 1.5);
      matchedFolder = matchedFolder ?? folderHit;
    }

    // Content, including OCR text.
    if (text) {
      const at = text.indexOf(term);
      if (at >= 0) {
        best = Math.max(best, 1.2);
        if (firstTextIndex < 0) {
          firstTextIndex = at;
        }
      }
    }

    if (best <= 0.05) {
      return null; // AND semantics: every term must land somewhere.
    }
    total += best;
  }

  let matchedText: string | null = null;
  let textRanges: Highlight[] = [];
  if (firstTextIndex >= 0 && file.text) {
    const built = buildSnippet(file.text, firstTextIndex, parsed.terms);
    matchedText = built.snippet;
    textRanges = built.ranges;
  }

  return {
    file,
    score: total * (1 + recencyBoost(file, now)),
    matchedText,
    textRanges,
    nameRanges: mergeRanges(nameRanges),
    matchedFolder,
  };
}

/** Fresh files float: full boost within a day, fading to zero over 60 days. */
function recencyBoost(file: FileEntry, now: number): number {
  const age = Math.max(0, now - file.updatedAt);
  const days = age / 86_400_000;
  return 0.25 * Math.max(0, 1 - days / 60);
}

function nameWords(name: string): string[] {
  return name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
}

/** Levenshtein distance <= 1, without building the full matrix. */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (longer.length - shorter.length > 1) {
    return false;
  }
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) {
      return false;
    }
    if (shorter.length === longer.length) {
      i++; // substitution
    }
    j++; // insertion into the longer string
  }
  return edits + (longer.length - j) + (shorter.length - i) <= 1;
}

/** Subsequence match: all characters in order, rewarded for tightness. */
function subsequenceScore(haystack: string, needle: string): number {
  if (needle.length < 3) {
    return 0;
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
  const tightness = needle.length / spread;
  return tightness >= 0.5 ? tightness * 0.9 : 0;
}

function buildSnippet(
  text: string,
  index: number,
  terms: string[],
): { snippet: string; ranges: Highlight[] } {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + 100);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  const body = text.slice(start, end).replaceAll("\n", " ");
  const snippet = `${prefix}${body}${suffix}`;
  const lowered = body.toLowerCase();
  const ranges: Highlight[] = [];
  for (const term of terms) {
    let at = lowered.indexOf(term);
    while (at >= 0 && ranges.length < 8) {
      ranges.push({ start: prefix.length + at, end: prefix.length + at + term.length });
      at = lowered.indexOf(term, at + term.length);
    }
  }
  return { snippet, ranges: mergeRanges(ranges) };
}

function mergeRanges(ranges: Highlight[]): Highlight[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: Highlight[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/** Splits a string into plain and highlighted parts for rendering. */
export function highlightParts(
  value: string,
  ranges: Highlight[],
): Array<{ text: string; hit: boolean }> {
  if (ranges.length === 0) {
    return [{ text: value, hit: false }];
  }
  const parts: Array<{ text: string; hit: boolean }> = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) {
      parts.push({ text: value.slice(cursor, range.start), hit: false });
    }
    parts.push({ text: value.slice(range.start, range.end), hit: true });
    cursor = range.end;
  }
  if (cursor < value.length) {
    parts.push({ text: value.slice(cursor), hit: false });
  }
  return parts;
}
