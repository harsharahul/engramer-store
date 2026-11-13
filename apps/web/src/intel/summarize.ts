/**
 * One-line summaries and a few tags, read by the on-device assistant from
 * the opening of a text-bearing document. They ride the one-pass processor
 * like scene labels: a capable device writes them into the encrypted
 * metadata, every device reads them. The model only proposes; this module
 * decides what may be stored: one clean sentence under a hard cap with
 * reference numbers and addresses masked (metadata is decrypted on every
 * device on every sync), a handful of short tags, a kind the library knows.
 *
 * A file the model declined, could not read, or whose summary the user
 * removed is stamped with the model version and never asked again until the
 * version changes: the lesson of the passes that looped.
 */

import { isReservedTag } from "../albums";
import { AssistantError, generate, type GenerateRequest, type JsonSchema } from "./assistant";
import { CATEGORIES } from "./categorize";
import { spotCandidates } from "./candidates";
import { alreadyRead, type DocumentKind, type Fact } from "./facts";
import { judgeFingerprint, judgeRequest, judgedFacts } from "./judge";
import { settledNowhere } from "./labels";
import { loadLexicon } from "./lexicon";
import { DOCUMENT_KINDS, documentKindProperty } from "./modelfacts";
import { headChunk } from "./window";

export const SUMMARY_MAX = 240;
/** Below this there is nothing to summarize. */
export const MIN_TEXT = 300;
/** An email is worth reading from much less: a subject, a sender, a line. */
export const MIN_MAIL_TEXT = 60;

/** What an email is, as its reading names it; stored as the tag `mail:<kind>`. */
export const MAIL_KINDS = ["booking", "bill", "delivery", "receipt", "newsletter", "personal", "other"] as const;
export type MailKind = (typeof MAIL_KINDS)[number];
const MAX_TAGS = 5;
const TAG_MAX_LENGTH = 24;
/** Room for the answer: a sentence, tags and kinds. A cap that is too small
 * truncates the structured answer and the framework cannot decode it. */
const SUMMARY_TOKENS = 300;

export type NoSummary = "short" | "declined" | "language" | "unsupported" | "user";

const summaryProperties: JsonSchema["properties"] = {
  summary: {
    type: "string",
    description:
      "One sentence, at most thirty words, in plain language, saying what this document is and what it is for. No reference numbers, account numbers, or addresses.",
  },
  tags: {
    type: "array",
    items: { type: "string" },
    description: "Up to five short lowercase words for finding this document later",
    maxItems: MAX_TAGS,
  },
  kind: { type: "string", description: "Which of the listed kinds this document is" },
};

/** The summary alone. */
export const summarySchema: JsonSchema = {
  type: "object",
  title: "Reading",
  properties: summaryProperties,
  required: ["summary", "tags", "kind"],
  order: ["summary", "tags", "kind"],
};

/** The summary plus the kind of document, for when date reading is on. The
 * dates and amounts themselves are never asked for here: rules find them,
 * and a second, short request says what each one is (judge.ts). */
export const summaryWithFactsSchema: JsonSchema = {
  type: "object",
  title: "Reading",
  properties: { ...summaryProperties, ...documentKindProperty },
  required: ["summary", "tags", "kind", "document"],
  order: ["summary", "tags", "kind", "document"],
};

const mailKindProperty: JsonSchema["properties"] = {
  mailKind: { type: "string", enum: [...MAIL_KINDS], description: "Which of the listed kinds this email is" },
};

/** The schema for one reading; an email's also names its kind. */
export function readingSchema(withFacts: boolean, mail = false): JsonSchema {
  const base = withFacts ? summaryWithFactsSchema : summarySchema;
  if (!mail) {
    return base;
  }
  return {
    ...base,
    properties: { ...base.properties, ...mailKindProperty },
    required: [...(base.required ?? []), "mailKind"],
    order: [...(base.order ?? []), "mailKind"],
  };
}

