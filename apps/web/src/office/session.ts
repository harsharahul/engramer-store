/**
 * Talks to the office editor running in the sandboxed frame.
 *
 * The vendored suite comes in two halves: an editor document, and a wrapper
 * script meant to run on the hosting page, which creates the editor's frame
 * and speaks to it. We load the editor document directly and speak that
 * protocol from here instead. That is what lets the editor be a single
 * sandboxed document: nested sandboxed documents each get their own opaque
 * origin and cannot reach one another, so a wrapper that creates a further
 * frame forces the whole thing onto a second real origin, with storage and a
 * cookie surface of its own. One document needs neither.
 *
 * The protocol is small. The editor announces itself and is given a config
 * and a document; from then on it talks to what it believes is a
 * collaboration server, asking to be authenticated, taking and releasing
 * locks. All of it is answered here, in memory. Nothing goes near a network,
 * and the frame is never given anything but bytes.
 */

import type { BridgeEffects, CollabBridge, EngineMessage, OutFrame } from "./collab";

export type FileType = "docx" | "xlsx";

const APP_BY_TYPE: Record<FileType, string> = {
  docx: "documenteditor",
  xlsx: "spreadsheeteditor",
};

/**
 * The address the editor is given for its document. It is not a real URL:
 * the shim inside the frame answers it from bytes posted in. A blob: URL
 * would be simpler but cannot cross into an opaque origin, and inlining the
 * document imposes a size ceiling; see apps/web/office/engram-sandbox-shim.js.
 */
const DOCUMENT_URL = "engram:document";

/** The single local participant. There is no one else to collaborate with. */
const PARTICIPANTS = {
  list: [{ id: "0", idOriginal: "0", username: "you", indexUser: 0, connectionId: "local" }],
  index: 0,
};

/**
 * The frame's address. The editor reads these parameters from its own URL:
 * they decide the loader's shape and, in parentOrigin, which sender it will
 * accept messages from. The config proper arrives by message.
 */
export function editorFrameUrl(fileType: FileType): string {
  const params = new URLSearchParams({
    _dc: "0",
    lang: "en",
    type: "desktop",
    frameEditorId: "engram-editor",
    isForm: "false",
    compact: "true",
    parentOrigin: window.origin,
    fileType,
  });
  return `/office/web-apps/apps/${APP_BY_TYPE[fileType]}/main/index.html?${params}`;
}

export interface SessionHandlers {
  /** The editor is up and asking for its document. */
  onLoading(): void;
  /** The document is open and editable. */
  onReady(): void;
  /** The document has unsaved changes. */
  onChanged(modified: boolean): void;
  /** A shortcut pressed inside the frame, which this page cannot see. */
  onShortcut(name: string): void;
  onFailed(error: string): void;
  /** A durable frame the bridge wants sealed and posted to the channel. */
  onPost?(frame: OutFrame): void;
  /** An ephemeral frame (cursor, presence) for the channel. */
  onEph?(frame: OutFrame): void;
}

interface OOMessage {
  type?: string;
  isSave?: boolean;
  openCmd?: { url?: string };
  /** The engine's messages carry more; the bridge reads them as data. */
  [key: string]: unknown;
}

/**
 * Every answer the page gives to the engine's collaboration chatter, as
 * data. Without a bridge these are the single-user answers that have
 * shipped since office editing existed, reproduced byte for byte and held
 * there by their own regression tests; with a bridge attached the same
 * questions route to the real membership, locks and change log. One branch,
 * so the single-user path cannot drift by accident.
 */
