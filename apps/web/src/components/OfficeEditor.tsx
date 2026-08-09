import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore, type FileEntry } from "../store";
import { api } from "../api";
import { downloadAndDecrypt } from "../transfer";
import { SaveConflictError, describeConflict } from "../conflict";
import { Converter } from "../office/x2t";
import { EditorSession, editorFrameUrl } from "../office/session";
import { CollabBridge } from "../office/collab";
import { ChannelClient, type ChannelWelcome } from "../office/channelclient";
import {
  acceptEphemeral,
  acceptFrame,
  decryptFrame,
  encryptFrame,
  newChannelOrder,
  sealChannelBaseline,
  type ChannelOrder,
} from "../office/channel";
import { electedSnapshotter, shouldAutoSnapshot } from "../office/snapshot";
import { diag } from "../diag";
import { PeopleGlyph, XGlyph } from "./Icon";

/**
 * Word and Excel editing.
 *
 * The document is decrypted here, converted on this origin by a worker, and
 * handed to an editor running in a sandboxed frame that cannot reach this
 * page, its storage or its keys. Saving reverses the path: the editor
 * returns the document in its internal format, the worker converts it back,
 * and the caller re-encrypts it under the file's existing key.
 *
 * The frame is deliberately given nothing but bytes. It is a single document
 * with an opaque origin, which is what denies it storage entirely; the
 * protocol that would otherwise be spoken by a wrapper script creating a
 * second frame lives in ../office/session.ts instead.
 */

type Stage = "decrypting" | "converting" | "loading" | "ready" | "failed";

const STAGE_LABEL: Record<Stage, string> = {
  ready: "",
  failed: "",
  decrypting: "Decrypting",
  converting: "Reading the document",
  loading: "Starting the editor",
};

