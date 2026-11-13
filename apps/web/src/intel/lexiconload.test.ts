import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The label table is loaded on first use, apart from the code that reads
 * with it. When it cannot be loaded, a form line is read as it was before
 * there was a table: nothing is dropped and nothing fails.
 */
describe("a label table that cannot be loaded", () => {
  afterEach(() => {
    vi.doUnmock("./tables/labels.json");
    vi.resetModules();
  });

  it("leaves every form line read with its own words", async () => {
    vi.resetModules();
    vi.doMock("./tables/labels.json", () => {
      throw new Error("the table is not there");
    });
    const { scanForFacts } = await import("./scan");
    const out = await scanForFacts({ name: "statement.pdf", mime: "application/pdf", text: "Statement date: 3 February 2027" });
    expect(out.facts.map((fact) => [fact.kind, fact.value, fact.label])).toEqual([["dated", "2027-02-03", "Statement date"]]);
  });

  it("is asked for again the next time", async () => {
    vi.resetModules();
    let asked = 0;
    vi.doMock("./tables/labels.json", () => {
      asked += 1;
      throw new Error("the table is not there");
    });
    const { loadLexicon } = await import("./lexicon");
    expect(await loadLexicon()).toBeUndefined();
    expect(await loadLexicon()).toBeUndefined();
    expect(asked).toBe(2);
  });
});
