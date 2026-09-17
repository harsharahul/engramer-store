// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { languageFor, renderMarkdown } from "./textkinds";

describe("text kinds", () => {
  it("names a language from the file name or type", () => {
    expect(languageFor("notes.md", "")).toBe("markdown");
    expect(languageFor("x", "text/markdown")).toBe("markdown");
    expect(languageFor("config.yaml", "text/plain")).toBe("yaml");
    expect(languageFor("app.tsx", "")).toBe("javascript");
    expect(languageFor("data.json", "")).toBe("json");
    expect(languageFor("todo.txt", "text/plain")).toBe("plain");
  });

  it("renders Markdown and strips anything that could run", () => {
    const html = renderMarkdown("# Title\n\nHello **world** <script>alert(1)</script> <img src=x onerror=alert(1)>");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>world</strong>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
  });
});
