/**
 * Markup read as text, and the one rule for which body of a message is
 * read. No DOM is used, so this runs wherever text is extracted.
 */

/** HTML read as text: head, style and script dropped, blocks on their own lines. */
export function htmlToText(html: string): string {
  return xmlToText(
    html
      .replace(/<(head|style|script|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/&nbsp;/gi, " "),
    /<\/(?:p|div|tr|li|h[1-6]|table|blockquote)\s*>/gi,
  );
}

/** Tags stripped, paragraph boundaries kept, entities restored. */
export function xmlToText(xml: string, paragraphEnd: RegExp): string {
  return xml
    .replace(paragraphEnd, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The body of a message as every reader of it gets it: the plain part when
 * the message has one, else the HTML part read as text.
 */
export function mailBodyText(record: { text?: string; html?: string }): string {
  return record.text ?? (record.html ? htmlToText(record.html) : "");
}
