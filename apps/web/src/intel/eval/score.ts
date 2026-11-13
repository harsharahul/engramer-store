/**
 * Scoring a reader against the synthetic eval set, per task.
 *
 * A reader's measured precision is what decides whether its readings may
 * count without the owner's yes: only where it is at least 98% (spec 3.14).
 * Precision counts every reading the reader offered for the task; recall
 * counts every fact the case says is there. A reader that offers nothing is
 * not wrong, only incomplete.
 */

import { isDated, offeredFacts, type Fact, type FactKind } from "../facts";
import { EMAIL_MIME } from "../../mail/kind";
import { subjectOf, type Role } from "../subject";

export interface EvalCase {
  id: string;
  name: string;
  mime: string;
  text: string;
  /** The document as written, when it carries structured data (HTML, an invite). */
  raw?: string;
  /** Who sent a message, as its header names them. */
  from?: string;
  /** When a message was written: what a date in it with no year is read against. */
  writtenAt?: number;
  /** What a good reader finds: the time only where the document gives one. */
  expected: { kind: FactKind; value: string; time?: string; label?: string; role?: Role }[];
  /** The kind of email this is, for the mail-kind task. */
  mailKind?: string;
  /** Every expected fact is stated in structured data, so exact readers find them all. */
  exact?: boolean;
}

export type EvalTask = "dates" | "amounts";

const TASK_KINDS: Record<EvalTask, ReadonlySet<FactKind>> = {
  dates: new Set(["expiry", "due", "issued", "event", "dated", "period"]),
  amounts: new Set(["amount"]),
};

export interface CaseScore {
  id: string;
  found: number;
  missed: number;
  extra: number;
}

export interface ReaderScore {
  precision: number;
  recall: number;
  perCase: CaseScore[];
}

function matches(fact: Fact, expected: EvalCase["expected"][number]): boolean {
  if (fact.kind !== expected.kind || fact.value !== expected.value) {
    return false;
  }
  return expected.time === undefined || fact.time === expected.time;
}

export async function scoreReader(
  cases: readonly EvalCase[],
  read: (evalCase: EvalCase) => Promise<Fact[]>,
  task: EvalTask,
): Promise<ReaderScore> {
  const kinds = TASK_KINDS[task];
  const perCase: CaseScore[] = [];
  for (const evalCase of cases) {
    const wanted = evalCase.expected.filter((fact) => kinds.has(fact.kind));
    const offered = (await read(evalCase)).filter((fact) => kinds.has(fact.kind));
    const used = new Set<number>();
    let found = 0;
    for (const fact of offered) {
      const at = wanted.findIndex((expected, i) => !used.has(i) && matches(fact, expected));
      if (at >= 0) {
        used.add(at);
        found++;
      }
    }
    perCase.push({ id: evalCase.id, found, missed: wanted.length - found, extra: offered.length - found });
  }
  const found = perCase.reduce((sum, c) => sum + c.found, 0);
  const extra = perCase.reduce((sum, c) => sum + c.extra, 0);
  const missed = perCase.reduce((sum, c) => sum + c.missed, 0);
  return {
    precision: found + extra === 0 ? 1 : found / (found + extra),
    recall: found + missed === 0 ? 1 : found / (found + missed),
    perCase,
  };
}

/**
 * How often a reader says rightly what a date is, over the dates it found
 * whose expected role the case names. The role is read as the app reads it,
 * through subjectOf, so a label that already says "Check-in" counts.
 */
export async function scoreRoles(
  cases: readonly EvalCase[],
  read: (evalCase: EvalCase) => Promise<Fact[]>,
): Promise<{ precision: number; recall: number; offered: number; expected: number }> {
  let right = 0;
  let offered = 0;
  let expected = 0;
  for (const evalCase of cases) {
    const wanted = evalCase.expected.filter((fact) => fact.role !== undefined);
    expected += wanted.length;
    if (wanted.length === 0) {
      continue;
    }
    const used = new Set<number>();
    for (const fact of await read(evalCase)) {
      const at = wanted.findIndex((want, i) => !used.has(i) && matches(fact, want));
      const role = subjectOf(fact)?.role;
      if (at < 0 || role === undefined) {
        continue;
      }
      used.add(at);
      offered++;
      if (role === wanted[at]!.role) {
        right++;
      }
    }
  }
  return {
    precision: offered === 0 ? 1 : right / offered,
    recall: expected === 0 ? 1 : right / expected,
    offered,
    expected,
  };
}

