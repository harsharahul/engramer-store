/**
 * In-app diagnostics: a small ring buffer of what the client actually did,
 * for the moments when "it felt stuck" needs evidence. Lives only in this
 * tab's memory; nothing here is ever transmitted or persisted, in keeping
 * with the rest of the product.
 */

export interface DiagEntry {
  at: number;
  tag: string;
  message: string;
}

const MAX_ENTRIES = 500;
const entries: DiagEntry[] = [];
const listeners = new Set<() => void>();

export function diag(tag: string, message: string): void {
  entries.push({ at: Date.now(), tag, message });
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
  }
  listeners.forEach((listener) => listener());
}

export function diagEntries(): readonly DiagEntry[] {
  return entries;
}

export function onDiag(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function clearDiag(): void {
  entries.length = 0;
  listeners.forEach((listener) => listener());
}

export function diagText(): string {
  return entries
    .map((e) => `${new Date(e.at).toISOString()} [${e.tag}] ${e.message}`)
    .join("\n");
}