const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/g;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
/** Six or more digits, allowing the spaces and hyphens cards and accounts
 * are printed with. */
const LONG_NUMBER = /\d(?:[ -]?\d){5,}/g;

/** One clean line, capped at a word, with what metadata must not carry
 * masked to its last four characters. */
export function sanitizeSummary(raw: string | undefined): string {
  if (typeof raw !== "string") {
    return "";
  }
  let text = raw.replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }
  const dates: string[] = [];
  text = text.replace(ISO_DATE, (date) => {
    dates.push(date);
    return `\u0000${dates.length - 1}\u0000`;
  });
  text = text.replace(EMAIL, "[email]");
  text = text.replace(LONG_NUMBER, (run) => `…${run.replace(/\D/g, "").slice(-4)}`);
  text = text.replace(/\u0000(\d+)\u0000/g, (_, index: string) => dates[Number(index)] ?? "");
  if (text.length > SUMMARY_MAX) {
    const cut = text.lastIndexOf(" ", SUMMARY_MAX);
    text = text.slice(0, cut > SUMMARY_MAX / 2 ? cut : SUMMARY_MAX).trimEnd();
  }
  return text;
}

const TAG_SHAPE = /^[\p{L}\p{N}][\p{L}\p{N} -]*$/u;

/** A few short lowercase tags the file does not already carry. */
export function cleanTags(raw: unknown, existing: readonly string[]): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const have = new Set(existing.map((tag) => tag.toLowerCase()));
  const kept: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") {
      continue;
    }
    const tag = item.trim().toLowerCase();
    if (!tag || tag.length > TAG_MAX_LENGTH || !TAG_SHAPE.test(tag) || isReservedTag(tag) || have.has(tag)) {
      continue;
    }
    have.add(tag);
    kept.push(tag);
    if (kept.length === MAX_TAGS) {
      break;
    }
  }
  return kept;
}

export { headChunk };

/** What a refusal means for the file: a stored reason, a pause of the
 * pass, or nothing (the file stays owed for a later attempt). */
export function outcomeFor(error: unknown): NoSummary | "paused" | null {
  // A reading whose dates are owed means for the file what its cause means.
  if (error instanceof FactsOwed) {
    return outcomeFor(error.cause);
  }
  if (!(error instanceof AssistantError)) {
    return null;
  }
  switch (error.code) {
    case "guardrail":
      return "declined";
    case "language":
      return "language";
    case "rate-limited":
    // The model is off, updating, busy or interrupted on this device, or
    // this build asked it wrongly: nothing about the file. No try is spent,
    // so a device whose model works still reads it.
    case "unavailable":
    case "preempted":
    case "cancelled":
    case "bad-request":
      return "paused";
    default:
      return null;
  }
}

export interface SummaryInput {
  text: string;
  name: string;
  categories: readonly string[];
  contextSize: number;
  /** Also say what the document's dates and amounts are. */
  withFacts?: boolean;
  /** The document is an email record: also ask what kind of email it is. */
  mail?: boolean;
  /** For an email: what it is about, who sent it and when it was written.
   * A date in it with no year is read against that day. */
  message?: { subject: string; from: string; writtenAt: number };
  /** For a stored file: the day it was kept. A date that was over by then is not asked about. */
  keptAt?: number;
  /** What the file's other readers already found: the model is asked only about the rest. */
  known?: readonly Fact[];
  signal?: AbortSignal;
}

/**
 * What a file brings to its reading beyond its text: for an email its
 * headers, for a stored file the day it was kept, and what its other
 * readers already found. `soFar` is what this same pass has read up to now
 * (a new upload's rules run moments before the model); it stands in for what
 * the file carried before the pass, so the model is never asked about a date
 * the rules have just read, and an email whose booking data was just read is
 * not asked for dates at all.
 */
