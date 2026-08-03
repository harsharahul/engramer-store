/**
 * Turning what the user handed us (a drop, a folder picker) into a flat list
 * of files with their relative paths, plus the folder plan that recreates the
 * tree. Transfers are typically nested and full of small files; everything
 * here is built for that shape.
 */

export interface TreeFile {
  file: File;
  /** Folder path relative to the drop root, e.g. ["photos", "2026"]. */
  path: string[];
  /**
   * Tags to add on top of whatever analysis finds. Watched folders use this
   * to record where a file came from, which is the only trace left once
   * auto-filing has moved it into a category folder.
   */
  tags?: string[];
}

/** Files picked through an <input webkitdirectory>: paths ride on the File. */
export function fromDirectoryInput(files: File[]): TreeFile[] {
  return files.map((file) => {
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? "";
    const parts = relative.split("/").filter(Boolean);
    // The last segment is the file name itself.
    return { file, path: parts.slice(0, -1) };
  });
}

interface EntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file: (ok: (f: File) => void, err: (e: unknown) => void) => void;
  createReader: () => {
    readEntries: (ok: (entries: EntryLike[]) => void, err: (e: unknown) => void) => void;
  };
}

/**
 * Recursively collects a drag-and-drop payload, folders included. Directory
 * readers return entries in batches and signal completion with an empty
 * batch, so each directory is drained in a loop.
 */
export async function collectDropped(dataTransfer: DataTransfer): Promise<TreeFile[]> {
  const entries: Array<{ entry: EntryLike; path: string[] }> = [];
  for (const item of Array.from(dataTransfer.items)) {
    // The DOM lib types the entry API loosely; EntryLike is the shape the
    // browsers actually provide.
    const entry = item.webkitGetAsEntry?.() as unknown as EntryLike | null;
    if (entry) {
      entries.push({ entry, path: [] });
    }
  }
  if (entries.length === 0) {
    // No entry API (or plain files): fall back to the flat list.
    return Array.from(dataTransfer.files).map((file) => ({ file, path: [] }));
  }

  const out: TreeFile[] = [];
  while (entries.length > 0) {
    const { entry, path } = entries.shift()!;
    if (entry.isFile) {
      const file = await new Promise<File | null>((resolve) =>
        entry.file(resolve, () => resolve(null)),
      );
      if (file) {
        out.push({ file, path });
      }
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise<EntryLike[]>((resolve) =>
          reader.readEntries(resolve, () => resolve([])),
        );
        if (batch.length === 0) {
          break;
        }
        for (const child of batch) {
          entries.push({ entry: child, path: [...path, entry.name] });
        }
      }
    }
  }
  return out;
}

/** Collision-proof key for a folder path (names may contain any character). */
export function pathKey(path: string[]): string {
  return path.join("\u0000");
}

/** Every distinct folder path in the batch, parents before children. */
export function folderPlan(items: TreeFile[]): string[][] {
  const seen = new Set<string>();
  const plan: string[][] = [];
  for (const item of items) {
    for (let depth = 1; depth <= item.path.length; depth++) {
      const prefix = item.path.slice(0, depth);
      const key = pathKey(prefix);
      if (!seen.has(key)) {
        seen.add(key);
        plan.push(prefix);
      }
    }
  }
  // Parents first, stable within a depth.
  return plan.sort((a, b) => a.length - b.length);
}

/**
 * A small bounded worker pool: run `work` over every item with at most
 * `limit` in flight, preserving nothing about order. Errors are delivered to
 * the caller per item rather than aborting the batch.
 */
export async function boundedRun<T>(
  items: T[],
  limit: number,
  work: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) {
        return;
      }
      await work(items[index]!, index);
    }
  });
  await Promise.all(lanes);
}
