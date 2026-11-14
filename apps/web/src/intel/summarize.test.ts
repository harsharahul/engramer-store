import { describe, expect, it } from "vitest";
import { AssistantError, type GenerateRequest } from "./assistant";
import { hashRequest, replayRunner, StaleAnswer, type SavedAnswer } from "./eval/replay";
import type { Fact } from "./facts";
import {
  cleanTags,
  FactsOwed,
  headChunk,
  messageOf,
  outcomeFor,
  readingContext,
  sanitizeSummary,
  readingFingerprint,
  readingSchema,
  summarize,
  summarySchema,
  summaryWithFactsSchema,
  SUMMARY_MAX,
} from "./summarize";

describe("sanitizeSummary", () => {
  it("keeps one clean line under the cap, cut at a word", () => {
    const long = "word ".repeat(100).trim();
    const cut = sanitizeSummary(long);
    expect(cut.length).toBeLessThanOrEqual(SUMMARY_MAX);
    expect(cut.endsWith("word")).toBe(true);
    expect(sanitizeSummary("  two\n\nlines   here ")).toBe("two lines here");
  });

  it("masks reference numbers and addresses, which metadata must not carry", () => {
    expect(sanitizeSummary("Invoice 4821 from Acme, account 123456789, due soon")).toBe(
      "Invoice 4821 from Acme, account …6789, due soon",
    );
    expect(sanitizeSummary("Contact jane.doe@example.com for the policy")).toBe(
      "Contact [email] for the policy",
    );
    expect(sanitizeSummary("Card 4111 1111 1111 1111 on file")).toBe("Card …1111 on file");
  });

  it("returns an empty string for nothing usable", () => {
    expect(sanitizeSummary("   ")).toBe("");
    expect(sanitizeSummary(undefined)).toBe("");
  });
});

describe("cleanTags", () => {
  it("keeps a few short lowercase words the file does not already carry", () => {
    expect(cleanTags(["Insurance", " home ", "insurance", "receipt", "x".repeat(40), "tag:evil", "album:trip", "ok-tag", "", 7], ["receipt"])).toEqual(
      ["insurance", "home", "ok-tag"],
    );
    expect(cleanTags(["a", "b", "c", "d", "e", "f", "g"], [])).toHaveLength(5);
  });
});

describe("headChunk", () => {
  it("takes the opening of a long document, sized to the model's window", () => {
    const text = "x".repeat(50_000);
    const chunk = headChunk(text, 4096);
    expect(chunk.length).toBeGreaterThan(5_000);
    expect(chunk.length).toBeLessThan(12_000);
    expect(headChunk("short", 4096)).toBe("short");
    expect(headChunk(text, 8192).length).toBeGreaterThan(headChunk(text, 4096).length);
  });
});

describe("outcomeFor", () => {
  it("turns a refusal into the honest reason, and leaves transient trouble owed", () => {
    expect(outcomeFor(new AssistantError("guardrail", ""))).toBe("declined");
    expect(outcomeFor(new AssistantError("language", ""))).toBe("language");
    expect(outcomeFor(new AssistantError("rate-limited", ""))).toBe("paused");
    // About the file: a try is spent.
    expect(outcomeFor(new AssistantError("timeout", ""))).toBeNull();
    expect(outcomeFor(new Error("boom"))).toBeNull();
    // About this device's model, not the file: paused, no try spent.
    for (const code of ["unavailable", "preempted", "cancelled", "bad-request"]) {
      expect(outcomeFor(new AssistantError(code, ""))).toBe("paused");
    }
  });
});