export interface NoiseScore {
  /** Documents that state nothing for the reader. */
  cases: number;
  /** How many of them the reader offered something for. */
  loud: number;
  /** Everything it offered for them. */
  offered: number;
  /** The share of them that got an offer: each one is a question the owner should never see. */
  rate: number;
}

/** What a reader offers for documents that state nothing: dates and amounts alike. */
export async function scoreNoise(cases: readonly EvalCase[], read: (evalCase: EvalCase) => Promise<Fact[]>): Promise<NoiseScore> {
  const empty = cases.filter((evalCase) => evalCase.expected.length === 0);
  let loud = 0;
  let offered = 0;
  for (const evalCase of empty) {
    const facts = (await read(evalCase)).filter((fact) => TASK_KINDS.dates.has(fact.kind) || TASK_KINDS.amounts.has(fact.kind));
    offered += facts.length;
    loud += facts.length > 0 ? 1 : 0;
  }
  return { cases: empty.length, loud, offered, rate: empty.length === 0 ? 0 : loud / empty.length };
}

export type ErrorClass = "named-only line" | "wrong meaning" | "clock missing" | "part for the total" | "not the reader's business" | "missed";

const ERROR_CLASSES: readonly ErrorClass[] = ["named-only line", "wrong meaning", "clock missing", "part for the total", "not the reader's business", "missed"];

/**
 * What kind of error each wrong reading is, so the work goes where the
 * errors are. A reading that matches nothing the case expects falls in one
 * class, tried in this order: a form line that only names a date; the right
 * day under another meaning; the right day and meaning with another clock or
 * none; an amount; else a day that is nobody's business. An expected fact
 * that no reading found, rightly or wrongly, is missed.
 */
export async function errorsByClass(
  cases: readonly EvalCase[],
  read: (evalCase: EvalCase) => Promise<Fact[]>,
): Promise<Record<ErrorClass, { count: number; cases: string[] }>> {
  const classes = Object.fromEntries(ERROR_CLASSES.map((name) => [name, { count: 0, cases: [] as string[] }])) as Record<
    ErrorClass,
    { count: number; cases: string[] }
  >;
  const note = (name: ErrorClass, id: string) => {
    classes[name].count++;
    if (!classes[name].cases.includes(id)) {
      classes[name].cases.push(id);
    }
  };
  const scored = (kind: FactKind) => TASK_KINDS.dates.has(kind) || TASK_KINDS.amounts.has(kind);
  for (const evalCase of cases) {
    const facts = (await read(evalCase)).filter((fact) => scored(fact.kind));
    // An expected fact a reading found under another meaning or clock is explained, not missed.
    const explained = new Set<number>();
    for (const fact of facts) {
      if (evalCase.expected.some((expected) => matches(fact, expected))) {
        continue;
      }
      const sameDay = evalCase.expected.findIndex((expected) => expected.kind !== "amount" && expected.value === fact.value);
      if (fact.kind === "dated" || fact.kind === "period") {
        note("named-only line", evalCase.id);
      } else if (fact.kind === "amount") {
        note("part for the total", evalCase.id);
      } else if (sameDay >= 0 && evalCase.expected[sameDay]!.kind !== fact.kind) {
        explained.add(sameDay);
        note("wrong meaning", evalCase.id);
      } else if (sameDay >= 0) {
        explained.add(sameDay);
        note("clock missing", evalCase.id);
      } else {
        note("not the reader's business", evalCase.id);
      }
    }
    evalCase.expected.forEach((expected, index) => {
      if (!explained.has(index) && !facts.some((fact) => matches(fact, expected))) {
        note("missed", evalCase.id);
      }
    });
  }
  return classes;
}

export interface AskedScore {
  documents: number;
  /** Readings the app would ask the reader about on the day the document reached them. */
  asked: number;
  /** Of those: a day the document does not state for the reader, or the right day under the wrong meaning. */
  wrong: number;
  /** Of those: a line that only names a date, on a day the reader does care about. */
  untyped: number;
  askedPer100: number;
  wrongPer100: number;
}

const per100 = (count: number, documents: number) => (documents === 0 ? 0 : Math.round((count * 1000) / documents) / 10);

/**
 * The questions a person would be shown. A question is counted the way the
 * app asks it (`offeredFacts`: unanswered, a date, still ahead or lately
 * behind), on the day each document reached its reader, so the number means
 * the same thing here as on the screen.
 */
