import { describe, expect, it } from "vitest";
import { AssistantError } from "./assistant";
import {
  ASSIST_VERSION,
  cleanTags,
  headChunk,
  needsSummary,
  outcomeFor,
  sanitizeSummary,
  summarize,
  summarySchema,
  SUMMARY_MAX,
} from "./summarize";

const file = (over: Partial<Parameters<typeof needsSummary>[0]> = {}) => ({
  trashed: false,
  hasText: true,
  inlineText: false,
  mime: "application/pdf",
  assistVersion: undefined as number | undefined,
  noSummary: undefined as string | undefined,
  ...over,
});

describe("needsSummary", () => {
  it("wants a summary for a text-bearing file the current model has not seen", () => {
    expect(needsSummary(file(), ASSIST_VERSION)).toBe(true);
    expect(needsSummary(file({ assistVersion: ASSIST_VERSION }), ASSIST_VERSION)).toBe(false);
  });

  it("never asks again for a file the model declined, until the model changes", () => {
    const declined = file({ assistVersion: ASSIST_VERSION, noSummary: "declined" });
    expect(needsSummary(declined, ASSIST_VERSION)).toBe(false);
    expect(needsSummary(declined, ASSIST_VERSION + 1)).toBe(true);
    const removed = file({ assistVersion: ASSIST_VERSION, noSummary: "user" });
    expect(needsSummary(removed, ASSIST_VERSION)).toBe(false);
  });

  it("leaves photos, videos, trashed files, and files with no text alone", () => {
    expect(needsSummary(file({ mime: "image/jpeg" }), ASSIST_VERSION)).toBe(false);
    expect(needsSummary(file({ mime: "video/mp4", hasText: true }), ASSIST_VERSION)).toBe(false);
    expect(needsSummary(file({ trashed: true }), ASSIST_VERSION)).toBe(false);
    expect(needsSummary(file({ hasText: false, inlineText: false }), ASSIST_VERSION)).toBe(false);
    expect(needsSummary(file({ hasText: false, inlineText: true }), ASSIST_VERSION)).toBe(true);
  });
});

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
    expect(outcomeFor(new AssistantError("timeout", ""))).toBeNull();
    expect(outcomeFor(new AssistantError("cancelled", ""))).toBeNull();
    expect(outcomeFor(new Error("boom"))).toBeNull();
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
    });
    expect(calls[0]!.priority).toBe("background");
    expect(calls[0]!.schema).toBe(summarySchema);
    expect(String(calls[0]!.prompt)).toContain("acme.pdf");
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
