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
import {
  factId,
  groundFacts,
  maskTail,
  mergeFacts,
  type Fact,
  type FactEvidence,
} from "./facts";
import { harvestFacts, labelledFacts, structuralDatedFacts } from "./labels";
import { mrzFacts } from "./mrz";
import { reservationFacts } from "./reservation";

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
    found.push(...reservationFacts(input.raw));
  }

  const text = input.text ?? "";
  if (text) {
    found.push(...mrzFacts(text));
    const typed = labelledFacts(text);
    found.push(...typed);
    // Labels the vocabulary knows are typed; every other labelled date still
    // surfaces with the document's own words attached. Values already
    // claimed by a typed fact are skipped so nothing appears twice.
    found.push(...structuralDatedFacts(text, new Set(typed.map((fact) => fact.value))));
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
  for (const fact of kept) {
    if (fact.kind !== "identifier") {
      facts.push(fact);
      continue;
    }
    // Redacted only now, after grounding and merging have had the real value.
    // The identity is rebuilt from the tail too, because an id is stored in
    // metadata and one built from the whole number would put it right back.
    const tail = maskTail(fact.value);
    const id = factId("identifier", tail);
    facts.push({ ...fact, id, value: tail, masked: tail });
    evidence.push({ id, full: fact.value });
  }
  return { facts, evidence, decoded };
}
