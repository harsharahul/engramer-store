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
import { findDates, findTimes } from "./dates";
import { factId, isStated, type DocumentKind, type Fact } from "./facts";
import { MODEL_CONFIDENCE } from "./modelfacts";
import { cleanSubject, journeyRole, placeNamed, type Role } from "./subject";
import { CHARS_PER_TOKEN, headChunk } from "./window";

/** What a date can be. An issue day is not among them: the label rules read
 * the ones a document names, and in running words it is one more way to be
 * wrong about a date that is nobody's business. */
export const DATE_ANSWERS = ["event", "check-in", "check-out", "depart", "arrive", "due", "expiry", "other"] as const;
/** The answer when no amount found is the document's total. */
export const NO_TOTAL = "none";
type DateAnswer = (typeof DATE_ANSWERS)[number];

const WORDS_MAX = 6;
const WORDS_CHARS = 60;

const INSTRUCTIONS = [
  "You are given a document and a list of dates and amounts found in it. You say what each one is. You never write or change a date or an amount.",
  "Most dates in a document are not the reader's business. Answer other unless the text clearly gives the date one of these meanings:",
  "event: the reader takes part in something or receives something that day (an appointment, a meeting, a class, a show, a parcel arriving).",
  "check-in: the reader's stay begins. check-out: the reader's stay ends.",
  "depart: the reader's journey leaves. arrive: the reader's journey arrives.",
  "due: the reader must pay or act by that day, or money is taken that day (a bill, a fine, a deadline, a form to return, a renewal that charges).",
  "expiry: something of the reader's stops being valid that day (a passport, a licence, a warranty, a policy, a membership, a lease).",
  "other: everything else. The day the message or document was written, printed, sent or issued. The day something was ordered, booked, bought, paid, received or last visited. A statement date or a billing period. Opening hours and closures. A sale, an offer or a new price. A date for the public or for someone else.",
  "Words: for an event, at most six words copied from the text that say what happens (dental check-up). For a check-in, a check-out, a departure or an arrival, the name of the place only (Casa Azulejo, SFO). Never a date or a time. Otherwise empty.",
  "Pays: yes when the document states one whole amount the reader paid or has to pay (a bill, a receipt, the total of a booking, the price of a renewal, a refund). No for everything else: a price in an offer, a fee that may apply, an estimate, an account balance, points, a salary, or only the parts of a total.",
  "The total: when pays is yes, which one of the amounts is that whole amount.",
  "Examples.",
  "Your statement dated 5 April is ready. Pay the balance by 28 April. 5 April is other. 28 April is due.",
  "You ordered on 8 March. Your sofa will arrive on 6 April. 8 March is other. 6 April is event.",
  "Subtotal 21.50, tax 1.72, total paid 23.22. The total is 23.22.",
  "The sale runs until 31 March. 31 March is other.",
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
  const dated = input.candidates.filter((candidate) => candidate.what === "date");
  const amounts = input.candidates.filter((candidate) => candidate.what === "amount");
  for (const candidate of dated) {
    properties[candidate.key] = { type: "string", enum: [...DATE_ANSWERS], description: `What ${candidate.printed} is` };
    properties[`${candidate.key}w`] = { type: "string", description: "What happens, or the place, in at most six words from the text; or empty" };
    order.push(candidate.key, `${candidate.key}w`);
  }
  // First a plain yes or no: does the document state a whole amount at all.
  // Asked to choose, the model always chooses; asked yes or no first, it can
  // say no. Then one question for all the amounts: a document is about one
  // total, so the model compares them and two can never both be it.
  if (amounts.length > 0) {
    properties["pays"] = { type: "string", enum: ["yes", "no"], description: "Does the document state one whole amount the reader paid or has to pay" };
    properties["total"] = { type: "string", enum: [...amounts.map((candidate) => candidate.key), NO_TOTAL], description: "Which amount is the total, or none" };
    order.push("pays", "total");
  }
  const required = [...dated.map((candidate) => candidate.key), ...(amounts.length > 0 ? ["pays", "total"] : [])];
  const schema: JsonSchema = { type: "object", title: "Labels", properties, required, order };
  const head = [
    `Document: ${input.name}`,
    ...(input.mail ? [`Subject: ${input.mail.subject}`, `From: ${input.mail.from}`, `Written: ${written(input.mail.writtenAt)}`] : []),
  ].join("\n");
  // The opening gives the candidates their setting; each candidate's own
  // sentence is listed whole, so the room they and the instructions take
  // comes off the opening.
  const taken = Math.ceil((listed.length + head.length + INSTRUCTIONS.length) / CHARS_PER_TOKEN);
  const opening = headChunk(input.text, Math.max(1_024, input.contextSize - taken));
  return {
    instructions: INSTRUCTIONS,
    prompt: `${head}\nOpening text:\n${opening}\n\nFound in the document:\n${listed}`,
    priority: "background",
    schema,
    temperature: 0,
    maxTokens: Math.min(400, 60 + 24 * dated.length + (amounts.length > 0 ? 16 : 0)),
  };
}

