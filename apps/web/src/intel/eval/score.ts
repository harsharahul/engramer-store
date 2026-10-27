/**
 * Scoring a reader against the synthetic eval set, per task.
 *
 * A reader's measured precision is what decides whether its readings may
 * count without the owner's yes: only where it is at least 98% (spec 3.14).
 * Precision counts every reading the reader offered for the task; recall
 * counts every fact the case says is there. A reader that offers nothing is
 * not wrong, only incomplete.
 */

import type { Fact, FactKind } from "../facts";

export interface EvalCase {
  id: string;
  name: string;
  mime: string;
  text: string;
  /** The document as written, when it carries structured data (HTML, an invite). */
  raw?: string;
  /** What a good reader finds: the time only where the document gives one. */
  expected: { kind: FactKind; value: string; time?: string; label?: string }[];
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

/** How often a classifier names an email's kind right, over cases that say. */
export async function scoreKinds(
  cases: readonly EvalCase[],
  classify: (evalCase: EvalCase) => Promise<string | null>,
): Promise<{ accuracy: number; cases: number }> {
  const labelled = cases.filter((evalCase) => evalCase.mailKind !== undefined);
  let right = 0;
  for (const evalCase of labelled) {
    if ((await classify(evalCase)) === evalCase.mailKind) {
      right++;
    }
  }
  return { accuracy: labelled.length === 0 ? 1 : right / labelled.length, cases: labelled.length };
}