describe("summarize", () => {
  const vocab = ["Documents", "Receipts", "Notes"];

  it("asks the model with the opening pages and returns a clean, capped answer", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const answer = await summarize(
      { text: "Invoice 4821 from Acme Hardware. ".repeat(20), name: "acme.pdf", categories: vocab, contextSize: 4096 },
      async (request) => {
        calls.push(request as unknown as Record<string, unknown>);
        return { summary: "An Acme Hardware invoice for tools, account 123456789.", tags: ["Invoice", "hardware"], kind: "Receipts" };
      },
    );
    expect(answer).toEqual({
      summary: "An Acme Hardware invoice for tools, account …6789.",
      tags: ["invoice", "hardware"],
      kind: "Receipts",
      facts: [],
    });
    expect(calls[0]!.priority).toBe("background");
    expect(calls[0]!.schema).toBe(summarySchema);
    expect(readingSchema(true)).toBe(summaryWithFactsSchema);
    // With date reading on, the summary also names the document's kind; it writes no date and no amount.
    expect(Object.keys(summaryWithFactsSchema.properties)).toEqual(["summary", "tags", "kind", "document"]);
    expect(String(calls[0]!.prompt)).toContain("acme.pdf");
  });

  it("an email's reading carries its kind", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const answer = await summarize(
      { text: "Your water bill is USD 64.10.", name: "Your water bill.email", categories: vocab, contextSize: 4096, mail: true },
      async (request) => {
        calls.push(request as unknown as Record<string, unknown>);
        return { summary: "A water bill.", tags: [], kind: "Receipts", mailKind: "bill" };
      },
    );
    expect(answer?.mailKind).toBe("bill");
    const schema = calls[0]!.schema as { properties: Record<string, { enum?: string[] }> };
    expect(schema.properties.mailKind!.enum).toEqual(["booking", "bill", "delivery", "receipt", "newsletter", "personal", "other"]);
    expect(String(calls[0]!.instructions)).toContain("email");
  });

  it("a newsletter's reading names its kind beside what it read", async () => {
    // Whether a newsletter's dates are dropped is decided by the store, by
    // how far the kind is trusted; the reading only reports.
    const text = "Sale ends on 30 May 2027. Save 20%.";
    let calls = 0;
    const answer = await summarize(
      { text, name: "Sale.email", categories: vocab, contextSize: 4096, mail: true, withFacts: true },
      async () => {
        calls += 1;
        return calls === 1 ? { summary: "A store newsletter.", tags: [], kind: "Documents", mailKind: "newsletter", document: "other" } : { d1: "due" };
      },
    );
    expect(answer?.mailKind).toBe("newsletter");
    expect(answer?.facts.map((f) => f.value)).toEqual(["2027-05-30"]);
  });

  it("a kind outside the list is dropped", async () => {
    const answer = await summarize(
      { text: "hello", name: "x.email", categories: vocab, contextSize: 4096, mail: true },
      async () => ({ summary: "A note.", tags: [], kind: "Notes", mailKind: "spaceship" }),
    );
    expect(answer).not.toHaveProperty("mailKind");
  });

  it("drops a kind outside the vocabulary and an empty summary", async () => {
    const answer = await summarize(
      { text: "x".repeat(400), name: "n", categories: vocab, contextSize: 4096 },
      async () => ({ summary: "   ", tags: [], kind: "Hologram" }),
    );
    expect(answer).toBeNull();
  });

  it("retries once with half the text when the window overflows, then gives up", async () => {
    let attempts = 0;
    const lengths: number[] = [];
    await expect(
      summarize(
        { text: "y".repeat(20_000), name: "n", categories: vocab, contextSize: 4096 },
        async (request) => {
          attempts += 1;
          lengths.push(String(request.prompt).length);
          throw new AssistantError("context-too-long", "");
        },
      ),
    ).rejects.toMatchObject({ code: "context-too-long" });
    expect(attempts).toBe(2);
    expect(lengths[1]!).toBeLessThan(lengths[0]!);
  });
});

