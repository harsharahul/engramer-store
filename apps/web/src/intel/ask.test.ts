import { describe, expect, it } from "vitest";
import {
  ASK_SOURCE_LIMIT,
  buildAskPrompt,
  excerpts,
  rankSources,
  retrievalTerms,
  type AskFile,
} from "./ask";

const file = (over: Partial<AskFile> & { id: string; name: string }): AskFile => ({
  hasText: false,
  trashed: false,
  tags: [],
  ...over,
});

describe("retrievalTerms", () => {
  it("keeps the words worth looking for and drops the question around them", () => {
    expect(retrievalTerms("What did I pay Acme for the drill?")).toEqual(["pay", "acme", "drill"]);
    expect(retrievalTerms("when does my passport expire")).toEqual(["passport", "expire"]);
    expect(retrievalTerms("Is it?")).toEqual([]);
  });
});

describe("rankSources", () => {
  const files: AskFile[] = [
    file({ id: "a", name: "acme-invoice.pdf", hasText: true, text: "Acme Hardware invoice. Total paid 128.40 for a drill." }),
    file({ id: "b", name: "scan-0042.pdf", hasText: true, summary: "A receipt from Acme for garden tools." }),
    file({ id: "c", name: "holiday.jpg" }),
    file({ id: "d", name: "acme-quote.pdf", hasText: true, trashed: true, text: "Acme quote for a drill." }),
    file({ id: "e", name: "notes.txt", hasText: true, text: "Remember the drill bit sizes.", tags: ["acme"] }),
  ];

  it("ranks a name above a tag and text, above a summary alone, and leaves out the unrelated and the trashed", () => {
    const ranked = rankSources(files, ["acme", "drill"]);
    expect(ranked.map((f) => f.id)).toEqual(["a", "e", "b"]);
  });

  it("lets a meaning match lift a file that shares no words", () => {
    const ranked = rankSources(files, ["hardware"], new Map([["c", 0.5]]));
    expect(ranked.map((f) => f.id)).toEqual(["a", "c"]);
  });

  it("returns nothing for nothing", () => {
    expect(rankSources(files, [])).toEqual([]);
    expect(rankSources(files, ["zeppelin"])).toEqual([]);
  });

  it("stops at the source limit", () => {
    const many = Array.from({ length: 12 }, (_, i) => file({ id: `m${i}`, name: `acme-${i}.txt`, hasText: true, text: "acme" }));
    expect(rankSources(many, ["acme"])).toHaveLength(ASK_SOURCE_LIMIT);
  });
});

describe("excerpts", () => {
  const text = `${"Preamble text. ".repeat(60)}The drill cost 128.40 at Acme.${" Filler. ".repeat(120)}Warranty on the drill lasts two years.${" Tail. ".repeat(40)}`;

  it("cuts windows around the words asked about, at most two, never longer than the cap", () => {
    const got = excerpts(text, ["drill", "warranty"], 200, 2);
    expect(got).toHaveLength(2);
    expect(got[0]).toContain("drill cost");
    expect(got[1]).toContain("Warranty");
    for (const piece of got) {
      expect(piece.length).toBeLessThanOrEqual(200);
    }
  });

  it("merges windows that overlap and falls back to the opening when nothing matches", () => {
    const close = "The drill and the warranty sit in one sentence together.";
    expect(excerpts(close, ["drill", "warranty"], 200, 2)).toEqual([close]);
    expect(excerpts(text, ["zeppelin"], 100, 2)).toEqual([text.slice(0, 100)]);
    expect(excerpts("", ["drill"], 100, 2)).toEqual([]);
  });
});

describe("buildAskPrompt", () => {
  const sources = [
    { id: "a", name: "acme-invoice.pdf", summary: "An Acme invoice.", excerpts: ["Total paid 128.40 for a drill."] },
    { id: "b", name: "scan-0042.pdf", excerpts: ["A receipt from Acme for garden tools.", "Paid in cash."] },
  ];

  it("asks only from the excerpts and names every file it used", () => {
    const built = buildAskPrompt("What did I pay Acme for the drill?", sources, 4096);
    expect(built.instructions).toMatch(/only from the excerpts/i);
    expect(built.prompt).toContain("acme-invoice.pdf");
    expect(built.prompt).toContain("Total paid 128.40");
    expect(built.prompt).toContain("What did I pay Acme for the drill?");
    expect(built.used).toEqual(["a", "b"]);
  });

  it("never exceeds the window, dropping the lowest-ranked material first", () => {
    let seed = 11;
    const rand = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    for (let i = 0; i < 300; i++) {
      const many = Array.from({ length: 1 + Math.floor(rand() * 6) }, (_, n) => ({
        id: String(n),
        name: `file-${n}.pdf`,
        summary: rand() < 0.5 ? "s".repeat(Math.floor(rand() * 240)) : undefined,
        excerpts: Array.from({ length: Math.floor(rand() * 3) }, () => "x".repeat(Math.floor(rand() * 700))),
      }));
      const contextSize = 1200 + Math.floor(rand() * 7000);
      const built = buildAskPrompt("A short question?", many, contextSize);
      const budget = (contextSize - 900) * 3;
      expect(built.prompt.length).toBeLessThanOrEqual(budget);
      // The first source is always the last to go.
      if (built.used.length > 0) {
        expect(built.used[0]).toBe("0");
      }
    }
  });
});
