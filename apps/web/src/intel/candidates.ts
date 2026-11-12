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
import { findDates, findTimes, type DateContext } from "./dates";
import { moneyIn } from "./labels";

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

export function spotCandidates(text: string, context?: DateContext): Candidate[] {
  if (!text) {
    return [];
  }
  const found = findDates(text, context);
  const money = moneyIn(text);
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
      if (nearest >= 0) {
        const held = clocksOf.get(nearest) ?? [];
        held.push({ time: clock.time, printed: text.slice(clock.at, clock.end), gap });
        clocksOf.set(nearest, held);
      }
    }
  }

  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  let dates = 0;
  for (const [index, hit] of found.entries()) {
    if (dates === MAX_DATES) {
      break;
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
      if (seen.has(id) || dates === MAX_DATES) {
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
        printed: clock ? `${printed}, ${clock.time}` : printed,
        sentence,
      });
    }
  }

  // The amounts a document is about come before its line items.
  const lineOf = (at: number) => text.slice(text.lastIndexOf("\n", at - 1) + 1, text.indexOf("\n", at) === -1 ? text.length : text.indexOf("\n", at));
  const ranked = money
    .map((amount, order) => ({ ...amount, order, sum: SUM_LINE.test(lineOf(amount.at)) }))
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