describe("summarize with facts", () => {
  const POLICY = "Home insurance policy. Coverage to 5 October 2026. Premium of USD 412.00 due 30 September 2025.";
  const SUMMARY = { summary: "A home insurance policy.", tags: ["insurance"], kind: "Documents", document: "insurance" };
  /** A model that answers the summary, then the judge, and remembers what it was asked. */
  const model = (judged: unknown) => {
    const asked: GenerateRequest[] = [];
    const run = async (request: GenerateRequest) => {
      asked.push(request);
      return asked.length === 1 ? SUMMARY : judged;
    };
    return { asked, run };
  };

  it("the summary names the document's kind and writes no value; a second call judges what the rules found", async () => {
    const { asked, run } = model({ d1: "expiry", d2: "due", pays: "yes", total: "a1" });
    const answer = await summarize({ text: POLICY, name: "policy.pdf", categories: ["Documents"], contextSize: 4096, withFacts: true }, run);
    expect(asked).toHaveLength(2);
    expect(asked[0]!.schema).toBe(summaryWithFactsSchema);
    expect(Object.keys(asked[0]!.schema!.properties)).toEqual(["summary", "tags", "kind", "document"]);
    expect(Object.keys(asked[1]!.schema!.properties)).toEqual(["d1", "d1w", "d2", "d2w", "pays", "total"]);
    expect(asked[1]!.temperature).toBe(0);
    expect(answer?.document).toBe("insurance");
    expect(answer?.facts.map((f) => [f.kind, f.value, f.unit, f.source, f.document])).toEqual([
      ["expiry", "2026-10-05", undefined, "model", "insurance"],
      ["due", "2025-09-30", undefined, "model", "insurance"],
      ["amount", "412.00", "USD", "model", "insurance"],
    ]);
  });

  it("a date the model makes up cannot arrive: it has nowhere to write one", async () => {
    const { run } = model({ d1: "expiry", d2: "other", a1: "other", d3: "expiry", d3w: "2031-01-01", facts: [{ kind: "expiry", value: "2031-01-01" }] });
    const answer = await summarize({ text: POLICY, name: "policy.pdf", categories: ["Documents"], contextSize: 4096, withFacts: true }, run);
    expect(answer?.facts.map((f) => f.value)).toEqual(["2026-10-05"]);
  });

  it("a document with no dates and no amounts is asked once", async () => {
    const { asked, run } = model({});
    const answer = await summarize({ text: "A short note about nothing in particular. ".repeat(10), name: "note.txt", categories: ["Documents"], contextSize: 4096, withFacts: true }, run);
    expect(asked).toHaveLength(1);
    expect(answer?.facts).toEqual([]);
  });

  it("a stored file is not asked about a day that was over when it was kept", async () => {
    const warranty = "Certificate of warranty. Purchase date: 3 August 2026. This warranty is valid until 2 August 2028.";
    const { asked, run } = model({ d1: "expiry" });
    const answer = await summarize(
      { text: warranty, name: "warranty.pdf", categories: ["Documents"], contextSize: 4096, withFacts: true, keptAt: Date.UTC(2026, 10, 9, 12) },
      run,
    );
    expect(Object.keys(asked[1]!.schema!.properties)).toEqual(["d1", "d1w"]);
    expect(asked[1]!.prompt).toContain("d1: 2 August 2028");
    expect(answer?.facts.map((f) => [f.kind, f.value])).toEqual([["expiry", "2028-08-02"]]);
  });

  it("a document whose every day is over is not asked about its dates", async () => {
    const minutes = "Minutes of the meeting held on 10 November 2025. The previous minutes of 3 October 2025 were approved.";
    const { asked, run } = model({ d1: "event" });
    const answer = await summarize({ text: minutes, name: "minutes.pdf", categories: ["Documents"], contextSize: 4096, withFacts: true, keptAt: Date.UTC(2026, 10, 9, 12) }, run);
    expect(asked).toHaveLength(1);
    expect(answer?.facts).toEqual([]);
  });

  it("a document whose only dates stand on lines that are nobody's business is asked once", async () => {
    const statement = "Account summary\nStatement date: 3 February 2027\nBooked on: 10 February 2027\nThank you for being a member.";
    const { asked, run } = model({ d1: "due" });
    const answer = await summarize({ text: statement, name: "statement.pdf", categories: ["Documents"], contextSize: 4096, withFacts: true }, run);
    expect(asked).toHaveLength(1);
    expect(answer?.facts).toEqual([]);
  });

  it("a line that is nobody's business is left out of what the model is asked; the rest is asked", async () => {
    const letter = "Statement date: 3 February 2027\nWe will visit to read your meter on 9 March 2027.";
    const { asked, run } = model({ d1: "event", d1w: "meter reading" });
    await summarize({ text: letter, name: "letter.pdf", categories: ["Documents"], contextSize: 4096, withFacts: true }, run);
    expect(Object.keys(asked[1]!.schema!.properties)).toEqual(["d1", "d1w"]);
    expect(asked[1]!.prompt).toContain("d1: 9 March 2027");
  });

  describe("what another reader already settled", () => {
    const bill = "City Water. Amount due: $84.20. Due date: 20 November 2027. Your meter will be read on 3 December 2027 at 10:00.";
    const known: Fact[] = [
      { id: "due:2027-11-20", kind: "due", document: "invoice", value: "2027-11-20", source: "label", confidence: 0.7 },
      { id: "amount:84.20", kind: "amount", document: "invoice", value: "84.20", unit: "USD", label: "Amount due", source: "label", confidence: 0.7 },
    ];

    it("the model is asked only about the rest", async () => {
      const { asked, run } = model({ d1: "event", d1w: "meter" });
      const answer = await summarize({ text: bill, name: "water.pdf", categories: ["Documents"], contextSize: 4096, withFacts: true, known }, run);
      // The due day and the total are the rule's: neither is put to the model.
      expect(Object.keys(asked[1]!.schema!.properties)).toEqual(["d1", "d1w"]);
      expect(asked[1]!.prompt).toContain("d1: 3 December 2027, 10:00");
      expect(answer?.facts.map((f) => [f.kind, f.value, f.time])).toEqual([["event", "2027-12-03", "10:00"]]);
    });

    it("a document with nothing left to ask about is asked once", async () => {
      const { asked, run } = model({ d1: "due" });
      const answer = await summarize(
        { text: "City Water. Amount due: $84.20. Due date: 20 November 2027.", name: "water.pdf", categories: ["Documents"], contextSize: 4096, withFacts: true, known },
        run,
      );
      expect(asked).toHaveLength(1);
      expect(answer?.facts).toEqual([]);
    });
  });

  it("with date reading off, nothing is judged", async () => {
    const { asked, run } = model({ d1: "expiry" });
    const answer = await summarize({ text: POLICY, name: "policy.pdf", categories: ["Documents"], contextSize: 4096 }, run);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.schema).toBe(summarySchema);
    expect(answer?.facts).toEqual([]);
  });

  it("a message's judge is told its subject, its sender and the day it was written, and reads a date with no year", async () => {
    const { asked, run } = model({ d1: "event", d1w: "Arriving" });
    const answer = await summarize(
      {
        text: "Your order has shipped. Arriving Thursday, November 12.",
        name: "Shipped.email",
        categories: ["Documents"],
        contextSize: 4096,
        withFacts: true,
        mail: true,
        message: { subject: "Your order has shipped", from: "Lantern Shop", writtenAt: Date.parse("2026-11-09T12:00:00Z") },
      },
      async (request) => (await run(request)) ?? null,
    );
    expect(asked[1]!.prompt).toContain("Subject: Your order has shipped");
    expect(asked[1]!.prompt).toContain("Written: Monday 9 November 2026");
    expect(answer?.facts).toEqual([expect.objectContaining({ kind: "event", value: "2026-11-12", assumedYear: true, label: "Arriving" })]);
  });

  describe("a day said in words", () => {
    // Thursday 12 November 2026.
    const message = (subject: string) => ({ subject, from: "Sam Example", writtenAt: Date.UTC(2026, 10, 12, 9) });
    const read = async (text: string, judged: unknown, subject: string) => {
      const { asked, run } = model(judged);
      const answer = await summarize(
        { text, name: `${subject}.email`, categories: ["Documents"], contextSize: 4096, withFacts: true, mail: true, message: message(subject) },
        async (request) => (await run(request)) ?? null,
      );
      return { asked, answer };
    };

    it("a plan said with 'tomorrow' is read as the day after sending, marked so it asks", async () => {
      const { asked, answer } = await read("Dinner tomorrow at 7pm? I found a place near the station.", { d1: "event", d1w: "Dinner" }, "Dinner?");
      expect(asked[1]!.prompt).toContain("tomorrow, 19:00");
      expect(answer?.facts).toEqual([expect.objectContaining({ kind: "event", value: "2026-11-13", time: "19:00", relative: true })]);
      expect(answer?.facts[0]?.accepted).toBeUndefined();
    });

    it("a promotion's 'tomorrow only' that the model calls nothing stores nothing", async () => {
      const { asked, answer } = await read("Tomorrow only: 20% off all boots. Shop now.", { d1: "other" }, "Weekend deals");
      expect(Object.keys(asked[1]!.schema!.properties)).toContain("d1");
      expect(answer?.facts).toEqual([]);
    });
  });

  it("a judge that declines leaves the summary, with no facts", async () => {
    let calls = 0;
    const answer = await summarize({ text: POLICY, name: "policy.pdf", categories: ["Documents"], contextSize: 4096, withFacts: true }, async () => {
      calls += 1;
      if (calls === 2) {
        throw new AssistantError("guardrail", "");
      }
      return SUMMARY;
    });
    expect(calls).toBe(2);
    expect(answer).toMatchObject({ summary: "A home insurance policy.", facts: [] });
  });

  it("a judge that only ran out of time leaves the reading owed, and hands back the summary it had", async () => {
    let calls = 0;
    const failure = await summarize({ text: POLICY, name: "policy.pdf", categories: ["Documents"], contextSize: 4096, withFacts: true }, async () => {
      calls += 1;
      if (calls === 2) {
        throw new AssistantError("timeout", "");
      }
      return SUMMARY;
    }).catch((error: unknown) => error);
    // The summary was read; only the dates are owed. Whoever counts the
    // tries can keep it when the last one is spent.
    expect(failure).toBeInstanceOf(FactsOwed);
    expect((failure as FactsOwed).reading).toMatchObject({ summary: "A home insurance policy.", facts: [] });
    expect((failure as FactsOwed).cause).toMatchObject({ code: "timeout" });
    // What it means for the file is what its cause means: a timeout is a try.
    expect(outcomeFor(failure)).toBeNull();
  });

  it("a model that went away between the two calls is a pause, not a try", async () => {
    let calls = 0;
    const failure = await summarize({ text: POLICY, name: "policy.pdf", categories: ["Documents"], contextSize: 4096, withFacts: true }, async () => {
      calls += 1;
      if (calls === 2) {
        throw new AssistantError("preempted", "");
      }
      return SUMMARY;
    }).catch((error: unknown) => error);
    expect(outcomeFor(failure)).toBe("paused");
  });

  it("a kept answer that belongs to another request comes out of the reading as stale, never as no facts", async () => {
    // The first reading is recorded as the eval keeps it: each answer under its request's name.
    const kept: SavedAnswer[] = [];
    const input = { text: POLICY, name: "policy.pdf", categories: ["Documents"], contextSize: 4096, withFacts: true };
    await summarize(input, async (request) => {
      const answer = kept.length === 0 ? SUMMARY : { d1: "expiry", d2: "due", pays: "yes", total: "a1" };
      kept.push({ request: hashRequest(request), answer });
      return answer;
    });
    // Replayed unchanged, the reading is the same reading.
    expect((await summarize(input, replayRunner(kept)))?.facts).toHaveLength(3);
    // The judge's question changed since (here: its kept name is another's). Its
    // old answer must not be scored as this reading, nor as "found nothing".
    const stale = await summarize(input, replayRunner([kept[0]!, { ...kept[1]!, request: "00000000" }])).catch((error: unknown) => error);
    expect(stale).toBeInstanceOf(FactsOwed);
    expect((stale as FactsOwed).cause).toBeInstanceOf(StaleAnswer);
  });

  it("a judge request that still overflows with the shorter opening gives no facts and keeps the summary", async () => {
    let calls = 0;
    const answer = await summarize({ text: POLICY, name: "policy.pdf", categories: ["Documents"], contextSize: 4096, withFacts: true }, async () => {
      calls += 1;
      if (calls >= 2) {
        throw new AssistantError("context-too-long", "");
      }
      return SUMMARY;
    });
    // Asked twice, never a third time: the same request cannot fit later either.
    expect(calls).toBe(3);
    expect(answer).toMatchObject({ summary: "A home insurance policy.", facts: [] });
  });

  it("a judge whose request overflows the window is asked once more with a shorter opening", async () => {
    const long = `${"Terms and conditions apply to every booking made with us. ".repeat(300)}\n${POLICY}`;
    const prompts: number[] = [];
    let calls = 0;
    const answer = await summarize({ text: long, name: "policy.pdf", categories: ["Documents"], contextSize: 4096, withFacts: true }, async (request) => {
      calls += 1;
      if (calls === 1) {
        return SUMMARY;
      }
      prompts.push(request.prompt.length);
      if (calls === 2) {
        throw new AssistantError("context-too-long", "");
      }
      return { d1: "expiry", d2: "due", pays: "yes", total: "a1" };
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]!).toBeLessThan(prompts[0]!);
    expect(answer?.facts).toHaveLength(3);
  });
});

