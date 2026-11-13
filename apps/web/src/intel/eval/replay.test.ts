import { describe, expect, it } from "vitest";
import { asSent, AssistantError, type GenerateRequest } from "../assistant";
import { hashRequest, keptAnswers, replayRunner, StaleAnswer, type SavedAnswer } from "./replay";

const request = (prompt: string, over: Partial<GenerateRequest> = {}): GenerateRequest => ({
  instructions: "Say what each date is.",
  prompt,
  priority: "background",
  schema: { type: "object", properties: { d1: { type: "string", enum: ["due", "other"] } }, required: ["d1"] },
  temperature: 0,
  maxTokens: 84,
  ...over,
});

const saved = (asked: GenerateRequest, answer: unknown): SavedAnswer => ({ request: hashRequest(asked), answer });

describe("a request's name", () => {
  it("is the same for the same request, and another for any change the model would see", () => {
    const asked = request("Pay by 12 March 2027.");
    expect(hashRequest(asked)).toMatch(/^[0-9a-f]{8}$/);
    expect(hashRequest(asked)).toBe(hashRequest(request("Pay by 12 March 2027.")));
    expect(hashRequest(request("Pay by 13 March 2027."))).not.toBe(hashRequest(asked));
    expect(hashRequest(request("Pay by 12 March 2027.", { instructions: "Say what each day is." }))).not.toBe(hashRequest(asked));
    expect(hashRequest(request("Pay by 12 March 2027.", { maxTokens: 85 }))).not.toBe(hashRequest(asked));
    expect(hashRequest(request("Pay by 12 March 2027.", { temperature: 0.2 }))).not.toBe(hashRequest(asked));
    const reworded = request("Pay by 12 March 2027.");
    reworded.schema!.properties["d1"] = { type: "string", enum: ["due", "expiry", "other"] };
    expect(hashRequest(reworded)).not.toBe(hashRequest(asked));
  });

  it("names the request as the model receives it: what is left unsaid is the default", () => {
    // A summary request states no temperature, no answer budget and no model.
    const bare: GenerateRequest = { instructions: "Summarize.", prompt: "Your water bill.", priority: "background" };
    const sent = asSent(bare);
    expect(sent).toMatchObject({ model: "system", temperature: 0.2, maxTokens: 300 });
    expect(hashRequest(bare)).toBe(hashRequest({ ...bare, model: sent.model, temperature: sent.temperature, maxTokens: sent.maxTokens }));
    // So a changed default is a changed request, and its kept answers are stale.
    expect(hashRequest(bare)).not.toBe(hashRequest({ ...bare, temperature: 0 }));
    expect(hashRequest(bare)).not.toBe(hashRequest({ ...bare, maxTokens: 301 }));
    expect(hashRequest(bare)).not.toBe(hashRequest({ ...bare, model: "tagging" }));
  });

  it("does not depend on what the model never sees: who waits for the answer, or a deadline", () => {
    const asked = request("Pay by 12 March 2027.");
    expect(hashRequest({ ...asked, priority: "interactive", deadlineMs: 5_000, signal: new AbortController().signal })).toBe(hashRequest(asked));
  });
});

describe("replaying kept answers", () => {
  const summary = request("Summarize: your water bill.", { schema: undefined, temperature: 0.2 });
  const judge = request("Pay by 12 March 2027.");

  it("the same request gets its saved answer back, in order", async () => {
    const run = replayRunner([saved(summary, { summary: "A water bill." }), saved(judge, { d1: "due" })]);
    expect(await run(summary)).toEqual({ summary: "A water bill." });
    expect(await run(judge)).toEqual({ d1: "due" });
  });

  it("a changed request is stale, never answered from an old reading", async () => {
    const run = replayRunner([saved(summary, { summary: "A water bill." }), saved(judge, { d1: "due" })]);
    await run(summary);
    await expect(run(request("Pay by 12 March 2027!"))).rejects.toMatchObject({ code: "stale" });
  });

  it("a saved refusal is refused again, as the error the reading code knows", async () => {
    const run = replayRunner([{ request: hashRequest(summary), error: "guardrail" }]);
    const refusal = await run(summary).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(AssistantError);
    expect(refusal).toMatchObject({ code: "guardrail" });
  });

  it("a stale request is told apart from any answer or refusal of the model", async () => {
    const stale = await replayRunner([])(summary).catch((error: unknown) => error);
    expect(stale).toBeInstanceOf(StaleAnswer);
    expect(stale).not.toBeInstanceOf(AssistantError);
  });

  it("asking for more than was saved is stale", async () => {
    const run = replayRunner([saved(summary, { summary: "A water bill." })]);
    await run(summary);
    await expect(run(judge)).rejects.toMatchObject({ code: "stale" });
  });

  it("answers kept in the old form, with no request name, are stale", async () => {
    const run = replayRunner([{ summary: "A water bill." } as unknown as SavedAnswer]);
    await expect(run(summary)).rejects.toMatchObject({ code: "stale" });
  });

  it("a kept file that cannot be read holds no answers, so its case is stale and never scored", async () => {
    expect(keptAnswers(undefined)).toEqual([]);
    expect(keptAnswers("")).toEqual([]);
    expect(keptAnswers('[{"request": "0a1b2c3d", "answ')).toEqual([]);
    expect(keptAnswers('{"request": "0a1b2c3d"}')).toEqual([]);
    const text = JSON.stringify([saved(summary, { summary: "A water bill." })]);
    expect(keptAnswers(text)).toHaveLength(1);
    await expect(replayRunner(keptAnswers("not json"))(summary)).rejects.toBeInstanceOf(StaleAnswer);
  });
});
