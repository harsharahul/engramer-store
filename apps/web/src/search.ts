import type { FileEntry } from "./store";

export interface SearchHit {
  file: FileEntry;
  score: number;
  matchedText: string | null;
}

/**
 * Client-side search over decrypted metadata: fuzzy subsequence match on file
 * names plus substring match on extracted text content. The ciphertext on the
 * server is never involved; all intelligence runs on the user's device.
 */
export function searchFiles(files: Iterable<FileEntry>, query: string): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return [];
  }
  const hits: SearchHit[] = [];
  for (const file of files) {
    if (file.trashed) {
      continue;
    }
    const nameScore = fuzzyScore(file.name.toLowerCase(), q);
    let contentSnippet: string | null = null;
    if (file.text) {
      const index = file.text.toLowerCase().indexOf(q);
      if (index >= 0) {
        contentSnippet = snippet(file.text, index, q.length);
      }
    }
    if (nameScore > 0 || contentSnippet) {
      hits.push({
        file,
        score: Math.max(nameScore, contentSnippet ? 0.5 : 0),
        matchedText: contentSnippet,
      });
    }
  }
  return hits.sort((a, b) => b.score - a.score);
}

/** Subsequence match: all query characters in order, rewarded for tightness. */
function fuzzyScore(haystack: string, needle: string): number {
  if (haystack.includes(needle)) {
    return 1 + needle.length / haystack.length;
  }
  let hi = 0;
  let firstMatch = -1;
  let lastMatch = -1;
  for (let ni = 0; ni < needle.length; ni++) {
    const found = haystack.indexOf(needle[ni]!, hi);
    if (found === -1) {
      return 0;
    }
    if (firstMatch === -1) {
      firstMatch = found;
    }
    lastMatch = found;
    hi = found + 1;
  }
  const spread = lastMatch - firstMatch + 1;
  return (needle.length / spread) * 0.9;
}

function snippet(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + length + 60);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end).replaceAll("\n", " ")}${suffix}`;
}
