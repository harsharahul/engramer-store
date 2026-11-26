/**
 * How often a label rule's dated reading is right, by kind, on a set of
 * cases: the measured record a rule reading would have to rest on before it
 * could count without the owner's yes.
 *
 * The rules are deterministic, so the record needs no model: it is computed
 * from the cases and kept in rulescores.json, and a test compares the two.
 * Only readings one reader could be trusted with are measured: not a date of
 * doubt (a year the text left out, a day said in words, a date that reads
 * two ways), not where a wrong value costs much, and only a value that
 * passes the sanity checks. The bar is the one every reader has: 98% over
 * thirty readings, on the first set and on the held-out set.
 */

import { MIN_SAMPLE, PRECISION_BAR, saneFact, stakesOf } from "../confidence";
import { scanForFacts } from "../scan";
import { matches, type EvalCase } from "./score";

/** The kinds of dated reading a label rule gives a meaning. */
export const RULE_KINDS = ["due", "event", "expiry"] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

export interface RuleTally {
  /** Readings of this kind that one reader could be trusted with. */
  offered: number;
  /** Of those: the document states that day under that meaning. */
  right: number;
}

export type RuleScores = Record<RuleKind, RuleTally>;

const isRuleKind = (kind: string): kind is RuleKind => (RULE_KINDS as readonly string[]).includes(kind);

/** The label rules' readings on a set of cases, each judged on the day its document reached the reader. */
export async function scoreRules(cases: readonly EvalCase[], dayOf: (evalCase: EvalCase) => number): Promise<RuleScores> {
  const scores: RuleScores = { due: { offered: 0, right: 0 }, event: { offered: 0, right: 0 }, expiry: { offered: 0, right: 0 } };
  for (const evalCase of cases) {
    const { facts } = await scanForFacts({
      name: evalCase.name,
      mime: evalCase.mime,
      text: evalCase.text,
      ...(evalCase.raw ? { raw: evalCase.raw } : {}),
      ...(evalCase.writtenAt !== undefined ? { writtenAt: evalCase.writtenAt } : {}),
    });
    for (const fact of facts) {
      if (fact.source !== "label" || !isRuleKind(fact.kind)) {
        continue;
      }
      if (fact.relative || fact.assumedYear || fact.ambiguous || stakesOf(fact) === "high" || !saneFact(fact, facts, dayOf(evalCase))) {
        continue;
      }
      const tally = scores[fact.kind];
      tally.offered += 1;
      tally.right += evalCase.expected.some((expected) => matches(fact, expected)) ? 1 : 0;
    }
  }
  return scores;
}

/** The kinds whose readings are right often enough, on both sets, to be trusted alone. */
export function trustedKinds(record: { first: RuleScores; heldout: RuleScores }): RuleKind[] {
  const clears = (tally: RuleTally) => tally.offered >= MIN_SAMPLE && tally.right / tally.offered >= PRECISION_BAR;
  return RULE_KINDS.filter((kind) => clears(record.first[kind]) && clears(record.heldout[kind]));
}
