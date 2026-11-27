/**
 * Running every reader over one document and deciding what to keep.
 *
 * The pure modules each know one format. This is where they meet: structured
 * sources first because they are exact, then labelled text, then generic
 * harvesting, then a single grounding pass over everything the document
 * actually said. Whatever survives is split into the summary that rides in
 * metadata and the evidence that stays in the index blob.
 *
 * The split is the part worth reading twice. A reference number is grounded
 * and merged at full length, because that is what makes it checkable, and only
 * then reduced to its last four characters for storage. Metadata is decrypted
 * on every device on every sync and held all session; the whole number is not
 * something to keep there, and neither is a fact identity derived from it.
 */

import { settingChanged } from "../settingsbus";
import { aamvaFacts } from "./aamva";
import { readSymbols } from "./barcode";
import { bcbpFacts } from "./bcbp";
import { ruleAcceptance, ruleScores, type RuleRecord } from "./rulerecord";
import {
  factId,
  groundFacts,
  maskTail,
  mergeFacts,
  withExactAcceptance,
  type Fact,
  type FactEvidence,
  type ReadFact,
} from "./facts";
import { harvestFacts, labelledFacts, structuralDatedFacts } from "./labels";
import { loadLexicon } from "./lexicon";
import { mrzFacts } from "./mrz";
import { structuredDataFacts } from "./reservation";
import { withoutZones, zonesOf } from "./zones";
import { icsFacts } from "./icsread";

const PREF_KEY = "engram-facts";

export function factsEnabled(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) === "1";
  } catch {
    return false;
  }
}

export function setFactsEnabled(on: boolean): void {
  try {
    localStorage.setItem(PREF_KEY, on ? "1" : "0");
    settingChanged();
  } catch {
    // Preference persistence is best-effort.
  }
}

export interface ScanInput {
  name: string;
  mime: string;
  /** Text already extracted from the document, if any. */
  text?: string;
  /** The document as written, when its format carries structured data that
   * text extraction strips: saved confirmation pages and emails. */
  raw?: string;
  /** Image bytes worth attempting a barcode read on. The caller chooses:
   * an image as it is, or a PDF's first page rendered at real resolution. */
  file?: Blob;
  /** When the document was stored; anchors inferences like a flight's year. */
  storedAt?: number;
  /**
   * When a message was written, from its own date. Set for mail only: a
   * date with no year ("Thursday, November 12") is read against it, and in
   * any other file such a date is not read at all.
   */
  writtenAt?: number;
  /**
   * The label rules' measured record, which says what a rule's reading may
   * count as without a yes. The record this build ships, unless given.
   */
  rules?: RuleRecord;
}

export interface ScanResult {
  /** Summaries, for encrypted metadata. Never carries a full identifier. */
  facts: Fact[];
  /** The half that stays in the index blob. */
  evidence: FactEvidence[];
  /**
   * Payloads decoded from barcodes, to join the searchable text. This is the
   * half of barcode reading that needs no parser: a booking reference or a
   * confirmation code becomes findable simply by being readable at all.
   */
  decoded: string[];
}

