/**
 * Ask your files: a question typed into the search field, answered by the
 * on-device assistant from the few files that can answer it. The model
 * reads about four thousand tokens, so it never reads a library; what is
 * already known about every file (names, tags, summaries, extracted text,
 * all decrypted in memory) picks a handful of sources and the excerpts
 * within them, and the model answers only from those, naming them. Nothing
 * here is stored: not the question, not the excerpts, not the answer.
 *
 * Pure functions, so the retrieval and the budget can be tested without a
 * model.
 */

export const ASK_SOURCE_LIMIT = 5;
export const EXCERPT_CHARS = 600;
export const EXCERPTS_PER_SOURCE = 2;
/** Tokens kept back for the instructions and the answer. */
const RESERVED_TOKENS = 900;
const CHARS_PER_TOKEN = 3;
const MIN_TERM_LENGTH = 3;

const STOPWORDS = new Set([
  "what", "when", "where", "which", "who", "whom", "whose", "why", "how", "does", "did", "do",
  "is", "are", "was", "were", "be", "been", "being", "have", "has", "had", "can", "could",
  "will", "would", "shall", "should", "may", "might", "must", "the", "a", "an", "of", "in",
  "on", "at", "to", "for", "from", "with", "about", "into", "onto", "over", "under", "and",
  "or", "but", "not", "no", "yes", "my", "me", "i", "you", "your", "we", "our", "us", "it",
  "its", "this", "that", "these", "those", "there", "here", "any", "some", "all", "much",
  "many", "last", "next", "still", "just", "please", "ask", "tell", "show", "find",
]);

/** The words worth looking for in a question: the rest is the question. */
export function retrievalTerms(question: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of question.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    const word = raw.trim();
    if (word.length < MIN_TERM_LENGTH || STOPWORDS.has(word) || seen.has(word)) {
      continue;
    }
    seen.add(word);
    terms.push(word);
  }
  return terms;
}

export interface AskFile {
  id: string;
  name: string;
  hasText: boolean;
  trashed: boolean;
  tags: readonly string[];
  text?: string;
  summary?: string;
}

/**
 * The few files most likely to hold the answer. A name says the most, a
 * summary or tag next, the text least (a term appears in many texts);
 * `boosts` carries meaning matches, which share no words with the
 * question and would otherwise never be picked.
 */
export function rankSources<F extends AskFile>(
  files: readonly F[],
  terms: readonly string[],
  boosts: ReadonlyMap<string, number> = new Map(),
): F[] {
  if (terms.length === 0 && boosts.size === 0) {
    return [];
  }
  const scored: Array<{ file: F; score: number }> = [];
  for (const file of files) {
    if (file.trashed) {
      continue;
    }
    let score = boosts.get(file.id) ?? 0;
    const name = file.name.toLowerCase();
    const summary = file.summary?.toLowerCase();
    const text = file.text?.toLowerCase();
    const tags = file.tags.map((tag) => tag.toLowerCase());
    for (const term of terms) {
      if (name.includes(term)) {
        score += 3;
      }
      if (summary?.includes(term)) {
        score += 2;
      }
      if (tags.some((tag) => tag.includes(term))) {
        score += 1.5;
      }
      if (text?.includes(term)) {
        score += 1;
      }
    }
    if (score > 0) {
      scored.push({ file, score });
    }
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, ASK_SOURCE_LIMIT)
    .map((entry) => entry.file);
}

/**
 * Windows of text around the words asked about, merged where they overlap,
 * at most `max` and never longer than `chars`. With no match, the opening.
 */
export function excerpts(text: string, terms: readonly string[], chars = EXCERPT_CHARS, max = EXCERPTS_PER_SOURCE): string[] {
  if (!text) {
    return [];
  }
  const lower = text.toLowerCase();
  const hits: number[] = [];
  for (const term of terms) {
    const at = lower.indexOf(term);
    if (at >= 0) {
      hits.push(at);
    }
  }
  if (hits.length === 0) {
    return [text.slice(0, chars)];
  }
  hits.sort((a, b) => a - b);
  const half = Math.floor(chars / 2);
  const windows: Array<[number, number]> = [];
  for (const at of hits) {
    const start = Math.max(0, at - half);
    const end = Math.min(text.length, start + chars);
    const last = windows[windows.length - 1];
    if (last && start <= last[1]) {
      // Overlapping windows merge, but never beyond one window's width
      // past the first: an excerpt stays an excerpt.
      last[1] = Math.min(end, last[0] + chars);
      continue;
    }
    windows.push([start, end]);
    if (windows.length === max) {
      break;
    }
  }
  return windows.map(([start, end]) => text.slice(start, end));
}

export interface AskSource {
  id: string;
  name: string;
  summary?: string;
  excerpts: string[];
}

/**
 * The prompt, fitted to the model's window: sources in rank order, each
 * with its summary and excerpts, adding material until the budget is spent
 * and dropping the lowest-ranked first. The instructions confine the
 * answer to what is quoted and ask it to name its sources.
 */
export function buildAskPrompt(
  question: string,
  sources: readonly AskSource[],
  contextSize: number,
): { instructions: string; prompt: string; used: string[] } {
  const instructions =
    "You answer a question about someone's own files, only from the excerpts given. " +
    "If the excerpts do not contain the answer, say that they do not. " +
    "Answer in two or three plain sentences and name the file or files the answer came from. " +
    "Never add anything the excerpts do not say.";
  const budget = Math.max(200, (contextSize - RESERVED_TOKENS) * CHARS_PER_TOKEN);
  const head = `Question: ${question}\n\nExcerpts from the files:\n`;
  let body = "";
  const used: string[] = [];
  for (const source of sources) {
    const pieces = [source.summary ? `About: ${source.summary}` : null, ...source.excerpts].filter(
      (piece): piece is string => Boolean(piece),
    );
    // Try the whole source, then fewer pieces, then the name alone.
    for (let keep = pieces.length; keep >= 0; keep -= 1) {
      const block = `\n--- ${source.name}\n${pieces.slice(0, keep).join("\n")}\n`;
      if (head.length + body.length + block.length <= budget) {
        body += block;
        used.push(source.id);
        break;
      }
    }
    if (used[used.length - 1] !== source.id) {
      break;
    }
  }
  return { instructions, prompt: head + body, used };
}