export function OfficeEditor(props: {
  file: FileEntry;
  fileType: "docx" | "xlsx";
  onSave: (bytes: Uint8Array, opts?: { snapshot?: boolean; upTo?: number }) => Promise<void>;
  /** A conflicting save kept as a new file of the editor's own. */
  onSaveCopy: (bytes: Uint8Array) => Promise<void>;
  onClose: () => void;
}) {
  const { file, fileType } = props;
  const fileId = file.id;
  const frameRef = useRef<HTMLIFrameElement>(null);
  const converterRef = useRef<Converter | null>(null);
  const sessionRef = useRef<EditorSession | null>(null);
  // The editor's own save shortcut arrives as a message, which the session
  // hands on; it needs whatever save() currently is, not the one that existed
  // when the session was built.
  const saveRef = useRef<() => void>(() => {});
  /** The awaitable save, for flows that must sequence after it. */
  const savePromiseRef = useRef<() => Promise<void>>(() => Promise.resolve());
  // Read synchronously when closing, because the change that a commit
  // produces arrives after the render that would have updated the state.
  const dirtyRef = useRef(false);
  // Read at open time only. Saving stores a new version, which replaces this
  // file's entry in the library; if the session depended on that entry, every
  // save would tear the editor down and reopen it on the document that was
  // just written.
  const fileRef = useRef(file);
  fileRef.current = file;
  const [stage, setStage] = useState<Stage>("decrypting");
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  // Someone else's save landed first; the exported bytes wait here for the
  // choice between reloading theirs and keeping these as a copy.
  const [conflict, setConflict] = useState<{ bytes: Uint8Array | null } | null>(null);
  // The entry's stamp when this editor opened it; a strictly newer stamp on
  // the store's entry means somebody saved meanwhile.
  const openedAtRef = useRef(file.updatedAt);
  // Forces the open effect to run again for "Reload theirs".
  const [reloadNonce, setReloadNonce] = useState(0);
  // Live collaboration: off (not a shared doc), connecting, live, or alone
  // (shared but the relay is unreachable; turn-based editing still works).
  const [collab, setCollab] = useState<"off" | "connecting" | "live" | "alone">("off");
  const [peers, setPeers] = useState(1);
  // Callbacks read these; state is for rendering.
  const collabRef = useRef<"off" | "connecting" | "live" | "alone">("off");
  collabRef.current = collab;
  /** Reloads taken to repair the channel; bounded so failure is visible. */
  const resyncCountRef = useRef(0);
  /** Solo-to-live upgrades taken; bounded so a flapping dial cannot thrash. */
  const upgradeRef = useRef(0);
  const channelRef = useRef<ChannelClient | null>(null);
  // Durable chg frames since the last snapshot, and when the last arrived:
  // the elected member turns quiet spells into snapshots.
  const pendingFramesRef = useRef(0);
  const lastFrameAtRef = useRef(0);
  // The effect's membership tracker; callbacks reach it through this seam.
  const membersHook = useRef<(members: Array<{ connId: string; index: number; name?: string }>) => void>(
    () => {},
  );

  // The frame's address depends only on the kind of document, so the editor
  // begins loading its several megabytes immediately, while this file is
  // still being downloaded, decrypted and converted.
  const frameUrl = useMemo(() => editorFrameUrl(fileType), [fileType]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) {
      return;
    }
    const converter = new Converter();
    converterRef.current = converter;
    let cancelled = false;

    const opened = fileRef.current;
    openedAtRef.current = opened.updatedAt;
    setConflict(null);

    // A frame that never reports ready would otherwise spin forever, which is
    // what a refused asset looks like from the outside. Generous, because the
    // editor is megabytes and a slow link is not a failure.
    const startupDeadline = window.setTimeout(() => {
      if (!cancelled) {
        setStage((current) => (current === "ready" ? current : "failed"));
        setError((current) => current ?? "the editor did not start");
      }
    }, 150_000);

    let channel: ChannelClient | null = null;
    let bridge: CollabBridge | undefined;
    let order: ChannelOrder = newChannelOrder(opened.id);
    let connId = "";
    /** Whether the engine's auth saw anyone else; solo auth cannot co-edit. */
    let bridgeCompany = false;
    /** Set once the collab decision reached the session; a welcome after
     * this cannot join the current engine and upgrades via reload. */
    let sessionBegun = false;
    let outCounter = 0;
    // What the relay says each connection's participant index is; the only
    // trustworthy source, since frame contents are member-forgeable.
    const indexByConn = new Map<string, number>();
    // Log frames arriving before the engine is open wait here; the spike
    // proved catch-up must replay AFTER the document is ready.
    let tail: Array<ReturnType<typeof decryptFrame>> = [];
    let engineReady = false;

    const feedFrame = (frame: ReturnType<typeof decryptFrame>) => {
      const b = bridge;
      const s = sessionRef.current;
      if (!b || !s) {
        return;
      }
      s.applyEffects(b.onRemoteFrame(frame));
    };

    const resync = (counted = true) => {
      // Frames went missing; the stream cannot be trusted. Reload the
      // document from its current generation, the same road as a conflict.
      // Bounded: a channel that cannot be repaired (frames sealed under a
      // retired key, a stream this build cannot follow) must become an
      // error, never an infinite spinner. A dropped-and-redialed SOCKET
      // is not that: connections flap on phones, and a reconnect reload
      // must not spend the repair budget.
      if (!cancelled) {
        if (counted) {
          resyncCountRef.current += 1;
        }
        if (resyncCountRef.current > 3) {
          setStage("failed");
          setError(
            "the live session for this document could not be repaired; close it and try again",
          );
          return;
        }
        setStage("decrypting");
        setCollab("connecting");
        setReloadNonce((n) => n + 1);
      }
    };

    const makeSession = () =>
      new EditorSession(
        frame,
        fileType,
        opened.name,
        {
          onLoading: () => diag("office", "the editor is up and waiting for its document"),
          onReady: () => {
            window.clearTimeout(startupDeadline);
            engineReady = true;
            // A door that opened proves the channel is followable again.
            resyncCountRef.current = 0;
            for (const queued of tail.splice(0)) {
              feedFrame(queued);
            }
            setStage("ready");
          },
          onChanged: (modified) => {
            // Only ever set. The editor clears its own modified flag as soon
            // as the collaboration layer acknowledges a change; treating that
            // as "saved" would grey out Save and let the document close with
            // the edit only in the editor.
            if (modified) {
              dirtyRef.current = true;
              setDirty(true);
            }
          },
          onShortcut: (name) => {
            if (name === "save") {
              saveRef.current();
            }
          },
          onFailed: (message) => {
            setStage("failed");
            setError(message);
          },
          onPost: (out) => {
            if (channel) {
              outCounter += 1;
              if (outCounter === 1) {
                diag("collab", "first frame posted to the channel");
              }
              if (out.k === "chg") {
                pendingFramesRef.current += 1;
                lastFrameAtRef.current = Date.now();
              }
              channel.post(
                out.ref,
                encryptFrame(
                  { ch: opened.id, s: connId, n: outCounter, k: out.k, d: out.d },
                  opened.key,
                ),
              );
            }
          },
          onEph: (out) => {
            channel?.eph(
              encryptFrame({ ch: opened.id, s: connId, n: 0, k: out.k, d: out.d }, opened.key),
            );
          },
        },
      );

    // The session listens from the very first moment: the editor frame
    // announces itself exactly once, on its own schedule, and a warm
    // cache can fire that announce before any network settles. A session
    // created later missed it and the engine waited forever.
    const session = makeSession();
    sessionRef.current = session;

    void (async () => {
      try {
        // The document's own bytes come first and never wait for anything
        // else: fetching and converting start immediately, while the
        // channel dials in parallel. A websocket a proxy or VPN
        // black-holes settles neither way for minutes, and an open that
        // awaited it hung on "starting" forever, for every member.
        const docPromise = (async () => {
          setStage("decrypting");
          const plaintext = await downloadAndDecrypt(opened.id, opened.key, opened.digest);
          if (cancelled) {
            return null;
          }
          setStage("converting");
          return converter.importDocument(`document.${fileType}`, plaintext);
        })();
        // A recipient knows the document is shared; an owner asks whether
        // anyone else holds a key. Only then is the channel worth dialing.
        let collaborative = opened.shared === true;
        if (!collaborative && !opened.shared) {
          collaborative = await Promise.race([
            api
              .listCollaborators(opened.id)
              .then((r) => r.collaborators.length > 0)
              .catch(() => false),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
          ]);
        }
        if (collaborative && !cancelled) {
          setCollab("connecting");
          try {
            channel = new ChannelClient(opened.id, {
              onWelcome: (welcome: ChannelWelcome) => {
                if (bridge) {
                  // A redial lands on a new connection and a new index; the
                  // engine's identity is fixed at init, so reopen cleanly.
                  // Uncounted: a flapping connection is not a broken stream.
                  resync(false);
                  return;
                }
                if (sessionBegun) {
                  // The welcome outran its deadline and this session
                  // already opened solo. One reload upgrades it to live;
                  // a dial that keeps missing the deadline stays solo
                  // rather than thrash the document.
                  if (upgradeRef.current < 2) {
                    upgradeRef.current += 1;
                    resync(false);
                  } else {
                    channelRef.current?.close();
                  }
                  return;
                }
                connId = welcome.you;
                diag("collab", `welcome: member ${welcome.yourIndex}, ${welcome.members.length} present`);
                order = newChannelOrder(opened.id);
                bridgeCompany = welcome.members.length > 1;
                bridge = new CollabBridge({
                  fileId: opened.id,
                  selfConnId: welcome.you,
                  selfIndex: welcome.yourIndex,
                  members: welcome.members,
                });
                membersHook.current(welcome.members);
                setPeers(welcome.members.length);
              },
              onLog: (seq, sender, payload) => {
                void seq;
                try {
                  const decoded = decryptFrame(payload, opened.key);
                  const verdict = acceptFrame(order, decoded, sender);
                  // The participant index rides inside the frame too, and
                  // the engine namespaces objects and locks by it, so it
                  // must belong to the connection that actually sent this.
                  const claimedIndex = (decoded.d as { idx?: number } | undefined)?.idx;
                  const realIndex = indexByConn.get(sender);
                  if (
                    verdict === "apply" &&
                    claimedIndex !== undefined &&
                    realIndex !== undefined &&
                    claimedIndex !== realIndex
                  ) {
                    return;
                  }
                  if (verdict === "resync") {
                    resync();
                    return;
                  }
                  if (verdict === "apply") {
                    if (decoded.k === "chg") {
                      pendingFramesRef.current += 1;
                      lastFrameAtRef.current = Date.now();
                    }
                    if (engineReady) {
                      feedFrame(decoded);
                    } else {
                      tail.push(decoded);
                    }
                  }
                } catch {
                  // A frame that does not open under our key is noise from a
                  // rotation boundary; the reload path recovers.
                  resync();
                }
              },
              onCaughtUp: () => {
                // The initial replay is over; from here the per-sender
                // counters must be contiguous.
                sealChannelBaseline(order);
              },
              onEph: (sender, payload) => {
                try {
                  const decoded = decryptFrame(payload, opened.key);
                  if (!acceptEphemeral(opened.id, decoded, sender)) {
                    return;
                  }
                  const claimedIndex = (decoded.d as { idx?: number } | undefined)?.idx;
                  const realIndex = indexByConn.get(sender);
                  if (claimedIndex !== undefined && realIndex !== undefined && claimedIndex !== realIndex) {
                    return;
                  }
                  const b = bridge;
                  const s = sessionRef.current;
                  if (b && s && engineReady) {
                    s.applyEffects(b.onRemoteFrame(decoded));
                  }
                } catch {
                  // Lossy by design; a bad cursor frame costs nothing.
                }
              },
              onMembers: (members) => {
                membersHook.current(members);
                setPeers(members.length);
                const b = bridge;
                const s = sessionRef.current;
                if (b && s && engineReady) {
                  s.applyEffects(b.onMembers(members));
                }
                // The engine decides single-user or co-editing at auth
                // time and never revisits it. A session that authed alone
                // types locally and broadcasts nothing, so the first
                // person in a room would edit invisibly forever. Company
                // arriving re-auths through the ordinary reload, with any
                // unsent local work committed first so nothing is lost.
                if (b && !bridgeCompany && members.length > 1) {
                  bridgeCompany = true;
                  if (dirtyRef.current) {
                    void savePromiseRef
                      .current()
                      .catch(() => {})
                      .finally(() => resync(false));
                  } else {
                    resync(false);
                  }
                }
              },
              onAck: (ref, seq) => {
                const b = bridge;
                const s = sessionRef.current;
                if (b && s) {
                  s.applyEffects(b.onOwnFrameAcked(ref, seq));
                }
              },
              onPleaseSnapshot: () => {
                // The relay is refusing further posts until someone
                // snapshots; the elected member saves now rather than on
                // the next quiet spell, unclogging the room for everyone.
                if (collabRef.current === "live" && electedSnapshotter(latestMembers) === connId) {
                  saveRef.current();
                }
              },
              onTruncated: (generation, snapshotSeq) => {
                void generation;
                // Truncation deletes replay rows, not deliveries: a live
                // member already holds every frame the snapshot contains.
                // Only a position BEHIND the truncation point means frames
                // this client never saw are gone, and the current
                // generation is the only honest source left.
                if ((channelRef.current?.lastSeenSeq ?? 0) < snapshotSeq) {
                  resync();
                }
              },
              onDead: () => {
                if (!cancelled) {
                  setCollab("alone");
                }
              },
            });
            // Ten seconds is generous for a healthy upgrade. Past it the
            // session opens solo rather than hang; the dial keeps going
            // in the background, and a welcome that lands later upgrades
            // this open through the reload path instead of blocking it.
            const settled = await Promise.race([
              channel.connect().then(() => true),
              new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000)),
            ]);
            channelRef.current = channel;
            if (!cancelled) {
              setCollab(settled ? "live" : "alone");
            }
          } catch {
            channel = null;
            bridge = undefined;
            if (!cancelled) {
              setCollab("alone");
            }
          }
        }
        if (cancelled) {
          return;
        }
        // The collaboration decision is made; the engine may now init,
        // with the channel identity when live and alone otherwise.
        sessionBegun = true;
        diag("collab", bridge ? `engine begins live as index ${bridge.index}` : "engine begins solo");
        session.begin(bridge);
        const imported = await docPromise;
        if (cancelled || !imported) {
          return;
        }
        session.deliver(imported.bin, imported.media);
        setStage("loading");
      } catch (err) {
        if (!cancelled) {
          setStage("failed");
          setError(err instanceof Error ? err.message : "could not open this document");
        }
      }
    })();

    // The elected member turns quiet spells into snapshots, so a room
    // nobody saves in still converges and the log stays bounded. Election
    // is the lowest index present, computed identically everywhere; a
    // second snapshotter would be redundant, never harmful.
    let latestMembers: Array<{ connId: string; index: number; name?: string }> = [];
    const rememberMembers = (members: Array<{ connId: string; index: number; name?: string }>) => {
      latestMembers = members;
      indexByConn.clear();
      for (const m of members) {
        indexByConn.set(m.connId, m.index);
      }
    };
    membersHook.current = rememberMembers;
    const autoSnapshot = window.setInterval(() => {
      if (
        collabRef.current === "live" &&
        electedSnapshotter(latestMembers) === connId &&
        shouldAutoSnapshot({
          pendingFrames: pendingFramesRef.current,
          msSinceLastFrame: Date.now() - lastFrameAtRef.current,
        })
      ) {
        saveRef.current();
      }
    }, 10_000);

    return () => {
      cancelled = true;
      window.clearTimeout(startupDeadline);
      window.clearInterval(autoSnapshot);
      channel?.close();
      channelRef.current = null;
      sessionRef.current?.close();
      sessionRef.current = null;
      converter.close();
      converterRef.current = null;
    };
  }, [fileId, fileType, reloadNonce]);

  /**
   * Hand the keyboard over once the document is ready, and not a moment
   * earlier: the frame is hidden until then, and a hidden element cannot take
   * focus, so doing this the instant the editor reports ready silently does
   * nothing and leaves you having to click into the document before you can
   * type. This runs after the render that reveals it.
   */
  useEffect(() => {
    if (stage === "ready") {
      sessionRef.current?.focus();
    }
  }, [stage]);

  const save = useCallback(async () => {
    const converter = converterRef.current;
    const session = sessionRef.current;
    if (!converter || !session || busy || stage !== "ready" || conflict) {
      return;
    }
    // Most conflicts can be caught before the work of exporting: if the
    // library's entry moved since this editor opened, someone else already
    // saved, and the question gets asked now rather than after a 409. In a
    // LIVE room this gate must not run: a co-editor's snapshot moves the
    // entry on every sync, but its content already reached this engine as
    // frames, so a snapshot save from here is cooperative, not a conflict.
    const live = collabRef.current === "live";
    const current = useStore.getState().files.get(fileId);
    if (!live && current && describeConflict(openedAtRef.current, current.updatedAt) === "stale") {
      setConflict({ bytes: null });
      return;
    }
    setBusy(true);
    setError(null);
    let out: Uint8Array | null = null;
    try {
      // Everything the channel delivered up to here is applied and will be
      // in the export; that position is what the snapshot may truncate.
      const upTo = live ? (channelRef.current?.lastSeenSeq ?? 0) : 0;
      const bin = await session.save();
      if (!bin) {
        throw new Error("the editor returned nothing to save");
      }
      out = await converter.exportDocument(`document.${fileType}`, bin);
      await props.onSave(out, { snapshot: live, upTo });
      setDirty(false);
      dirtyRef.current = false;
      setSavedAt(Date.now());
      openedAtRef.current = useStore.getState().files.get(fileId)?.updatedAt ?? Date.now();
      if (live && upTo > 0) {
        // The server trims the channel itself, as part of committing this
        // save; nothing here may ask for it.
        pendingFramesRef.current = 0;
      }
      diag("office", `saved ${file.name} (${out.length} bytes)`);
    } catch (err) {
      if (err instanceof SaveConflictError) {
        // The export already happened; stash the very bytes that were
        // refused so "Save as a copy" keeps exactly what was typed.
        setConflict({ bytes: out });
      } else {
        setError(err instanceof Error ? err.message : "save failed");
      }
    } finally {
      setBusy(false);
    }
  }, [busy, stage, conflict, fileId, fileType, props, file.name]);

  /** Discards this editor's changes and reopens the winner's document. */
  const reloadTheirs = useCallback(async () => {
    setConflict(null);
    setDirty(false);
    dirtyRef.current = false;
    setStage("decrypting");
    await useStore
      .getState()
      .refresh()
      .catch(() => {});
    setReloadNonce((n) => n + 1);
  }, []);

  /** Keeps this editor's changes as a new file of the editor's own. */
  const saveAsCopy = useCallback(async () => {
    const converter = converterRef.current;
    const session = sessionRef.current;
    if (!converter || !session) {
      return;
    }
    setBusy(true);
    try {
      let out = conflict?.bytes ?? null;
      if (!out) {
        const bin = await session.save();
        out = bin ? await converter.exportDocument(`document.${fileType}`, bin) : null;
      }
      if (!out) {
        throw new Error("the editor returned nothing to save");
      }
      await props.onSaveCopy(out);
      setConflict(null);
      setDirty(false);
      dirtyRef.current = false;
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not save a copy");
    } finally {
      setBusy(false);
    }
  }, [conflict, fileType, props]);

  useEffect(() => {
    saveRef.current = () => void save();
    savePromiseRef.current = save;
  }, [save]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  const close = useCallback(async () => {
    // A cell still being typed in is not part of the document yet, so ask the
    // editor to commit before deciding whether anything would be lost.
    await sessionRef.current?.commit();
    await new Promise((resolve) => setTimeout(resolve, 120));
    if ((dirty || dirtyRef.current) && !window.confirm("Close without saving your changes?")) {
      return;
    }
    props.onClose();
  }, [dirty, props]);

  return (
    <div className="preview-shell">
      <div className="preview-top">
        <span className="name">
          {file.name}
          {dirty && <span className="dirty-dot" title="Unsaved changes" />}
        </span>
        <span className="meta">
          {stage === "ready" ? (savedAt && !dirty ? "saved, encrypted" : "") : STAGE_LABEL[stage]}
        </span>
        {collab === "live" && peers > 1 && (
          <span className="badge" title="Editing together, live">
            <PeopleGlyph size={11} /> {peers} here
          </span>
        )}
        {collab === "alone" && (
          <span className="badge" title="The live channel is unreachable; saving still works and conflicts are caught">
            working alone
          </span>
        )}
        <div className="grow" />
        {error && <span className="error-text">{error}</span>}
        {conflict ? (
          <>
            <span className="error-text">Someone else saved this document first.</span>
            <button className="btn" onClick={() => void reloadTheirs()} disabled={busy}>
              Reload theirs
              <span className="btn-label"> (discards your changes)</span>
            </button>
            <button className="btn btn-primary" onClick={() => void saveAsCopy()} disabled={busy}>
              {busy ? <span className="spinner" /> : null}
              Save as a copy
            </button>
          </>
        ) : (
          <button
            className="btn btn-primary"
            onClick={() => void save()}
            disabled={stage !== "ready" || busy}
          >
            {busy ? <span className="spinner" /> : null}
            {busy ? "Encrypting" : "Save"}
            {!busy && <kbd className="mono save-kbd">⌘S</kbd>}
          </button>
        )}
        <button className="icon-btn" title="Close" onClick={() => void close()}>
          <XGlyph />
        </button>
      </div>
      <div className="office-body">
        {stage === "failed" ? (
          <div className="preview-fallback">{error ?? "this document could not be opened"}</div>
        ) : null}
        {stage !== "ready" && stage !== "failed" && (
          <div className="office-loading">
            <span className="spinner" />
            {STAGE_LABEL[stage]}
          </div>
        )}
        <iframe
          ref={frameRef}
          className="office-frame"
          title={file.name}
          src={frameUrl}
          // No allow-same-origin: the frame runs in an opaque origin and so
          // cannot reach this page, its storage, its cookies or its session,
          // and has no storage of its own. Adding it would hand vendored
          // third-party code the run of the origin that holds the master key.
          sandbox="allow-scripts"
          style={{ visibility: stage === "ready" ? "visible" : "hidden" }}
        />
      </div>
    </div>
  );
}
