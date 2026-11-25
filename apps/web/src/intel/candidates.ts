/**
 * What a document holds that could be a fact: every date, with the clock
 * that stands beside it, and every amount with its currency.
 *
 * Rules find these, in the whole text, so a value is never a reader's
 * guess. What each one is (an event, a due date, the total) is a separate
 * question, asked of a reader that can only answer from a fixed list. The
 * list here is short on purpose: a statement with a hundred dated lines
 * must not become a hundred questions.
 */
import { findDates, findRelativeDays, findTimes, type DateContext, type FoundDate } from "./dates";
import { clockLineTime, moneyEvery } from "./labels";

export interface Candidate {
  /** "d1".."d10" for dates, "a1".."a6" for amounts: the name a reader answers by. */
  key: string;
  what: "date" | "amount";
  /** YYYY-MM-DD, or a plain decimal. */
  value: string;
  /** HH:MM, when a clock stands with the date. */
  time?: string;
  /** An amount's currency. */
  unit?: string;
  /** The text printed no year; this is the next such day after it was written. */
  assumedYear?: true;
  /** The date could be read two ways. */
  ambiguous?: true;
  /** A day said in words ("tomorrow", "this Saturday"), read against the day the message was sent. */
  relative?: true;
  /** As the text prints it. */
  printed: string;
  /** The sentence it stands in, at most 200 characters. */
  sentence: string;
}

