/**
 * Natural-language search: a sentence such as "receipts from last
 * december" becomes the filters the search grammar already understands
 * (`tag:receipt after:2025-12 before:2025-12`), and the ordinary engine
 * runs it. The model only ever proposes; this module decides what it may
 * say (`shouldInterpret`), hands it the vocabulary it may use
 * (`promptFor`), and keeps only what that vocabulary or the calendar
 * confirms (`validateInterpretation`). Whatever comes back, the query
 * string that reaches the engine is made of known tokens and real dates.
 *
 * Pure functions, so the guard can be tested without a model.
 */

import { isReservedTag } from "../albums";
import type { JsonSchema } from "../intel/assistant";
import { TYPE_WORDS } from "../search";

/** The library's most-used tags, the part of the vocabulary that is the
 * user's own. Albums and trips are places, not tags, and stay out. */
export function topTags(files: Iterable<{ tags?: readonly string[] | undefined }>, limit: number): string[] {
  const counts = new Map<string, number>();
  for (const file of files) {
    for (const tag of file.tags ?? []) {
      if (isReservedTag(tag)) {
        continue;
      }
      const key = tag.toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([tag]) => tag);
}

export interface Vocabulary {
  /** The Library categories, as displayed (Photos, Receipts, ...). */
  categories: readonly string[];
  /** The scene labels the meaning model can stamp (beach, food, ...). */
  scenes: readonly string[];
  /** The most-used tags in this library. */
  tags: readonly string[];
  /** Folder names anywhere in the tree. */
  folders: readonly string[];
}

export interface Interpretation {
  terms: string[];
  tags: string[];
  types: string[];
  folder: string | null;
  favorite: boolean;
  after: string | null;
  before: string | null;
  confidence: number;
}

/** Below this the model's guess is held back rather than shown. */
const MIN_CONFIDENCE = 0.6;
/** A date this far from today is a misreading, not a filter. */
const YEAR_SPAN = 30;
const MIN_WORDS = 3;

const QUESTION_STARTS = new Set([
  "ask",
  "what",
  "when",
  "which",
  "how",
  "who",
  "where",
  "why",
  "is",
  "are",
  "do",
  "does",
  "did",
  "can",
  "was",
  "were",
]);

export function isQuestionShaped(query: string): boolean {
  const trimmed = query.trim();
  if (trimmed.endsWith("?")) {
    return true;
  }
  const first = trimmed.split(/\s+/)[0]?.toLowerCase() ?? "";
  return QUESTION_STARTS.has(first);
}

/** A token that reads as an exact thing rather than a word: a file name,
 * a code mixing letters and digits, an all-caps identifier. Such a query
 * is never rewritten. */
function looksExact(token: string): boolean {
  if (/\.[a-z0-9]{2,4}$/i.test(token)) {
    return true;
  }
  if (/[a-z]/i.test(token) && /\d/.test(token)) {
    return true;
  }
  return /^[A-Z0-9_]{3,}$/.test(token) && /[A-Z]/.test(token);
}

function hasOperator(query: string): boolean {
  return /(^|\s)(tag|type|in|is|before|after):/i.test(query);
}

/**
 * Whether a query is worth a model round trip: the assistant is here and
 * on, the request is a sentence, it holds no operator and nothing that
 * reads as an exact token, it is not a question, and the literal search
 * found nothing (a query that already works is left alone).
 */
export function shouldInterpret(
  query: string,
  context: { available: boolean; enabled: boolean; literalHits: number },
): boolean {
  if (!context.available || !context.enabled || context.literalHits > 0) {
    return false;
  }
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (words.length < MIN_WORDS || hasOperator(query) || isQuestionShaped(query)) {
    return false;
  }
  return !words.some(looksExact);
}

export const interpretationSchema: JsonSchema = {
  type: "object",
  title: "Interpretation",
  properties: {
    terms: { type: "array", items: { type: "string" }, description: "Words from the request to match literally, such as a name; leave empty when the filters say it all", maxItems: 3 },
    tags: { type: "array", items: { type: "string" }, description: "Tags from the list that the request asks for", maxItems: 3 },
    types: { type: "array", items: { type: "string" }, description: "Kinds of file from the list that the request asks for", maxItems: 2 },
    folder: { type: "string", description: "A folder name from the list, or empty" },
    favorite: { type: "boolean", description: "True only when the request asks for favorites" },
    after: { type: "string", description: "Earliest date, inclusive, as YYYY, YYYY-MM or YYYY-MM-DD, or empty" },
    before: { type: "string", description: "Latest date, inclusive, as YYYY, YYYY-MM or YYYY-MM-DD, or empty" },
    confidence: { type: "number", description: "How sure the reading is, from 0 to 1" },
  },
  required: ["confidence"],
  order: ["terms", "tags", "types", "folder", "favorite", "after", "before", "confidence"],
};

function isoDate(day: Date): string {
  const month = String(day.getMonth() + 1).padStart(2, "0");
  const date = String(day.getDate()).padStart(2, "0");
  return `${day.getFullYear()}-${month}-${date}`;
}

export function promptFor(
  query: string,
  vocab: Vocabulary,
  today: Date,
): { instructions: string; prompt: string } {
  const instructions =
    `You turn a search request over a personal file library into filters. Today is ${isoDate(today)}. ` +
    "Use only words from the lists given; leave a field empty when the request does not call for it. " +
    "Relative times such as last december, this year or the past month resolve against today; " +
    "after and before are inclusive bounds written as YYYY, YYYY-MM or YYYY-MM-DD. " +
    "Do not invent tags, kinds or folders.";
  const prompt =
    `Categories: ${vocab.categories.join(", ")}\n` +
    `Tags: ${[...vocab.scenes, ...vocab.tags].join(", ")}\n` +
    `Kinds: ${TYPE_WORDS.join(", ")}\n` +
    `Folders: ${vocab.folders.join(", ")}\n` +
    `Request: "${query}"`;
  return { instructions, prompt };
}

const DATE = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/;

/** A date the grammar reads and the calendar confirms, near today. */
function validDate(value: unknown, today: Date): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = DATE.exec(value.trim());
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  if (Math.abs(year - today.getFullYear()) > YEAR_SPAN) {
    return null;
  }
  const month = match[2] ? Number(match[2]) : null;
  const day = match[3] ? Number(match[3]) : null;
  if (month !== null && (month < 1 || month > 12)) {
    return null;
  }
  if (day !== null) {
    const probe = new Date(year, (month ?? 1) - 1, day);
    if (probe.getMonth() !== (month ?? 1) - 1 || probe.getDate() !== day) {
      return null;
    }
  }
  return value.trim();
}

