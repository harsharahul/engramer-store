import { diag } from "../diag";

/**
 * Page-side client for the format converter that runs in x2t-worker.js.
 *
 * One converter is held per open document: importing a document leaves its
 * images in the worker's working directory, and exporting reads them back
 * from there, so open and save must share a worker or every image is lost.
 * Closing the document terminates it, which is also what frees the engine's
 * memory.
 */

export interface ImportedDocument {
  /** The document in the editor's internal format. */
  bin: Uint8Array;
  /** Extracted images, by the name the editor asks for. */
  media: Record<string, Uint8Array>;
}

interface Pending {
  resolve: (value: never) => void;
  reject: (reason: Error) => void;
}

export class Converter {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private next = 1;

  constructor() {
    this.worker = new Worker("/x2t-worker.js");
    this.worker.onmessage = (event: MessageEvent) => {
      const { id, error, ...rest } = event.data ?? {};
      const waiting = this.pending.get(id);
      if (!waiting) {
        return;
      }
      this.pending.delete(id);
      if (error) {
        waiting.reject(new Error(String(error)));
      } else {
        (waiting.resolve as (value: unknown) => void)(rest);
      }
    };
    this.worker.onerror = (event) => {
      const failure = new Error(event.message || "the converter stopped");
      for (const waiting of this.pending.values()) {
        waiting.reject(failure);
      }
      this.pending.clear();
    };
  }

  private send<T>(message: Record<string, unknown>, transfer: Transferable[]): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as never, reject });
      this.worker.postMessage({ ...message, id }, transfer);
    });
  }

  /**
   * Converts a document into the editor's format. `name` carries the file
   * extension, which is how the converter chooses a parser.
   */
  async importDocument(name: string, bytes: Uint8Array): Promise<ImportedDocument> {
    const started = performance.now();
    const copy = bytes.slice();
    const result = await this.send<ImportedDocument>({ op: "import", name, bytes: copy }, [
      copy.buffer,
    ]);
    diag(
      "office",
      `imported ${name} in ${Math.round(performance.now() - started)}ms, ` +
        `${Object.keys(result.media).length} image(s)`,
    );
    return result;
  }

  /** Converts the edited document back to its original format. */
  async exportDocument(name: string, bin: Uint8Array): Promise<Uint8Array> {
    const started = performance.now();
    const copy = bin.slice();
    const result = await this.send<{ bytes: Uint8Array }>({ op: "export", name, bytes: copy }, [
      copy.buffer,
    ]);
    diag("office", `exported ${name} in ${Math.round(performance.now() - started)}ms`);
    return result.bytes;
  }

  close(): void {
    this.worker.terminate();
    for (const waiting of this.pending.values()) {
      waiting.reject(new Error("the editor was closed"));
    }
    this.pending.clear();
  }
}
