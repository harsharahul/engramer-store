import type { UploadSource } from "./transfer";

/**
 * Files from the shell, without the bytes.
 *
 * A picked video used to cross the bridge whole: one command returned the
 * entire file, the IPC serialized it, and the page copied it again into a
 * memory-backed File. A 30-second clip was hundreds of megabytes resident
 * before the first uploaded byte, and iOS killed the app. The streaming
 * upload never had a chance: it slices its source 4 MiB at a time, but
 * only a disk-backed source makes those slices cheap.
 *
 * `NativePickedFile` restores that property for shell files: a handle
 * carrying name, type and size, whose slices fetch bounded windows over
 * the bridge on demand. Nothing larger than one window is ever in flight.
 * Media elements get `mediaUrl`, a range-served native protocol, the same
 * way playback already streams vault content.
 */

type ShellInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/** The largest single read asked of the shell; one IPC answer's bound. */
const READ_WINDOW = 4 * 1024 * 1024;

/**
 * File content as bytes, whatever shape the shell hands it over in.
 *
 * This crossing has no type safety: the value arrives as JSON from another
 * process, and declaring it an ArrayBuffer only asserted a hope. It arrives
 * as a plain array of byte values, and `new Blob([array])` does not reject
 * that: it stringifies it, so a PDF became the text "37,80,68,70,..." and
 * every file a watched folder uploaded was silently corrupted, at three and
 * a half times its real size. Convert rather than assert.
 */
export function fileBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) {
    return Uint8Array.from(value as number[]);
  }
  throw new Error("the shell returned something that is not file content");
}

/**
 * The type a picked file's name implies, or "" when the name does not say.
 *
 * The shell hands over paths rather than browser `File`s, so nothing sets a
 * type and everything downstream branches on one. Only the formats a photo
 * library actually holds are listed: an empty answer is honest and can be
 * recovered from the name later, a wrong one cannot.
 */
export function mimeFromName(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const known: Record<string, string> = {
    heic: "image/heic",
    heif: "image/heif",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    tiff: "image/tiff",
    dng: "image/x-adobe-dng",
    mov: "video/quicktime",
    mp4: "video/mp4",
    m4v: "video/x-m4v",
  };
  return known[ext] ?? "";
}

/**
 * Which shell command family serves this handle. "picked" is the picker's
 * staging directory: read by basename, deleted when the upload settles.
 * "watched" is the person's own watched folders: read by full path
 * through the same protocol's watched route, and NEVER deleted; those
 * files are theirs, an upload only looks.
 */
type SourceFamily = "picked" | "watched";

export class NativePickedFile implements UploadSource {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  readonly lastModified: number;
  readonly mediaUrl: string;
  /** The library asset this came from, when the picker said. */
  readonly sourceId?: string;
  private readonly family: SourceFamily;
  private disposed = false;

  constructor(
    private readonly invoke: ShellInvoke,
    private readonly path: string,
    meta: { name: string; type: string; size: number; lastModified: number },
    opts?: { family?: SourceFamily; sourceId?: string },
  ) {
    this.name = meta.name;
    this.type = meta.type;
    this.size = meta.size;
    this.lastModified = meta.lastModified;
    this.family = opts?.family ?? "picked";
    if (opts?.sourceId !== undefined) {
      this.sourceId = opts.sourceId;
    }
    if (this.family === "watched") {
      this.mediaUrl = `picked://localhost/watched?p=${encodeURIComponent(this.path)}`;
    } else {
      const basename = this.path.split("/").pop() || this.name;
      this.mediaUrl = `picked://localhost/${encodeURIComponent(basename)}`;
    }
  }

  private async read(offset: number, length: number): Promise<Uint8Array> {
    const command =
      this.family === "watched" ? "watched_file_read_range" : "picked_file_read_range";
    const bytes = fileBytes(await this.invoke(command, { path: this.path, offset, length }));
    // The size came from a stat, the bytes from a read: two sources, so
    // they can disagree, and when they do the stored file would be wrong.
    if (bytes.length !== length) {
      throw new Error(`read ${bytes.length} bytes of a ${length} byte window`);
    }
    return bytes;
  }

  slice(start = 0, end = this.size): { size: number; arrayBuffer(): Promise<ArrayBuffer> } {
    const from = Math.max(0, Math.min(start, this.size));
    const to = Math.max(from, Math.min(end, this.size));
    const size = to - from;
    return {
      size,
      arrayBuffer: async () => {
        const bytes = await this.readSpan(from, size);
        return bytes.buffer as ArrayBuffer;
      },
    };
  }

  /** A span of any size, fetched as bounded windows. */
  private async readSpan(offset: number, length: number): Promise<Uint8Array> {
    const assembled = new Uint8Array(length);
    let done = 0;
    while (done < length) {
      const window = Math.min(READ_WINDOW, length - done);
      assembled.set(await this.read(offset + done, window), done);
      done += window;
    }
    return assembled;
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return (await this.readSpan(0, this.size)).buffer as ArrayBuffer;
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(await this.readSpan(0, this.size));
  }

  /** Removes a staged file on disk; safe to call more than once, and a
   * no-op for watched files, which are never this code's to delete. */
  async dispose(): Promise<void> {
    if (this.disposed || this.family === "watched") {
      return;
    }
    this.disposed = true;
    await this.invoke("picked_file_delete", { path: this.path }).catch(() => {});
  }
}

/**
 * What the analysis slot works on. Image decoders need a real Blob
 * (createImageBitmap has no URL form), and images are small enough to
 * hold, so an image handle becomes a File here, inside the slot that
 * bounds how many are held at once; its staged copy is deleted, the bytes
 * now being the File. Video and audio stay as handles: their decoders
 * take `mediaUrl`, and holding a video is exactly the crash this module
 * exists to end. Real Files pass through untouched.
 */
export async function materializeForAnalysis(source: UploadSource): Promise<UploadSource> {
  if (!(source instanceof NativePickedFile)) {
    return source;
  }
  if (source.type.startsWith("video/") || source.type.startsWith("audio/")) {
    return source;
  }
  const bytes = await source.arrayBuffer();
  await source.dispose();
  return new File([bytes], source.name, {
    type: source.type,
    lastModified: source.lastModified,
  });
}
