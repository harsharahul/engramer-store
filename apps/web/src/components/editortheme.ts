/**
 * The code editor's colours, from the app's own tokens.
 *
 * CodeMirror paints its gutter, active line, cursor, selection and panels
 * from built-in light defaults, and those rules outrank the app's layered
 * stylesheet. Naming each part here, in the editor's own theme, is the one
 * place that wins; the tokens then follow Night and Day like the rest of
 * the app.
 */
import { EditorView } from "@codemirror/view";

export const EDITOR_THEME: Record<string, Record<string, string>> = {
  "&": { height: "100%", fontSize: "14px", color: "var(--paper)", backgroundColor: "var(--ink-1)" },
  ".cm-scroller": { fontFamily: "var(--font-mono)" },
  ".cm-content": { caretColor: "var(--paper)" },
  ".cm-gutters": {
    backgroundColor: "var(--ink-1)",
    color: "var(--paper-faint)",
    borderRight: "1px solid var(--hairline)",
  },
  ".cm-activeLineGutter": { backgroundColor: "var(--accent-dim)", color: "var(--paper-dim)" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--accent) 7%, transparent)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--paper)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "color-mix(in srgb, var(--accent) 30%, transparent)",
  },
  ".cm-panels": { backgroundColor: "var(--ink-2)", color: "var(--paper)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--hairline-strong)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--hairline-strong)" },
  ".cm-tooltip": { backgroundColor: "var(--ink-2)", color: "var(--paper)", border: "1px solid var(--hairline-strong)" },
  // The app sizes every input to the full width of its row; the search
  // panel's fields and boxes keep the size the editor gives them.
  ".cm-textfield": {
    width: "auto",
    backgroundColor: "var(--ink-1)",
    color: "var(--paper)",
    border: "1px solid var(--hairline-strong)",
  },
  ".cm-panel.cm-search input[type=checkbox]": {
    width: "auto",
    padding: "0",
    margin: "0 4px 0 0",
    verticalAlign: "middle",
    accentColor: "var(--accent)",
  },
  ".cm-panel.cm-search label": { color: "var(--paper-dim)" },
  ".cm-button": { backgroundImage: "none", backgroundColor: "var(--ink-3)", color: "var(--paper)", border: "1px solid var(--hairline-strong)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--ink-3)", color: "var(--paper-dim)", border: "none" },
};

export const editorTheme = EditorView.theme(EDITOR_THEME);