const MAX_DATES = 10;
const MAX_AMOUNTS = 6;
/** A date in a table of times is the day of each; two are enough to say what the day is. */
const CLOCKS_PER_DATE = 2;
const SENTENCE_MAX = 200;
/** Words that mark the amount a document is about, before its line items. */
const SUM_LINE = /\b(?:total|due|balance|paid|charged|refund(?:ed)?|fare|price|premium)\b/i;
/** A sentence ends at a line's end, or at a full stop before a new start. */
const SENTENCE_END = /\n+|[.!?]\s+(?=[A-Z0-9"'(])/g;

interface Span {
  at: number;
  end: number;
}

/** The sentences of a text as spans, none of them cutting through a date ("Nov. 12" is not two sentences). */
function sentencesOf(text: string, whole: readonly Span[]): Span[] {
  const spans: Span[] = [];
  let start = 0;
  let next = 0;
  for (const match of text.matchAll(SENTENCE_END)) {
    const cut = match.index + (match[0].startsWith("\n") ? 0 : 1);
    while (next < whole.length && whole[next]!.end <= cut) {
      next += 1;
    }
    if (next < whole.length && whole[next]!.at < cut) {
      continue;
    }
    spans.push({ at: start, end: cut });
    start = match.index + match[0].length;
  }
  spans.push({ at: start, end: text.length });
  return spans.filter((span) => span.end > span.at);
}

/** The words of a sentence around one place in it, kept short. */
function shortened(text: string, sentence: Span, at: number, end: number): string {
  const words = text.slice(sentence.at, sentence.end).trim();
  if (words.length <= SENTENCE_MAX) {
    return words;
  }
  const room = SENTENCE_MAX - (end - at);
  const from = Math.max(sentence.at, at - Math.floor(room / 2));
  return text.slice(from, from + SENTENCE_MAX).trim();
}

/** The price of one of something, said straight after the amount ("$140.00 per night"). A year's price is the year's whole price. */
const RATE_AFTER = /^\s*(?:(?:per|a|an|each|every)\s+|\/\s?)(?:night|month|week|day|hour|session|visit|class|lesson|seat|piece|person|guest|item|unit|mo)\b/i;
/** Money set aside against a later bill, named straight before the amount ("a deposit of $100.00"). */
const DEPOSIT_BEFORE = /\bdeposit(?:\s+(?:of|paid))?\s*:?\s*$/i;
/** An amount as it stands in the text, from its currency to its last digit. */
const AMOUNT_HERE = /^[^\d\n]{0,4}[\d.,]*\d/;

/**
 * Whether an amount is a rate or a deposit: a part of what a document
 * costs, never the whole, so never the total it is about.
 */
function partOnly(text: string, at: number): boolean {
  const end = at + (AMOUNT_HERE.exec(text.slice(at, at + 24))?.[0].length ?? 0);
  const before = text.slice(text.lastIndexOf("\n", at - 1) + 1, at);
  const deposit = DEPOSIT_BEFORE.exec(before);
  // "Total due after your deposit: $353.60" names the total, not the deposit:
  // only what stands before the word says so ("Deposit paid" is a deposit).
  return RATE_AFTER.test(text.slice(end, end + 16)) || (deposit !== null && !SUM_LINE.test(before.slice(0, deposit.index)));
}

const lineAt = (text: string, at: number) => {
  const end = text.indexOf("\n", at);
  return text.slice(text.lastIndexOf("\n", at - 1) + 1, end === -1 ? text.length : end);
};

/**
 * The amounts open to be a document's total, once per value. A value printed
 * more than once (the total, and again on the card line) stands where a line
 * calls it a sum, if any does; a rate or a deposit is no place for it.
 */
function amountsOf(text: string): { value: string; unit: string; at: number; sum: boolean }[] {
  const placed = new Map<string, { value: string; unit: string; at: number; sum: boolean }>();
  for (const amount of moneyEvery(text)) {
    if (partOnly(text, amount.at)) {
      continue;
    }
    const sum = SUM_LINE.test(lineAt(text, amount.at));
    const held = placed.get(amount.value);
    if (!held || (sum && !held.sum)) {
      placed.set(amount.value, { ...amount, sum });
    }
  }
  return [...placed.values()].sort((a, b) => a.at - b.at);
}

/** How many lines up a clock line looks for its date, as the form reader does. */
const CLOCK_LINE_REACH = 3;

/**
 * The date a clock line belongs to: the last date on the nearest line above
 * that holds one, no blank line between, at most three lines up. The clock
 * line is a short line with one clock and no date or sentence. A date that
 * is nobody's business lends its clock line to nothing.
 */
function dateLineAbove(
  text: string,
  at: number,
  found: readonly { at: number; end: number }[],
  writtenAt: number | undefined,
  skip: Known["skip"],
): number | null {
  const start = text.lastIndexOf("\n", at - 1) + 1;
  const stop = text.indexOf("\n", at);
  if (clockLineTime(text.slice(start, stop === -1 ? text.length : stop), writtenAt) === null) {
    return null;
  }
  let end = start - 1;
  for (let step = 0; step < CLOCK_LINE_REACH && end > 0; step += 1) {
    const lineStart = text.lastIndexOf("\n", end - 1) + 1;
    if (!text.slice(lineStart, end).trim()) {
      return null;
    }
    let last = -1;
    for (let i = 0; i < found.length; i += 1) {
      if (found[i]!.at >= lineStart && found[i]!.at < end) {
        last = i;
      }
    }
    if (last >= 0) {
      const date = found[last]!;
      return skip?.some((span) => date.at >= span.at && date.at < span.end) ? null : last;
    }
    end = lineStart - 1;
  }
  return null;
}

/** What is already known of a document before anything is asked about it. */
export interface Known {
  /** For a stored file: the day it was kept. */
  keptAt?: number;
  /** Days a reader already gave a meaning, each with its clock when it has one. */
  read?: readonly { value: string; time?: string }[];
  /** A reader already named the document's total. */
  total?: boolean;
  /** Places whose dates are nobody's business (a form line such as "Statement date: ..."): nothing is asked about a date found there. */
  skip?: readonly { at: number; end: number }[];
}

/**
 * The candidates of a text: what is still open to ask about.
 *
 * A message brings the day it was sent (in its context); a stored file may
 * bring the day it was kept. A date that was over before that day is not a
 * candidate: nothing can still happen then, and a day already behind the
 * reader is never offered. Such days are most of what a document holds that
 * is nobody's business (the order day, the statement date, the last visit).
 *
 * A day and clock a reader already gave a meaning is not a candidate either,
 * and no amount is once a reader named the total: one moment is read once.
 */
export function spotCandidates(text: string, context?: DateContext, known: Known = {}): Candidate[] {
  if (!text) {
    return [];
  }
  const written = findDates(text, context);
  // In a message, a day said in words is a date too, unless a written date
  // stands there or the message writes the same day out elsewhere
  // ("Tomorrow, Friday 13 November"): the written date is the reading.
  const writtenSentences = sentencesOf(text, written);
  const said =
    context?.writtenAt === undefined
      ? []
      : findRelativeDays(text, context.writtenAt)
          .filter((day) => {
            // A written date in the same sentence is what the words point at
            // ("dinner is tomorrow, Friday 13 November"), whatever day the
            // sending moment falls on in UTC.
            const sentence = writtenSentences.find((span) => day.at >= span.at && day.at < span.end);
            return !written.some(
              (hit) =>
                (day.at < hit.end && hit.at < day.end) ||
                hit.date.iso === day.iso ||
                (sentence !== undefined && hit.at >= sentence.at && hit.at < sentence.end),
            );
          })
          .map((day) => ({ at: day.at, end: day.end, date: { iso: day.iso, ambiguous: false }, relative: true as const }));
  const found: (FoundDate & { relative?: true })[] = [...written, ...said].sort((a, b) => a.at - b.at);
  const money = known.total ? [] : amountsOf(text);
  if (found.length === 0 && money.length === 0) {
    return [];
  }
  const sentences = sentencesOf(text, found);
  // Spans are in order, so each place is found by walking forward once.
  let cursor = 0;
  const sentenceAt = (at: number): Span => {
    if (cursor > 0 && sentences[cursor]!.at > at) {
      cursor = 0;
    }
    while (cursor < sentences.length - 1 && sentences[cursor]!.end <= at) {
      cursor += 1;
    }
    return sentences[cursor]!;
  };

  // Each clock goes to the nearest date in its own sentence.
  const clocksOf = new Map<number, { time: string; printed: string; gap: number }[]>();
  if (found.length > 0) {
    let first = 0;
    for (const clock of findTimes(text)) {
      const sentence = sentenceAt(clock.at);
      while (first < found.length && found[first]!.end <= sentence.at) {
        first += 1;
      }
      let nearest = -1;
      let gap = Number.POSITIVE_INFINITY;
      for (let i = first; i < found.length && found[i]!.at < sentence.end; i += 1) {
        const date = found[i]!;
        // A clock inside the date's own words is part of the date, not beside it.
        if (clock.at >= date.at && clock.end <= date.end) {
          continue;
        }
        const between = clock.at >= date.end ? clock.at - date.end : date.at - clock.end;
        if (between >= 0 && between < gap) {
          gap = between;
          nearest = i;
        }
      }
      if (nearest < 0) {
        // A clock alone on its line ("8:00 PM" under "Sat 14 Nov 2026")
        // belongs to the date line above it, in the same block.
        const above = dateLineAbove(text, clock.at, found, context?.writtenAt, known.skip);
        if (above !== null) {
          nearest = above;
          gap = clock.at - found[above]!.end;
        }
      }
      if (nearest >= 0) {
        const held = clocksOf.get(nearest) ?? [];
        held.push({ time: clock.time, printed: text.slice(clock.at, clock.end), gap });
        // A range's end is offered too: on a journey ("10:30 - 12:45") it is
        // the arrival, and the model says which end is what.
        if (clock.endTime) {
          held.push({ time: clock.endTime, printed: text.slice(clock.at, clock.end), gap: gap + 1 });
        }
        clocksOf.set(nearest, held);
      }
    }
  }

  // The day before a message was sent, in UTC: a day of doubt for the
  // sender's zone, so "today" in the message is never taken for the past.
  const since = context?.writtenAt ?? known.keptAt;
  const earliest = since !== undefined ? new Date(since - 86_400_000).toISOString().slice(0, 10) : undefined;
  // A day read with no clock covers the day; one read with a clock covers
  // that clock, and the same day standing with no clock at all.
  const settled = (value: string, time: string | undefined) =>
    (known.read ?? []).some((read) => read.value === value && (read.time === undefined || time === undefined || read.time === time));
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  let dates = 0;
  // Written dates first, then days in words: under the cap, a day said in
  // words never takes the place of a date the message writes out.
  const order = [...found.entries()].sort(([, a], [, b]) => Number(a.relative === true) - Number(b.relative === true));
  for (const [index, hit] of order) {
    if (dates === MAX_DATES) {
      break;
    }
    if (earliest !== undefined && hit.date.iso < earliest) {
      continue;
    }
    if (known.skip?.some((span) => hit.at >= span.at && hit.at < span.end)) {
      continue;
    }
    const printed = text.slice(hit.at, hit.end);
    const sentence = shortened(text, sentenceAt(hit.at), hit.at, hit.end);
    // The nearest clocks, then back in the order they stand.
    const clocks = (clocksOf.get(index) ?? [])
      .map((clock, order) => ({ ...clock, order }))
      .sort((a, b) => a.gap - b.gap)
      .slice(0, CLOCKS_PER_DATE)
      .sort((a, b) => a.order - b.order);
    for (const clock of clocks.length > 0 ? clocks : [undefined]) {
      const id = `${hit.date.iso}|${clock?.time ?? ""}`;
      if (seen.has(id) || dates === MAX_DATES || settled(hit.date.iso, clock?.time)) {
        continue;
      }
      seen.add(id);
      dates += 1;
      candidates.push({
        key: `d${dates}`,
        what: "date",
        value: hit.date.iso,
        ...(clock ? { time: clock.time } : {}),
        ...(hit.date.assumedYear ? { assumedYear: true as const } : {}),
        ...(hit.date.ambiguous ? { ambiguous: true as const } : {}),
        ...(hit.relative ? { relative: true as const } : {}),
        printed: clock ? `${printed}, ${clock.time}` : printed,
        sentence,
      });
    }
  }

  // The amounts a document is about come before its line items.
  const ranked = money
    .map((amount, order) => ({ ...amount, order }))
    .sort((a, b) => Number(b.sum) - Number(a.sum) || a.order - b.order)
    .slice(0, MAX_AMOUNTS);
  cursor = 0;
  for (const [index, amount] of ranked.entries()) {
    const printed = `${amount.unit} ${amount.value}`;
    candidates.push({
      key: `a${index + 1}`,
      what: "amount",
      value: amount.value,
      unit: amount.unit,
      printed,
      sentence: shortened(text, sentenceAt(amount.at), amount.at, amount.at + printed.length),
    });
  }
  return candidates;
}