export async function scoreAsked(
  cases: readonly EvalCase[],
  read: (evalCase: EvalCase) => Promise<Fact[]>,
  dayOf: (evalCase: EvalCase) => number,
): Promise<AskedScore> {
  let asked = 0;
  let wrong = 0;
  let untyped = 0;
  for (const evalCase of cases) {
    const file = { id: evalCase.id, trashed: false, facts: await read(evalCase) };
    for (const { fact } of offeredFacts([file], dayOf(evalCase))) {
      if (!isDated(fact)) {
        continue;
      }
      asked++;
      if (evalCase.expected.some((expected) => matches(fact, expected))) {
        continue;
      }
      const dayExpected = evalCase.expected.some((expected) => expected.kind !== "amount" && expected.value === fact.value);
      if (fact.kind === "dated" && dayExpected) {
        untyped++;
      } else {
        wrong++;
      }
    }
  }
  return { documents: cases.length, asked, wrong, untyped, askedPer100: per100(asked, cases.length), wrongPer100: per100(wrong, cases.length) };
}

export interface Measured {
  precision: number;
  recall: number;
  /** The readings each figure rests on: a precision over a handful says nothing. */
  offered: number;
  expected: number;
}

export interface SetFigures {
  dates: Measured;
  amounts: Measured;
  roles: Measured;
  noise: NoiseScore;
  /** The questions a person would be shown, counted on the day each document reached them. */
  asked: AskedScore;
  /** Each case that missed or added something, dates and amounts together. */
  wrong: CaseScore[];
}

/**
 * One set's figures for a reader, over the cases the app asks it for dates
 * and amounts. `dayOf` is the day a document reached its reader: the day a
 * message was sent, or a file was kept.
 */
export async function measure(
  cases: readonly EvalCase[],
  read: (evalCase: EvalCase) => Promise<Fact[]>,
  dayOf: (evalCase: EvalCase) => number,
): Promise<SetFigures> {
  const asked = factCases(cases);
  const figures = (score: ReaderScore): Measured => ({
    precision: score.precision,
    recall: score.recall,
    offered: score.perCase.reduce((sum, c) => sum + c.found + c.extra, 0),
    expected: score.perCase.reduce((sum, c) => sum + c.found + c.missed, 0),
  });
  const dates = await scoreReader(asked, read, "dates");
  const amounts = await scoreReader(asked, read, "amounts");
  const wrong = dates.perCase
    .map((date, i) => {
      const amount = amounts.perCase[i]!;
      return { id: date.id, found: date.found + amount.found, missed: date.missed + amount.missed, extra: date.extra + amount.extra };
    })
    .filter((c) => c.missed > 0 || c.extra > 0);
  return {
    dates: figures(dates),
    amounts: figures(amounts),
    roles: await scoreRoles(asked, read),
    noise: await scoreNoise(asked, read),
    asked: await scoreAsked(asked, read, dayOf),
    wrong,
  };
}

/** Cases the app asks a model for dates and amounts: all but mail that states them as data. */
export function factCases(cases: readonly EvalCase[]): EvalCase[] {
  return cases.filter((evalCase) => !(evalCase.exact && evalCase.mime === EMAIL_MIME));
}

/** Cases the app asks a model to name the kind of: every email, booking mail too. */
export function kindCases(cases: readonly EvalCase[]): EvalCase[] {
  return cases.filter((evalCase) => evalCase.mime === EMAIL_MIME);
}

export interface KindScore {
  accuracy: number;
  cases: number;
  /** Per kind named: how often it was right when the classifier named it. */
  byKind: Record<string, { precision: number; offered: number }>;
}

/** How often a classifier names an email's kind right, over cases that say. */
export async function scoreKinds(
  cases: readonly EvalCase[],
  classify: (evalCase: EvalCase) => Promise<string | null>,
): Promise<KindScore> {
  const labelled = cases.filter((evalCase) => evalCase.mailKind !== undefined);
  const named = new Map<string, { right: number; offered: number }>();
  let right = 0;
  for (const evalCase of labelled) {
    const kind = await classify(evalCase);
    if (kind === null) {
      continue;
    }
    const tally = named.get(kind) ?? { right: 0, offered: 0 };
    tally.offered++;
    if (kind === evalCase.mailKind) {
      tally.right++;
      right++;
    }
    named.set(kind, tally);
  }
  const byKind: KindScore["byKind"] = {};
  for (const [kind, tally] of named) {
    byKind[kind] = { precision: tally.right / tally.offered, offered: tally.offered };
  }
  return { accuracy: labelled.length === 0 ? 1 : right / labelled.length, cases: labelled.length, byKind };
}
