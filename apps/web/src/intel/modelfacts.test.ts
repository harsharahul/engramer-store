import { describe, expect, it } from "vitest";
import { DOCUMENT_KINDS, MODEL_CONFIDENCE, documentKindProperty } from "./modelfacts";
import { summaryWithFactsSchema } from "./summarize";

describe("what the model's readings share with the facts pipeline", () => {
  it("the model may name a document's kind only from the list the facts know", () => {
    expect(documentKindProperty.document.enum).toEqual(DOCUMENT_KINDS);
    expect(DOCUMENT_KINDS).toContain("other");
    expect(new Set(DOCUMENT_KINDS).size).toBe(DOCUMENT_KINDS.length);
  });

  it("the model is never asked to write a date or an amount", () => {
    // The summary's schema names the document's kind and nothing with a value in it.
    expect(Object.keys(summaryWithFactsSchema.properties)).toEqual(["summary", "tags", "kind", "document"]);
  });

  it("the model's word is a lead, below every rule", () => {
    expect(MODEL_CONFIDENCE).toBeLessThan(0.5);
  });
});