/** Reads everything this document has to say, and grounds all of it. */
export async function scanForFacts(input: ScanInput): Promise<ScanResult> {
  const decoded: string[] = [];
  const found: Fact[] = [];

  // Machine-encoded first: exact, and it can settle what the printed text can
  // only suggest.
  if (input.file) {
    for (const symbol of await readSymbols(input.file)) {
      decoded.push(symbol.text);
      found.push(...aamvaFacts(symbol.text));
      found.push(...bcbpFacts(symbol.text, input.storedAt ?? Date.now()));
    }
  }
  // A reservation the document states about itself is the same tier: exact,
  // and exempt from prose grounding for the same reason barcodes are.
  if (input.raw) {
    found.push(...structuredDataFacts(input.raw));
    // A calendar invite is the same tier: the sender's calendar speaking.
    if (input.mime === "text/calendar" || /\.ics$/i.test(input.name)) {
      found.push(...icsFacts(input.raw));
    }
  }

  // In a message, what it quotes and its footer are not its own words, and
  // no rule reads them. A message it forwards is read (a booking forwarded
  // to oneself). The places of the text stay true: the parts are blanked.
  const whole = input.text ?? "";
  const zones = input.writtenAt !== undefined && whole ? zonesOf(whole) : undefined;
  const text = zones ? withoutZones(whole, [...zones.quoted, ...(zones.footer ? [zones.footer] : [])]) : whole;
  if (text) {
    found.push(...mrzFacts(text));
    // What a form line's label means, from the shipped table. With no table
    // every line is read with its own words.
    const lexicon = await loadLexicon();
    const typed = labelledFacts(text, input.writtenAt, lexicon);
    // A form line is read by its label: the table types it, or says it is
    // nobody's business, and a label it does not hold still surfaces with
    // the document's own words attached. Values already claimed by a typed
    // fact are skipped so nothing appears twice.
    const labelled = [
      ...typed,
      ...structuralDatedFacts(text, new Set(typed.map((fact) => fact.value)), {
        ...(lexicon ? { lexicon } : {}),
        ...(input.writtenAt !== undefined ? { writtenAt: input.writtenAt } : {}),
      }),
    ];
    // A day of issue says how old a document is that runs out, or that only
    // states it (a certificate). On a bill, a ticket or a timetable it is
    // the day the paper was made, and nobody's business.
    const runsOut = labelled.some((fact) => fact.kind === "expiry");
    const happens = labelled.some((fact) => fact.kind === "due" || fact.kind === "event");
    found.push(...labelled.filter((fact) => fact.kind !== "issued" || runsOut || !happens));
    found.push(...harvestFacts(text));
  }
  if (found.length === 0) {
    return { facts: [], evidence: [], decoded };
  }

  // Grounded against everything the document said, decoded payloads included:
  // a value read out of a barcode is part of what the document contains.
  const source = [text, ...decoded].join("\n");
  const merged = mergeFacts([], groundFacts(found, source));

  // A reservation block and the printed text often state the same moment.
  // One statement is enough: where a structured source and a text reading
  // agree on the date and clock, the text reading is the echo and drops.
  const soft = (fact: Fact) =>
    fact.source === "label" || fact.source === "pattern" || fact.source === "model";
  const structuredMoments = new Set(
    merged
      .filter((fact) => fact.kind === "event" && !soft(fact))
      .flatMap((fact) => [`${fact.value}|${fact.time ?? ""}`, `${fact.value}|`]),
  );
  const kept = merged.filter(
    (fact) =>
      !(
        fact.kind === "event" &&
        soft(fact) &&
        structuredMoments.has(`${fact.value}|${fact.time ?? ""}`)
      ),
  );

  const facts: Fact[] = [];
  const evidence: FactEvidence[] = [];
  for (const read of kept) {
    // A sender's link can carry the reference and a name, so it goes to the
    // evidence blob and never rides in synced metadata.
    const { link, ...fact } = read as ReadFact;
    if (link) {
      evidence.push({ id: fact.id, link });
    }
    if (fact.kind !== "identifier") {
      facts.push(withExactAcceptance(fact));
      continue;
    }
    // Redacted only now, after grounding and merging have had the real value.
    // The identity is rebuilt from the tail too, because an id is stored in
    // metadata and one built from the whole number would put it right back.
    const tail = maskTail(fact.value);
    const id = factId("identifier", tail);
    facts.push(withExactAcceptance({ ...fact, id, value: tail, masked: tail }));
    evidence.push({ id, full: fact.value });
  }
  // A label rule's reading counts as it is read where it is plain and the
  // rules' measured record trusts that kind (rulerecord.ts): a mail's one
  // day to pay. Judged here, among everything the scan read, so every path
  // that scans a file gives the same answer.
  const rules = input.rules ?? ruleScores();
  const written = input.writtenAt !== undefined ? { written: input.writtenAt } : {};
  const counted = facts.map((fact) =>
    fact.accepted === undefined && ruleAcceptance(fact, { rules, siblings: facts, ...written }) === "grounded"
      ? { ...fact, accepted: "grounded" as const }
      : fact,
  );
  return { facts: counted, evidence, decoded };
}
