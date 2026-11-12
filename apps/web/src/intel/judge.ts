/**
 * The on-device model as a judge of what a document's dates and amounts
 * are.
 *
 * Rules find the candidates (candidates.ts): every date with its clock,
 * every amount with its currency. The model is shown the document's opening
 * and each candidate in its own sentence, and answers with one word per
 * candidate from a fixed list. It never writes a value: a fact's date, time,
 * amount and currency are the candidate's, so a reading cannot be invented,
 * malformed, or lost to a check of its format. Only the label can be wrong,
 * and what comes of it asks before it counts, like every model reading.
 */
import type { GenerateRequest, JsonSchema, JsonSchemaProperty } from "./assistant";
import type { Candidate } from "./candidates";
import { documentLabel } from "./describe";
import { factId, isStated, type DocumentKind, type Fact, type FactKind } from "./facts";
import { MODEL_CONFIDENCE } from "./modelfacts";
import { cleanSubject, type Role } from "./subject";
import { headChunk } from "./summarize";

export const DATE_ANSWERS = ["event", "check-in", "check-out", "depart", "arrive", "due", "expiry", "issued", "other"] as const;
export const AMOUNT_ANSWERS = ["total", "other"] as const;
type DateAnswer = (typeof DATE_ANSWERS)[number];

const WORDS_MAX = 6;
const WORDS_CHARS = 60;
const CHARS_PER_TOKEN = 3;

const INSTRUCTIONS = [
  "You label dates and amounts that were already found in a document. You never write or change a date or an amount.",
  "For each date, answer with one of:",
  "event: something happens then that the reader takes part in (an appointment, a meeting, a show, a class, a delivery arriving).",
  "check-in: a stay begins then. check-out: a stay ends then.",
  "depart: a journey leaves then. arrive: a journey arrives then.",
  "due: the reader must pay or act by then, or money is taken then (a bill, a fine, a deadline, a renewal that charges, a book to return).",
  "expiry: something of the reader's stops being valid then (a passport, a licence, a warranty, a policy, a membership, a lease).",
  "issued: when the document itself was written, printed, sent or paid (a receipt's own date, the day a fine was issued, a letter's date).",
  "other: none of these, or not about the reader (a shop's sale or opening hours, an offer, someone else's date, an example).",
  "For an event, a check-in, a check-out, a departure or an arrival, also give the words: at most six words copied from the text that say what happens or where. Otherwise leave the words empty.",
  "For each amount, answer total (the whole amount paid, refunded or owed) or other (one item, a subtotal, a fee inside a total, a price in an offer).",
].join("\n");

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** A day as a person writes it, so the model need not work it out. */
function written(at: number): string {
  const day = new Date(at);
  return `${WEEKDAYS[day.getUTCDay()]} ${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]} ${day.getUTCFullYear()}`;
}

export interface JudgeInput {
  name: string;
  text: string;
  contextSize: number;
  candidates: Candidate[];
  /** For a message: what it is about, who sent it and when it was written. */
  mail?: { subject: string; from: string; writtenAt: number };
}

/** The request for one judging of a document's candidates. */
export function judgeRequest(input: JudgeInput): GenerateRequest {
  const listed = input.candidates.map((candidate) => `${candidate.key}: ${candidate.printed} in: ${candidate.sentence}`).join("\n");
  const properties: Record<string, JsonSchemaProperty> = {};
  const order: string[] = [];
  for (const candidate of input.candidates) {
    const date = candidate.what === "date";
    properties[candidate.key] = {
      type: "string",
      enum: date ? [...DATE_ANSWERS] : [...AMOUNT_ANSWERS],
      description: `What ${candidate.printed} is`,
    };
    order.push(candidate.key);
    if (date) {
      properties[`${candidate.key}w`] = { type: "string", description: "At most six words from the text saying what happens or where, or empty" };
      order.push(`${candidate.key}w`);
    }
  }
  const schema: JsonSchema = { type: "object", title: "Labels", properties, required: input.candidates.map((candidate) => candidate.key), order };
  const head = [
    `Document: ${input.name}`,
    ...(input.mail ? [`Subject: ${input.mail.subject}`, `From: ${input.mail.from}`, `Written: ${written(input.mail.writtenAt)}`] : []),
  ].join("\n");
  // The opening gives the candidates their setting; each candidate's own
  // sentence is listed whole, so the room they take comes off the opening.
  const taken = Math.ceil((listed.length + head.length) / CHARS_PER_TOKEN);
  const opening = headChunk(input.text, Math.max(1_024, input.contextSize - taken));
  const dates = input.candidates.filter((candidate) => candidate.what === "date").length;
  return {
    instructions: INSTRUCTIONS,
    prompt: `${head}\nOpening text:\n${opening}\n\nFound in the document:\n${listed}`,
    priority: "background",
    schema,
    temperature: 0,
    maxTokens: Math.min(400, 60 + 24 * dates + 8 * (input.candidates.length - dates)),
  };
}