function bound(value: string, endOfPeriod: boolean): number {
  const match = DATE.exec(value)!;
  const year = Number(match[1]);
  const month = match[2] ? Number(match[2]) - 1 : endOfPeriod ? 11 : 0;
  const day = match[3] ? Number(match[3]) : endOfPeriod ? new Date(year, month + 1, 0).getDate() : 1;
  const date = new Date(year, month, day);
  if (endOfPeriod) {
    date.setHours(23, 59, 59, 999);
  }
  return date.getTime();
}

function strings(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, limit);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Keeps only what the vocabulary or the calendar confirms. Returns null
 * when the model was unsure or nothing usable remains; the caller then
 * shows nothing at all rather than a guess.
 */
export function validateInterpretation(
  raw: unknown,
  vocab: Vocabulary,
  today: Date,
  query: string,
): Interpretation | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const answer = raw as Record<string, unknown>;
  const confidence = typeof answer.confidence === "number" ? answer.confidence : 0;
  if (!(confidence >= MIN_CONFIDENCE)) {
    return null;
  }
  const knownTags = new Set([...vocab.tags, ...vocab.scenes, ...vocab.categories].map((t) => t.toLowerCase()));
  const knownTypes = new Set([...TYPE_WORDS, ...vocab.categories.map((c) => c.toLowerCase())]);
  const requestWords = new Set(
    query
      .toLowerCase()
      .split(/\s+/)
      .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
      .filter(Boolean),
  );
  const tags = unique(strings(answer.tags, 3).map((t) => t.toLowerCase()).filter((t) => knownTags.has(t)));
  const types = unique(strings(answer.types, 2).map((t) => t.toLowerCase()).filter((t) => knownTypes.has(t)));
  const terms = unique(strings(answer.terms, 3).map((t) => t.toLowerCase()).filter((t) => requestWords.has(t)));
  const wanted = typeof answer.folder === "string" ? answer.folder.trim().toLowerCase() : "";
  const folder = wanted ? (vocab.folders.find((f) => f.toLowerCase() === wanted) ?? null) : null;
  const favorite = answer.favorite === true;
  let after = validDate(answer.after, today);
  let before = validDate(answer.before, today);
  if (after && before && bound(after, false) > bound(before, true)) {
    after = null;
    before = null;
  }
  // Filters are an interpretation; so are fewer words than the request
  // had (the filler dropped). Echoing the request back is neither.
  const noFilters = tags.length === 0 && types.length === 0 && folder === null && !favorite && after === null && before === null;
  if (noFilters && (terms.length === 0 || terms.length >= requestWords.size)) {
    return null;
  }
  return { terms, tags, types, folder, favorite, after, before, confidence };
}

/** The grammar splits on whitespace, and `tag:` and `in:` match by
 * substring, so a multi-word value is carried by its most specific word. */
function tokenWord(value: string): string {
  const words = value.toLowerCase().split(/\s+/).filter(Boolean);
  return words.reduce((best, word) => (word.length > best.length ? word : best), words[0] ?? "");
}

/** Writes the interpretation in the grammar `parseQuery` reads. */
export function toQueryString(parsed: Interpretation): string {
  const tokens: string[] = [...parsed.terms];
  for (const tag of parsed.tags) {
    tokens.push(`tag:${tokenWord(tag)}`);
  }
  for (const type of parsed.types) {
    tokens.push(`type:${tokenWord(type)}`);
  }
  if (parsed.folder) {
    tokens.push(`in:${tokenWord(parsed.folder)}`);
  }
  if (parsed.favorite) {
    tokens.push("is:favorite");
  }
  if (parsed.after) {
    tokens.push(`after:${parsed.after}`);
  }
  if (parsed.before) {
    tokens.push(`before:${parsed.before}`);
  }
  return tokens.join(" ");
}
