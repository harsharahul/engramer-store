/**
 * What a form line's label means.
 *
 * Paperwork prints most of its dates on labelled lines, and what a label
 * means does not depend on the document: "Statement date" is the day a
 * statement was made on every statement there is. A table of such labels,
 * written once and shipped as data, says for each one whether its date is a
 * day to pay or act by, an expiry, an issue day, something that happens, one
 * end of a stay or a journey, or nobody's business as a reminder.
 *
 * A label is looked up exactly, after it is normalized; nothing is guessed
 * from a label that only resembles one in the table. A label the table does
 * not hold has no meaning here, and its line is read as it was before.
 */

export const LABEL_MEANINGS = ["event", "check-in", "check-out", "depart", "arrive", "due", "expiry", "issued", "none"] as const;
export type LabelMeaning = (typeof LABEL_MEANINGS)[number];

export interface Lexicon {
  /** Normalized label to meaning. */
  dates: ReadonlyMap<string, LabelMeaning>;
  /** A short name for the shipped table's contents: it changes when any row does. */
  edition?: string;
}

/**
 * A label as the table knows it: lower case, letters only, single spaces,
 * and without a closing "date" or "on" ("Statement date", "Expires on").
 * Words that carry the meaning stay: "by", "until", "of", "at".
 */
export function normalizeLabel(label: string): string {
  const words = label
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  while (words.length > 1 && (words[words.length - 1] === "date" || words[words.length - 1] === "on")) {
    words.pop();
  }
  return words.join(" ");
}

const isMeaning = (word: string): word is LabelMeaning => (LABEL_MEANINGS as readonly string[]).includes(word);

/**
 * Reads the table's source: one label and its meaning on a line, a tab
 * between them; a line that starts with # is a heading. The same label
 * written twice with one meaning is one row. A label written with two
 * meanings is a problem and is in no row: unknown is safe, a wrong meaning
 * is not.
 */
export function parseLabelTable(source: string): { rows: [string, LabelMeaning][]; problems: string[] } {
  const meanings = new Map<string, Set<LabelMeaning>>();
  const problems: string[] = [];
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("#")) {
      continue;
    }
    const [label, meaning, ...more] = line.split("\t").map((part) => part.trim());
    if (!label || !meaning || more.length > 0) {
      problems.push(`no label and meaning in "${line.trim()}"`);
      continue;
    }
    if (!isMeaning(meaning)) {
      problems.push(`unknown meaning "${meaning}" for "${label}"`);
      continue;
    }
    const key = normalizeLabel(label);
    if (!key) {
      problems.push(`a label with no words: "${label}"`);
      continue;
    }
    meanings.set(key, (meanings.get(key) ?? new Set()).add(meaning));
  }
  const rows: [string, LabelMeaning][] = [];
  const clashes: string[] = [];
  for (const [key, held] of [...meanings].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (held.size > 1) {
      clashes.push(`two meanings for "${key}": ${[...held].sort().join(", ")}`);
    } else {
      rows.push([key, [...held][0]!]);
    }
  }
  return { rows, problems: [...clashes, ...problems] };
}

export function lexiconFrom(rows: readonly (readonly string[])[]): Lexicon {
  const dates = new Map<string, LabelMeaning>();
  for (const [label, meaning] of rows) {
    if (label !== undefined && meaning !== undefined && isMeaning(meaning)) {
      dates.set(label, meaning);
    }
  }
  return { dates };
}

/** What the table says a label means; undefined when it does not hold the label. */
export function meaningOf(lexicon: Lexicon, label: string): LabelMeaning | undefined {
  const key = normalizeLabel(label);
  return key ? lexicon.dates.get(key) : undefined;
}

let loading: Promise<Lexicon | undefined> | null = null;

/**
 * The shipped table, loaded on first use and kept. A table that cannot be
 * loaded is no table: every label is then one it does not hold, so each
 * line is read with its own words, and the next call asks for it again.
 */
export function loadLexicon(): Promise<Lexicon | undefined> {
  loading ??= import("./tables/labels.json").then(
    (mod) => {
      const table: { edition?: string; dates: readonly (readonly string[])[] } = mod.default ?? mod;
      return { ...lexiconFrom(table.dates), ...(table.edition ? { edition: table.edition } : {}) };
    },
    () => {
      loading = null;
      return undefined;
    },
  );
  return loading;
}