export function readingContext(
  file: { mail?: { subject: string; from: string; date: number }; createdAt: number; facts: readonly Fact[] },
  opts: { mail: boolean; factsWanted: boolean; soFar?: readonly Fact[] },
): Pick<SummaryInput, "withFacts" | "mail" | "message" | "keptAt" | "known"> {
  const known = opts.soFar ?? file.facts;
  const message = opts.mail ? messageOf(file.mail) : undefined;
  return {
    mail: opts.mail,
    // An email whose dates came from its own booking data needs only the summary.
    withFacts: opts.factsWanted && !(opts.mail && known.some((fact) => fact.accepted === "exact")),
    ...(message ? { message } : {}),
    ...(!opts.mail && file.createdAt > 0 ? { keptAt: file.createdAt } : {}),
    known,
  };
}

/** What an email's headers add to its reading. An email with no readable
 * sending day adds nothing: a date with no year has no day to be counted from. */
export function messageOf(
  mail: { subject: string; from: string; date: number } | undefined,
): SummaryInput["message"] {
  return mail && mail.date > 0 ? { subject: mail.subject, from: mail.from, writtenAt: mail.date } : undefined;
}

export interface Summary {
  summary: string;
  tags: string[];
  kind?: string;
  /** What the document's dates and amounts are, as the model judged them:
   * unconfirmed; empty unless facts were asked for. */
  facts: Fact[];
  document?: DocumentKind;
  /** For an email: what kind of email it is. */
  mailKind?: MailKind;
}

type Runner = (request: GenerateRequest) => Promise<unknown>;

/**
 * The summary was read and the dates and amounts are still owed: the second
 * call met passing trouble (a deadline, a model that went away). It carries
 * the reading, so whoever counts the tries can keep the summary when the
 * last one is spent, and its cause, which says what the trouble means for
 * the file.
 */
export class FactsOwed extends Error {
  constructor(
    readonly reading: Summary,
    override readonly cause: unknown,
  ) {
    super("the summary was read; the dates and amounts are owed");
    this.name = "FactsOwed";
  }
}

/**
 * One reading. Resolves null when the model returned nothing usable;
 * rejects with the assistant's error when it refused. A window overflow
 * is retried once with half the text, then given up on. Trouble in the
 * second call rejects with FactsOwed, which holds the summary already read.
 */
export async function summarize(input: SummaryInput, run: Runner = generate): Promise<Summary | null> {
  const reading = await summaryOf(input, run);
  if (!reading || input.withFacts !== true) {
    return reading;
  }
  try {
    return { ...reading, facts: await judged(input, reading.document ?? "other", run) };
  } catch (error) {
    if (input.signal?.aborted) {
      throw error;
    }
    throw new FactsOwed({ ...reading, facts: [] }, error);
  }
}

async function summaryOf(input: SummaryInput, run: Runner): Promise<Summary | null> {
  let chunk = headChunk(input.text, input.contextSize);
  for (let attempt = 0; ; attempt += 1) {
    try {
      const raw = await run({ ...readingRequest(input, chunk), signal: input.signal });
      return readAnswer(raw, input.categories, input.withFacts === true, input.mail === true);
    } catch (error) {
      if (error instanceof AssistantError && error.code === "context-too-long" && attempt === 0) {
        chunk = chunk.slice(0, Math.floor(chunk.length / 2));
        continue;
      }
      throw error;
    }
  }
}

/**
 * What the document's dates and amounts are. Rules find them in the whole
 * text; the model is asked once what each one is, and only when there is
 * something to ask about. A refusal about the document (it declined, or
 * cannot read the language) leaves the summary standing with no facts.
 * Passing trouble fails the whole reading, so it is owed again and its try
 * is counted.
 */