/**
 * A short name for the judge as it is asked: its instructions, its lists
 * and its limits. Measured scores carry it, and count only while it is
 * unchanged.
 */
export function judgeFingerprint(): string {
  const sample = judgeRequest({ name: "", text: "", contextSize: 4096, candidates: [] });
  let hash = 0x811c9dc5;
  for (const char of JSON.stringify([sample.instructions, sample.prompt, DATE_ANSWERS, AMOUNT_ANSWERS, WORDS_MAX, WORDS_CHARS])) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

const capitalised = (words: string) => words.charAt(0).toUpperCase() + words.slice(1);

/** The model's words for a candidate, kept only when the text holds them. */
function wordsFor(raw: unknown, text: string): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const words = raw
    .replace(/\s+/g, " ")
    .replace(/^["'“”\s]+|["'“”\s.,;:!?]+$/g, "")
    .trim();
  if (!words || words.length > WORDS_CHARS || words.split(" ").length > WORDS_MAX || !isStated(words, text)) {
    return undefined;
  }
  return words;
}

/**
 * The facts a judging gives. Each is a candidate's own value under the
 * label the model chose; an answer for a key that is no candidate, or a word
 * outside the list, gives nothing. What survives is a model reading like any
 * other: unconfirmed, at the model's confidence, offered and never applied.
 */
export function judgedFacts(answer: unknown, candidates: readonly Candidate[], text: string, document: DocumentKind): Fact[] {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) {
    return [];
  }
  const said = answer as Record<string, unknown>;
  const byId = new Map<string, Fact>();
  const keep = (fact: Omit<Fact, "source" | "confidence" | "document">, candidate: Candidate) => {
    if (!byId.has(fact.id)) {
      byId.set(fact.id, {
        ...fact,
        document,
        ...(candidate.assumedYear ? { assumedYear: true } : {}),
        ...(candidate.ambiguous ? { ambiguous: true } : {}),
        source: "model",
        confidence: MODEL_CONFIDENCE,
      });
    }
  };
  for (const candidate of candidates) {
    const label = said[candidate.key];
    if (candidate.what === "amount") {
      if (label === "total" && candidate.unit) {
        keep({ id: factId("amount", candidate.value), kind: "amount", value: candidate.value, unit: candidate.unit, label: "Total" }, candidate);
      }
      continue;
    }
    if (typeof label !== "string" || !(DATE_ANSWERS as readonly string[]).includes(label) || label === "other") {
      continue;
    }
    const kind = label as Exclude<DateAnswer, "other">;
    const words = wordsFor(said[`${candidate.key}w`], text);
    if (kind === "due" || kind === "expiry" || kind === "issued") {
      keep({ id: factId(kind as FactKind, candidate.value), kind: kind as FactKind, value: candidate.value, ...(words ? { label: capitalised(words) } : {}) }, candidate);
      continue;
    }
    // A moment: named by what it is, with the place or the happening the
    // text states. The label joins the identity, as for every event.
    const name =
      kind === "event"
        ? capitalised(words ?? documentLabel(document))
        : kind === "check-in" || kind === "check-out"
          ? `${capitalised(kind)}${words ? `: ${words}` : ""}`
          : `${kind === "depart" ? "Departs" : "Arrives"}${words ? ` ${words}` : ""}`;
    const subject = kind === "event" ? undefined : cleanSubject({ role: kind as Role, ...(words ? { place: words } : {}) });
    keep(
      {
        id: factId("event", `${candidate.value} ${name.toLowerCase()}${candidate.time ? ` ${candidate.time}` : ""}`),
        kind: "event",
        value: candidate.value,
        label: name,
        ...(candidate.time ? { time: candidate.time } : {}),
        ...(subject ? { subject } : {}),
      },
      candidate,
    );
  }
  return [...byId.values()];
}
