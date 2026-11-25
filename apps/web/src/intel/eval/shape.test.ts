import { describe, expect, it } from "vitest";
import { htmlToText, mailBodyText } from "../htmltext";
import { EVAL_CASES } from "./cases";
import { flatPages } from "./shape";
import { STRUCTURE_CASES } from "./structurecases";

describe("flatPages: a stored file as a page with no lines", () => {
  it("joins the lines and the cells of a page with single spaces", () => {
    expect(flatPages("A: 1\nB | C\n\nD")).toBe("A: 1 B C D");
    expect(flatPages("  one  \r\n two\n")).toBe("one two");
    expect(flatPages("")).toBe("");
  });
});

describe("a mail's body, one rule for every reader of it", () => {
  it("is the plain part when the message has one, else the HTML read as text", () => {
    expect(mailBodyText({ text: "Hello there.", html: "<p>Hello <b>there</b>.</p>" })).toBe("Hello there.");
    expect(mailBodyText({ html: "<p>Hello <b>there</b>.</p>" })).toBe(htmlToText("<p>Hello <b>there</b>.</p>"));
    expect(mailBodyText({})).toBe("");
  });
});

describe("the structure cases of the first set", () => {
  it("are thirty, each id once, eighteen of them HTML mail", () => {
    expect(STRUCTURE_CASES).toHaveLength(30);
    expect(new Set(STRUCTURE_CASES.map((c) => c.id)).size).toBe(30);
    expect(STRUCTURE_CASES.every((c) => c.id.startsWith("s-"))).toBe(true);
    expect(STRUCTURE_CASES.filter((c) => c.html !== undefined)).toHaveLength(18);
    expect(EVAL_CASES.filter((c) => c.id.startsWith("s-"))).toHaveLength(30);
  });

  it("an HTML mail's text is what the app's own step makes of its body, and the body rides as raw", () => {
    for (const evalCase of STRUCTURE_CASES.filter((c) => c.html !== undefined)) {
      expect({ id: evalCase.id, text: evalCase.text }).toEqual({ id: evalCase.id, text: mailBodyText({ html: evalCase.html! }) });
      expect({ id: evalCase.id, raw: evalCase.raw === evalCase.html }).toEqual({ id: evalCase.id, raw: true });
      expect(evalCase.mime).toBe("application/vnd.engram.email+json");
    }
  });

  it("a stored-file case is lined text with at least one row of cells", () => {
    for (const evalCase of STRUCTURE_CASES.filter((c) => c.html === undefined)) {
      expect({ id: evalCase.id, mime: evalCase.mime }).toEqual({ id: evalCase.id, mime: "application/pdf" });
      expect({ id: evalCase.id, rows: evalCase.text.split("\n").some((line) => line.includes(" | ")) }).toEqual({ id: evalCase.id, rows: true });
    }
  });
});
