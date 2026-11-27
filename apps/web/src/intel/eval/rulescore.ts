/**
 * How often a label rule's reading is right, by kind, on a set of cases: the
 * measured record a rule reading rests on before it can count without the
 * owner's yes.
 *
 * The rules are deterministic, so the record needs no model: it is computed
 * from the cases and kept in rulescores.json, and a test compares the two.
 * Only readings one reader could be trusted with are measured. A day to pay
 * is measured where it is plain (confidence.ts: the one such day in a mail,
 * ahead of the day the mail was sent, printed whole), and with it the
 * amount such a bill asks for. A stored file states no day of its own, so
 * neither is measured there. An event or an expiry is measured where it is
 * not a date of doubt, a wrong value would not cost much, and the value
 * passes the sanity checks. The bar is the one every reader has: 98% over
 * thirty readings, on the first set and on the unseen documents.
 */

import { plainAmount, plainDue, withoutDoubt, type RuleScores } from "../rulerecord";
import { scanForFacts } from "../scan";
import { matches, type EvalCase } from "./score";

/**
 * The label rules' readings on a set of cases. A day to pay and its amount
 * are judged against the day the document states it was written; an event
 * or an expiry against `dayOf`, the day the document reached the reader.
 */
export async function scoreRules(cases: readonly EvalCase[], dayOf: (evalCase: EvalCase) => number): Promise<RuleScores> {
  const none = () => ({ offered: 0, right: 0 });
  const scores: RuleScores = { due: none(), event: none(), expiry: none(), amount: none() };
  for (const evalCase of cases) {
    const { facts } = await scanForFacts({
      name: evalCase.name,
      mime: evalCase.mime,
      text: evalCase.text,
      ...(evalCase.raw ? { raw: evalCase.raw } : {}),
      ...(evalCase.writtenAt !== undefined ? { writtenAt: evalCase.writtenAt } : {}),
    });
    const day = dayOf(evalCase);
    for (const fact of facts) {
      if (fact.source !== "label") {
        continue;
      }
      const measured =
        fact.kind === "due"
          ? plainDue(fact, facts, evalCase.writtenAt)
          : fact.kind === "amount"
            ? plainAmount(fact, facts, evalCase.writtenAt)
            : (fact.kind === "event" || fact.kind === "expiry") && withoutDoubt(fact, facts, day);
      if (!measured) {
        continue;
      }
      const tally = scores[fact.kind as keyof RuleScores];
      tally.offered += 1;
      tally.right += evalCase.expected.some((expected) => matches(fact, expected)) ? 1 : 0;
    }
  }
  return scores;
}
