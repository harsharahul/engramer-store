import DOMPurify from "dompurify";
import { marked } from "marked";

/**
 * Text files by language, and Markdown rendered safely. The editor picks
 * highlighting from this; the preview renders Markdown to HTML and runs
 * it through a sanitizer, so a note from a stranger cannot carry script
 * into the vault's origin.
 */

export type TextLanguage = "markdown" | "json" | "javascript" | "yaml" | "html" | "css" | "plain";

export function languageFor(name: string, mime: string): TextLanguage {
  const lower = name.toLowerCase();
  if (/\.(md|markdown|mdx)$/.test(lower) || mime === "text/markdown") return "markdown";
  if (/\.(json|jsonc|geojson)$/.test(lower) || mime === "application/json") return "json";
  if (/\.(js|mjs|cjs|jsx|ts|tsx)$/.test(lower)) return "javascript";
  if (/\.(ya?ml)$/.test(lower)) return "yaml";
  if (/\.(html?|xml|svg)$/.test(lower)) return "html";
  if (/\.(css|scss|less)$/.test(lower)) return "css";
  return "plain";
}

marked.setOptions({ gfm: true, breaks: false });

export function renderMarkdown(source: string): string {
  const html = marked.parse(source, { async: false }) as string;
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "iframe", "object", "embed", "form", "input"],
    FORBID_ATTR: ["onerror", "onload", "style"],
    ADD_ATTR: ["target", "rel"],
  });
}