describe("what a file brings to its reading", () => {
  const due: Fact = { id: "due:2027-11-20", kind: "due", document: "invoice", value: "2027-11-20", source: "label", confidence: 0.7 };
  const booked: Fact = { id: "event:2027-04-08 check-in", kind: "event", document: "hotel-booking", value: "2027-04-08", label: "Check-in", source: "jsonld", confidence: 1, accepted: "exact" };
  const stored = { createdAt: Date.UTC(2026, 10, 9, 12), facts: [] as Fact[] };
  const sent = { subject: "Your stay", from: "Casa Azulejo", date: Date.UTC(2027, 2, 2, 9) };

  it("what this same pass already read is what the reading knows, not only what was stored before it", () => {
    // A new upload: the rules have just read the due day; nothing is stored on the file yet.
    expect(readingContext(stored, { mail: false, factsWanted: true, soFar: [due] })).toMatchObject({ known: [due], withFacts: true });
    // A later pass with nothing new: what the file carries.
    expect(readingContext({ ...stored, facts: [due] }, { mail: false, factsWanted: true })).toMatchObject({ known: [due] });
  });

  it("an email whose booking data was read in this same pass is not asked for dates", () => {
    expect(readingContext({ ...stored, mail: sent }, { mail: true, factsWanted: true, soFar: [booked] })).toMatchObject({ withFacts: false });
    expect(readingContext({ ...stored, mail: sent, facts: [booked] }, { mail: true, factsWanted: true })).toMatchObject({ withFacts: false });
    // A stored file with exact data may still hold running words the model can read.
    expect(readingContext(stored, { mail: false, factsWanted: true, soFar: [booked] })).toMatchObject({ withFacts: true });
    expect(readingContext(stored, { mail: false, factsWanted: false })).toMatchObject({ withFacts: false });
  });

  it("an email brings its headers, a stored file the day it was kept", () => {
    const message = readingContext({ ...stored, mail: sent }, { mail: true, factsWanted: true });
    expect(message).toMatchObject({ mail: true, message: { subject: "Your stay", from: "Casa Azulejo", writtenAt: sent.date } });
    expect(message).not.toHaveProperty("keptAt");
    const file = readingContext(stored, { mail: false, factsWanted: true });
    expect(file).toMatchObject({ mail: false, keptAt: stored.createdAt });
    expect(file).not.toHaveProperty("message");
  });
});

describe("messageOf", () => {
  const headers = { subject: "Your water bill", from: "City Water", date: Date.UTC(2027, 2, 2, 9) };

  it("an email's subject, sender and sending day go with its reading", () => {
    expect(messageOf(headers)).toEqual({ subject: "Your water bill", from: "City Water", writtenAt: headers.date });
  });

  it("an email with no readable sending day gives none: a date with no year is not counted from 1970", () => {
    expect(messageOf({ ...headers, date: 0 })).toBeUndefined();
    expect(messageOf(undefined)).toBeUndefined();
  });
});

describe("readingFingerprint", () => {
  it("names the request the reader is sent, so measured scores can be tied to it", () => {
    expect(readingFingerprint()).toMatch(/^[0-9a-f]{8}$/);
    expect(readingFingerprint()).toBe(readingFingerprint());
    // Another list of kinds is another prompt.
    expect(readingFingerprint(["Receipts", "Travel"])).not.toBe(readingFingerprint());
  });
});