/**
 * The judge's request for one fixed document that holds a date and an
 * amount, so every part of the request has its place in it: instructions,
 * the listing, each kind of question the schema asks, and the answer budget.
 */
export function judgeSample(): GenerateRequest {
  const date: Candidate = { key: "d1", what: "date", value: "2027-01-01", printed: "1 January 2027", sentence: "It is on 1 January 2027." };
  const amount: Candidate = { key: "a1", what: "amount", value: "1.00", unit: "USD", printed: "USD 1.00", sentence: "The total is USD 1.00." };
  return judgeRequest({ name: "", text: "", contextSize: 4096, candidates: [date, amount] });
}

/** A short name for a request as it is sent, whole. */
export function fingerprintOf(request: GenerateRequest): string {
  let hash = 0x811c9dc5;
  for (const char of JSON.stringify([request.instructions, request.prompt, request.schema, request.maxTokens, request.temperature, WORDS_MAX, WORDS_CHARS])) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * A short name for the judge as it is asked: its instructions, its lists,
 * what its schema says and its limits. Measured scores carry it, and count
 * only while it is unchanged.
 */
export function judgeFingerprint(): string {
  return fingerprintOf(judgeSample());
}

const capitalised = (words: string) => words.charAt(0).toUpperCase() + words.slice(1);

/** Any day will do: only whether the words hold a date matters, a year or none. */
const ANY_DAY = { writtenAt: Date.UTC(2000, 0, 1) };

/**
 * The model's words for a candidate, kept only when the text holds them and
 * they name something. A date or a clock is the candidate's own and never
 * part of its name; for a stay or a journey the words are the place, so a
 * phrase that still holds the answer's own word ("Flight UA 123 departs
 * SFO") is not one.
 */
function wordsFor(raw: unknown, text: string, place: boolean): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const said = raw
    .replace(/\s+/g, " ")
    .replace(/^["'“”\s]+|["'“”\s.,;:!?]+$/g, "")
    .trim();
  const words = place ? placeNamed(said) : said;
  if (!words || words.length > WORDS_CHARS || words.split(" ").length > WORDS_MAX || !isStated(words, text)) {
    return undefined;
  }
  if (findDates(words, ANY_DAY).length > 0 || findTimes(words).length > 0) {
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
        ...(candidate.relative ? { relative: true } : {}),
        source: "model",
        confidence: MODEL_CONFIDENCE,
      });
    }
  };
  for (const candidate of candidates.filter((found) => found.what === "date")) {
    // The model's answer for this candidate: a word from its own list, not a fact's label.
    const verdict = said[candidate.key];
    if (typeof verdict !== "string" || !(DATE_ANSWERS as readonly string[]).includes(verdict) || verdict === "other") {
      continue;
    }
    const answered = verdict as Exclude<DateAnswer, "other">;
    if (answered === "due" || answered === "expiry") {
      keep({ id: factId(answered, candidate.value), kind: answered, value: candidate.value }, candidate);
      continue;
    }
    // A journey's end needs its own word in the candidate's sentence: a
    // model that calls a show an arrival is caught by the sentence, and the
    // date stays a plain event.
    const kind = answered === "depart" || answered === "arrive" ? (journeyRole(answered, candidate.sentence) ?? "event") : answered;
    // A moment: named by what it is, with the place or the happening the
    // text states. The label joins the identity, as for every event. A
    // moment the model found no words for carries none: the screen names it
    // by its document, and nothing is made up here.
    const words = wordsFor(said[`${candidate.key}w`], text, kind !== "event");
    const name =
      kind === "event"
        ? words && capitalised(words)
        : kind === "check-in" || kind === "check-out"
          ? `${capitalised(kind)}${words ? `: ${words}` : ""}`
          : `${kind === "depart" ? "Departs" : "Arrives"}${words ? ` ${words}` : ""}`;
    const subject = kind === "event" ? undefined : cleanSubject({ role: kind as Role, ...(words ? { place: words } : {}) });
    keep(
      {
        id: factId("event", [candidate.value, name?.toLowerCase(), candidate.time].filter(Boolean).join(" ")),
        kind: "event",
        value: candidate.value,
        ...(name ? { label: name } : {}),
        ...(candidate.time ? { time: candidate.time } : {}),
        ...(subject ? { subject } : {}),
      },
      candidate,
    );
  }
  // The total is one of the amounts, named by its key, and only when the
  // model first said the document states one.
  const total = said["pays"] === "yes" ? candidates.find((found) => found.what === "amount" && found.key === said["total"]) : undefined;
  if (total?.unit) {
    keep({ id: factId("amount", total.value), kind: "amount", value: total.value, unit: total.unit, label: "Total" }, total);
  }
  return [...byId.values()];
}