export function answerServerMessage(message: OOMessage, collab?: CollabBridge): BridgeEffects {
  if (collab) {
    return collab.onEngineMessage(message as EngineMessage);
  }
  const effects: BridgeEffects = { toEditor: [], post: [], eph: [] };
  switch (message.type) {
    case "auth":
      effects.toEditor.push({ type: "authChanges", changes: [] });
      effects.toEditor.push({
        type: "auth",
        result: 1,
        sessionId: "session-id",
        participants: PARTICIPANTS.list,
        locks: [],
        changes: [],
        changesIndex: 0,
        indexUser: PARTICIPANTS.index,
        buildVersion: "5.2.6",
        buildNumber: 2,
        licenseType: 3,
      });
      effects.toEditor.push({
        type: "documentOpen",
        data: {
          type: "open",
          status: "ok",
          data: { "Editor.bin": message.openCmd?.url ?? DOCUMENT_URL },
        },
      });
      return effects;
    case "isSaveLock":
      effects.toEditor.push({ type: "saveLock", saveLock: false });
      return effects;
    case "getLock":
      effects.toEditor.push({ type: "getLock", locks: {} });
      return effects;
    case "saveChanges":
      effects.toEditor.push({ type: "unSaveLock", index: 0, time: Date.now() });
      return effects;
    case "unLockDocument":
      if (message.isSave) {
        effects.toEditor.push({ type: "unSaveLock", time: -1, index: -1 });
      }
      return effects;
    case "getMessages":
      effects.toEditor.push({ type: "message" });
      return effects;
    default:
      return effects;
  }
}

export class EditorSession {
  private readonly frame: HTMLIFrameElement;
  private readonly fileType: FileType;
  private readonly title: string;
  private readonly handlers: SessionHandlers;
  private readonly rpcPending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private rpcSeq = 0;
  private closed = false;

  constructor(
    frame: HTMLIFrameElement,
    fileType: FileType,
    title: string,
    handlers: SessionHandlers,
    collab?: CollabBridge,
  ) {
    this.frame = frame;
    this.fileType = fileType;
    this.title = title;
    this.handlers = handlers;
    this.collab = collab;
    window.addEventListener("message", this.onMessage);
  }

  private readonly collab: CollabBridge | undefined;

  /** Feeds bridge effects (remote frames, acks, membership) to the engine. */
  applyEffects(effects: BridgeEffects): void {
    for (const message of effects.toEditor) {
      this.toEditor(message);
    }
    for (const frame of effects.post) {
      this.handlers.onPost?.(frame);
    }
    for (const frame of effects.eph) {
      this.handlers.onEph?.(frame);
    }
  }

  close(): void {
    this.closed = true;
    window.removeEventListener("message", this.onMessage);
    for (const waiting of this.rpcPending.values()) {
      waiting.reject(new Error("the editor was closed"));
    }
    this.rpcPending.clear();
  }

  /**
   * Hands the converted document and its images to the frame. Safe to call
   * at any point: the shim holds them until the editor asks, so the editor's
   * own several megabytes can load while the file is still being decrypted.
   */
  deliver(bin: Uint8Array, media: Record<string, Uint8Array>): void {
    const copy = bin.slice();
    this.frame.contentWindow?.postMessage({ t: "engramDocument", bytes: copy, media }, "*", [
      copy.buffer,
    ]);
  }

  /**
   * The document as the editor holds it, in its internal format. A prefixed
   * string rather than bytes, and it travels unmodified.
   */
  async save(): Promise<string> {
    const value = await this.call("save");
    return typeof value === "string" ? value : "";
  }

  /**
   * Commits whatever the editor is still holding, without saving.
   *
   * A spreadsheet keeps the cell being typed in open, and its text is not
   * part of the document until it is committed, so nothing knows there is
   * anything unsaved. Asking before a document closes is what turns a
   * silent loss into a question.
   */
  async commit(): Promise<void> {
    await this.call("commit").catch(() => {});
  }

  /**
   * Hands the keyboard to the editor.
   *
   * Two separate things have to happen and each looks like the other when it
   * fails. Focus does not cross a frame boundary on its own, so the frame is
   * focused from here; and inside it the editor keeps a hidden input element
   * that has to be focused too, which only the shim can reach and only once
   * the editor is willing to accept it. Both are needed: with the first
   * missing, keystrokes never enter the frame; with the second missing, they
   * enter and are dropped. Clicking into the document does both by another
   * route, which is why clicking first looked like a workaround.
   */
  focus(): void {
    this.frame.focus();
    this.frame.contentWindow?.focus();
    void this.call("focus").catch(() => {});
  }