async function judged(input: SummaryInput, document: DocumentKind, run: Runner): Promise<Fact[]> {
  const lexicon = await loadLexicon();
  const candidates = spotCandidates(input.text, input.message ? { writtenAt: input.message.writtenAt } : undefined, {
    ...(input.keptAt !== undefined ? { keptAt: input.keptAt } : {}),
    ...alreadyRead(input.known ?? []),
    // A form line whose date needs no reminder ("Statement date: ...") is
    // not put to the model either.
    ...(lexicon ? { skip: settledNowhere(input.text, lexicon) } : {}),
  });
  if (candidates.length === 0) {
    return [];
  }
  let contextSize = input.contextSize;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const request = judgeRequest({ name: input.name, text: input.text, contextSize, candidates, ...(input.message ? { mail: input.message } : {}) });
      const answer = await run({ ...request, signal: input.signal });
      return judgedFacts(answer, candidates, input.text, document);
    } catch (error) {
      if (error instanceof AssistantError && error.code === "context-too-long") {
        if (attempt === 0) {
          contextSize = Math.floor(contextSize / 2);
          continue;
        }
        // Too long with half the opening as well: the same request cannot
        // fit on a later try either. No facts, and the summary stands.
        return [];
      }
      const verdict = outcomeFor(error);
      if (verdict === "declined" || verdict === "language") {
        return [];
      }
      throw error;
    }
  }
}

type ReadingInput = Pick<SummaryInput, "name" | "categories" | "withFacts" | "mail">;

/** The request for one reading of this text, as the reader is sent it. */
function readingRequest(input: ReadingInput, chunk: string): GenerateRequest {
  const instructions =
    "You read a document and answer only with the requested structure. " +
    "The summary is one sentence, at most thirty words, in plain language, saying what the document is and what it is for. " +
    "Never include reference numbers, account numbers, or addresses. " +
    "Tags are short lowercase words for finding the document later. " +
    `The kind is one of: ${input.categories.join(", ")}.` +
    (input.withFacts ? " The document kind is one of the listed document kinds." : "") +
    (input.mail
      ? ` This document is an email. The mail kind is one of: ${MAIL_KINDS.join(", ")}; a newsletter or advertisement is "newsletter".`
      : "");
  return {
    instructions,
    prompt: `File name: ${input.name}\nOpening text:\n${chunk}`,
    priority: "background",
    schema: readingSchema(input.withFacts === true, input.mail === true),
    maxTokens: SUMMARY_TOKENS,
  };
}

/**
 * A short name for every request the reader can be sent: the instructions,
 * schemas and limits, for documents and mail, with and without dates.
 * Measured scores carry it, and count only while it is unchanged, so a
 * prompt edited without a re-measure never borrows the old prompt's trust.
 */
export function readingFingerprint(categories: readonly string[] = CATEGORIES): string {
  const variants = [false, true].flatMap((withFacts) =>
    [false, true].map((mail) => readingRequest({ name: "", categories, withFacts, mail }, "")),
  );
  // FNV-1a: a name for comparing, not a secret. The judge's request is part
  // of the reading, so its name is part of this one.
  let hash = 0x811c9dc5;
  for (const char of JSON.stringify([variants, judgeFingerprint()])) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function readAnswer(raw: unknown, categories: readonly string[], withFacts: boolean, mail: boolean): Summary | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const answer = raw as { summary?: unknown; tags?: unknown; kind?: unknown; document?: unknown; mailKind?: unknown };
  const summary = sanitizeSummary(typeof answer.summary === "string" ? answer.summary : undefined);
  if (!summary) {
    return null;
  }
  const tags = cleanTags(answer.tags, []);
  const kind =
    typeof answer.kind === "string" ? categories.find((c) => c.toLowerCase() === answer.kind!.toString().toLowerCase()) : undefined;
  const mailKind =
    mail && typeof answer.mailKind === "string" && (MAIL_KINDS as readonly string[]).includes(answer.mailKind)
      ? (answer.mailKind as MailKind)
      : undefined;
  const document =
    withFacts && typeof answer.document === "string" && (DOCUMENT_KINDS as readonly string[]).includes(answer.document)
      ? (answer.document as DocumentKind)
      : undefined;
  return { summary, tags, facts: [], ...(kind ? { kind } : {}), ...(document ? { document } : {}), ...(mailKind ? { mailKind } : {}) };
}
