import { describe, expect, it } from "vitest";
import { EDITOR_THEME } from "./editortheme";

/**
 * The code editor draws its gutter, active line, cursor, selection and
 * search panel from its own light defaults unless the app says otherwise,
 * and those defaults beat the app's stylesheet. In the Night theme that
 * left a white gutter beside dark text, and a dark cursor nobody could
 * see. Each part takes the app's own colours instead, so Night and Day
 * both follow the theme the person chose.
 */
describe("the code editor's colours", () => {
  const parts = [".cm-gutters", ".cm-activeLineGutter", ".cm-activeLine", ".cm-cursor, .cm-dropCursor", ".cm-panels", ".cm-tooltip", ".cm-textfield"];

  it("names every part the editor would otherwise draw in light colours", () => {
    expect(parts.filter((part) => !(part in EDITOR_THEME))).toEqual([]);
    expect(Object.keys(EDITOR_THEME).some((key) => key.includes(".cm-selectionBackground"))).toBe(true);
  });

  it("uses the app's colour tokens, never a fixed colour", () => {
    const fixed = Object.entries(EDITOR_THEME).flatMap(([part, style]) =>
      Object.entries(style as Record<string, string>)
        .filter(([, value]) => /#[0-9a-f]{3,8}\b|\brgba?\(|\b(?:black|white)\b/i.test(String(value)))
        .map(([property, value]) => `${part} ${property}: ${value}`),
    );
    expect(fixed).toEqual([]);
    expect(String((EDITOR_THEME[".cm-gutters"] as Record<string, string>).backgroundColor)).toContain("var(--ink-1)");
  });
});