  // --------------------------------------------------------------- protocol

  /** A command to the editor. The wire format is a JSON string. */
  private send(command: string, data: unknown): void {
    this.frame.contentWindow?.postMessage(JSON.stringify({ command, data }), "*");
  }

  /** A message to the collaboration layer inside the editor. */
  private toEditor(message: unknown): void {
    this.send("cryptPadMessageToOO", message);
  }

  private onMessage = (event: MessageEvent) => {
    if (this.closed || event.source !== this.frame.contentWindow) {
      return;
    }
    if (typeof event.data === "string") {
      this.onEditorEvent(event.data);
      return;
    }
    const data = event.data as { t?: string; [key: string]: unknown };
    if (!data?.t) {
      return;
    }
    if (data.t === "engramEditorRpcResult") {
      const waiting = this.rpcPending.get(Number(data.id));
      if (waiting) {
        this.rpcPending.delete(Number(data.id));
        if (data.error) {
          waiting.reject(new Error(String(data.error)));
        } else {
          waiting.resolve(data.value);
        }
      }
      return;
    }
    if (data.t === "engramShortcut") {
      this.handlers.onShortcut(String(data.name));
    }
  };

  private onEditorEvent(raw: string): void {
    let message: { event?: string; data?: unknown };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    switch (message.event) {
      case "onAppReady":
        this.handlers.onLoading();
        this.send("init", { config: this.editorConfig() });
        this.send("openDocument", { doc: this.documentConfig() });
        return;
      case "onDocumentReady":
        this.handlers.onReady();
        return;
      case "onDocumentStateChange":
        this.handlers.onChanged(!!message.data);
        return;
      case "onError": {
        const detail = message.data as { errorDescription?: string } | undefined;
        this.handlers.onFailed(detail?.errorDescription || "the editor reported an error");
        return;
      }
      case "cryptPadSendMessageFromOO": {
        const payload = message.data as { msg?: OOMessage } | undefined;
        if (payload?.msg) {
          this.onServerMessage(payload.msg);
        }
        return;
      }
      default:
        return;
    }
  }

  /**
   * Standing in for the collaboration server the editor expects. The
   * answers live in answerServerMessage so its two modes are pinned by
   * tests; this only routes the effects.
   */
  private onServerMessage(message: OOMessage): void {
    this.applyEffects(answerServerMessage(message, this.collab));
  }

  private editorConfig(): Record<string, unknown> {
    return {
      lang: "en",
      mode: "edit",
      canCoAuthoring: true,
      // In a collaborative session the id is the channel's member index:
      // the engine namespaces the object ids this participant creates by
      // it, so it must be unique in the room and fixed before init.
      user: {
        id: String(this.collab?.index ?? 0),
        firstname: "you",
        name: "you",
      },
      customization: {
        about: true,
        feedback: false,
        compactHeader: true,
        chat: false,
        comments: false,
        hideRightMenu: true,
        features: { spellcheck: false },
      },
    };
  }

  private documentConfig(): Record<string, unknown> {
    return {
      fileType: this.fileType,
      key: "local",
      title: this.title,
      url: DOCUMENT_URL,
      isForm: false,
      permissions: { print: true, download: false },
    };
  }

  /** Calls into the editor, which only the shim inside the frame can reach. */
  private call(method: string, arg?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.rpcSeq;
      this.rpcPending.set(id, { resolve, reject });
      this.frame.contentWindow?.postMessage({ t: "engramEditorRpc", id, method, arg }, "*");
      setTimeout(() => {
        if (this.rpcPending.delete(id)) {
          reject(new Error("the editor stopped responding"));
        }
      }, 120_000);
    });
  }
}
