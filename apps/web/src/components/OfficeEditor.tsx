import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore, type FileEntry } from "../store";
import { api } from "../api";
import { IntegrityError, downloadContent } from "../transfer";
import { openSharedContent, refreshLibraryOnce } from "../openshared";
import { barrierDelayMs, barrierVerdict } from "../office/barrier";
import { reconcile, type ContentMarker } from "../office/content";
import { SaveConflictError, describeConflict, satisfiedByPeer } from "../conflict";
import { Converter } from "../office/x2t";
import { EditorSession, editorFrameUrl } from "../office/session";
import { CollabBridge, type OutFrame } from "../office/collab";
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
import { electedSnapshotter, shouldContentSave } from "../office/snapshot";
import { describeStartupStall, editorFrameKey } from "../office/reload";
import { trailingThrottle } from "../office/throttle";
import {
  describeCollabStats,
  newCollabStats,
  noteAck,
  noteEphReceived,
  noteEphSent,
  notePost,
  oldestPendingMs,
  type CollabStats,
} from "../office/stats";
import { diag } from "../diag";
import { PeopleGlyph, XGlyph } from "./Icon";
import { Confirm } from "./Dialogs";

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
  onSave: (
    bytes: Uint8Array,
    opts?: {
      snapshot?: boolean;
      upTo?: number;
      mode?: "content" | "checkpoint";
      conn?: string;
    },
  ) => Promise<void>;
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
  const saveRef = useRef<(auto?: boolean) => void>(() => {});
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
  // A content blocker refused the editor frame's assets; failure is
  // named and worth a retry button once the blocker is off.
  const [blockedFrame, setBlockedFrame] = useState(false);
  // Closing with unsaved changes asks with an in-app dialog: the iOS
  // shell never renders window.confirm, which made a dirty close a
  // silent no-op there.
  const [pendingClose, setPendingClose] = useState(false);
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
  const membersHook = useRef<
    (members: Array<{ connId: string; index: number; name?: string; role?: string }>) => void
  >(() => {});
  // The save barrier's seams into the open effect: freezing pauses remote
  // frames at the queue (order bookkeeping still runs), the drain hook
  // releases them, and the stats/connection refs let save() read the
  // channel's state from outside the effect's closures.
  const freezeRef = useRef(false);
  const drainHookRef = useRef<() => void>(() => {});
  const statsRef = useRef<CollabStats | null>(null);
  const connRef = useRef("");
  /** The relay is refusing posts until someone snapshots (hard ceiling). */
  const ceilingRef = useRef(false);
  /** The relay asked for a trim; the next save carries a checkpoint. */
  const trimAskRef = useRef(false);
  /** The save currently running, for flows that must sequence after it. */
  const saveInFlightRef = useRef<Promise<void> | null>(null);
  /** The last live save this client committed, to recognize its own
   * truncation frame against an older server that does not skip authors. */
  const lastSaveRef = useRef<{ upTo: number; at: number } | null>(null);

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
    setBlockedFrame(false);

    // A frame that never reports ready would otherwise spin forever, which is
    // what a refused asset looks like from the outside. Generous, because the
    // editor is megabytes and a slow link is not a failure.
    const startupDeadline = window.setTimeout(() => {
      if (!cancelled) {
        setStage((current) => (current === "ready" ? current : "failed"));
        setError((current) => current ?? "the editor did not start");
      }
    }, 150_000);

    // Long before that deadline, a frame that has not even announced while
    // this origin answers is being refused, not loaded: content blockers
    // treat the sandboxed frame's null-origin requests as third party.
    let frameAnnounced = false;
    const shieldProbe = window.setTimeout(() => {
      if (cancelled || frameAnnounced) {
        return;
      }
      void fetch("/version.json", { cache: "no-store" }).then(
        () => {
          if (cancelled || frameAnnounced) {
            return;
          }
          if (describeStartupStall({ announced: false, originAlive: true }) === "blocked") {
            diag("office", "no announce after 20s with the origin alive: a blocked frame");
            setBlockedFrame(true);
            setStage("failed");
            setError(
              "your content blocker is stopping the editor from loading; allow this site and try again",
            );
          }
        },
        () => {
          // The origin itself is unreachable; the link is the problem and
          // the generous startup deadline stays in charge.
        },
      );
    }, 20_000);

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
    // Log frames arriving before the engine is open (or while a save is
    // holding the barrier) wait here with their positions; the spike
    // proved catch-up must replay AFTER the document is ready.
    let tail: Array<{ seq: number; frame: ReturnType<typeof decryptFrame> }> = [];
    let engineReady = false;
    // Which channel position the downloaded bytes already contain: frames
    // at or below it never reach the engine, or they would apply twice.
    let feedFloor = 0;
    // Where the stored bytes stand, per the server; welcome sets it and
    // content/checkpoint broadcasts keep it fresh. Boxed because it is
    // written from channel callbacks and read on the open path.
    const markerBox: { current: ContentMarker | null } = { current: null };

    // One set of counters per open attempt, readable from the console as
    // window.engramCollab() during a live session; engramCollabProbe()
    // reads the engine's own lock tables through the frame's shim.
    const stats = newCollabStats();
    statsRef.current = stats;
    (window as unknown as { engramCollab?: () => CollabStats }).engramCollab = () => stats;
    (
      window as unknown as { engramCollabProbe?: () => Promise<unknown> }
    ).engramCollabProbe = () => sessionRef.current?.probe() ?? Promise.resolve(null);

    const feedFrame = (frame: ReturnType<typeof decryptFrame>) => {
      const b = bridge;
      const s = sessionRef.current;
      if (!b || !s) {
        return;
      }
      s.applyEffects(b.onRemoteFrame(frame));
      stats.changesIndex = b.changes;
    };

    /** Releases queued frames to the engine, skipping what the bytes hold. */
    const drainTail = () => {
      for (const queued of tail.splice(0)) {
        if (queued.seq > feedFloor) {
          feedFrame(queued.frame);
        }
      }
    };
    drainHookRef.current = drainTail;

    // One reload per incarnation. A broken order is sticky, so every frame
    // after the break also answered "resync"; each call counted, and three
    // frames burned the whole repair budget in a millisecond. The first
    // call decides; the remount either heals (and resets the budget on
    // ready) or fails and takes the next incarnation's single count.
    let resyncing = false;
    const resync = (counted = true) => {
      // Frames went missing; the stream cannot be trusted. Reload the
      // document from its current generation, the same road as a conflict.
      // Bounded: a channel that cannot be repaired (frames sealed under a
      // retired key, a stream this build cannot follow) must become an
      // error, never an infinite spinner. A dropped-and-redialed SOCKET
      // is not that: connections flap on phones, and a reconnect reload
      // must not spend the repair budget.
      if (!cancelled) {
        if (resyncing) {
          return;
        }
        resyncing = true;
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
        diag("collab", `resync ${resyncCountRef.current}: remounting the editor frame`);
        setStage("decrypting");
        setCollab("connecting");
        setReloadNonce((n) => n + 1);
      }
    };

    /**
     * The room crosses a checkpoint together: everyone re-derives from
     * the committed snapshot instead of holding an engine whose change
     * base and digest moved underneath it. Unsent work is flushed through
     * the channel first, because frames above the trim survive and replay
     * after the reload; work that cannot reach the log within the budget
     * raises the conflict UI holding the exported bytes, never a silent
     * discard. Uncounted, because a checkpoint is not a broken stream.
     */
    let crossing = false;
    const crossCheckpoint = async () => {
      if (cancelled) {
        return;
      }
      // An open or crossing already in flight will land on the newest
      // committed state by itself; launching another remount under it is
      // how a burst of checkpoints became an unbounded reload storm.
      // Refreshing the library is all the in-flight open needs.
      if (crossing || !engineReady) {
        void refreshLibraryOnce();
        return;
      }
      crossing = true;
      await (saveInFlightRef.current ?? Promise.resolve()).catch(() => {});
      const s = sessionRef.current;
      if (s) {
        const deadline = Date.now() + 5_000;
        for (;;) {
          if (cancelled) {
            return;
          }
          const flush = await s.flushChanges();
          const pending = statsRef.current?.pendingAcks.size ?? 0;
          if (flush.haveChanges !== true && pending === 0) {
            break;
          }
          if (Date.now() > deadline) {
            if (dirtyRef.current) {
              diag("collab", "checkpoint flush stalled with unsaved work; keeping the bytes");
              try {
                const bin = await s.save();
                const kept = bin
                  ? await converter.exportDocument(`document.${fileType}`, bin)
                  : null;
                if (!cancelled) {
                  setConflict({ bytes: kept });
                }
              } catch {
                if (!cancelled) {
                  setConflict({ bytes: null });
                }
              }
              return;
            }
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
      await refreshLibraryOnce();
      resync(false);
    };

    const sendEph = (out: OutFrame) => {
      noteEphSent(stats);
      channel?.eph(
        encryptFrame({ ch: opened.id, s: connId, n: 0, k: out.k, d: out.d }, opened.key),
      );
    };
    // The engine emits a cursor message per selection change and each one
    // was its own websocket frame. Cursors are last-write-wins, so inside
    // the window only the latest matters; other ephemeral kinds pass
    // straight through, since coalescing would swallow them entirely.
    const cursorThrottle = trailingThrottle(100, sendEph);

    const makeSession = () =>
      new EditorSession(
        frame,
        fileType,
        opened.name,
        {
          onAnnounced: () => {
            frameAnnounced = true;
          },
          onEngineLog: (level, message) => {
            // Error-level engine logs fire BEFORE a document visibly
            // breaks; having them in the diagnostics is the early warning.
            if (level === "error") {
              diag("engine", message);
            }
          },
          onLoading: () => diag("office", "the editor is up and waiting for its document"),
          onReady: () => {
            window.clearTimeout(startupDeadline);
            engineReady = true;
            // A door that opened proves the channel is followable again.
            resyncCountRef.current = 0;
            drainTail();
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
                notePost(stats, out.ref, Date.now());
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
            if (out.k === "cursor") {
              cursorThrottle.push(out);
            } else {
              sendEph(out);
            }
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
        const fetchDocument = async () => {
          setStage("decrypting");
          // A co-editor's save moves the digest while this client's poll
          // is still pending; opening from the cached entry then refuses
          // good bytes. Refresh and retry, shared files only. The server
          // names the generation it served, for pairing with the marker.
          let generation: number | null = null;
          const plaintext = await openSharedContent(opened, async (entry) => {
            // A shared entry only ever lags behind the server; bytes at or
            // past the generation it knows are accepted so a busy room's
            // saves cannot outrun this open, no matter their cadence.
            const result = await downloadContent(entry.id, entry.key, entry.digest, {
              atLeast: entry.shared ? (entry.generation ?? 0) : null,
            });
            generation = result.generation;
            return result.bytes;
          });
          if (cancelled) {
            return null;
          }
          setStage("converting");
          const imported = await converter.importDocument(`document.${fileType}`, plaintext);
          return { imported, generation };
        };
        const docPromise = fetchDocument();
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
                connRef.current = welcome.you;
                // Where the stored bytes stand; pairs with the download.
                markerBox.current =
                  welcome.contentGeneration !== undefined
                    ? {
                        generation: Number(welcome.contentGeneration),
                        seq: Number(welcome.contentChannelSeq ?? 0),
                      }
                    : null;
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
                // A remount is already on its way; frames that keep
                // streaming until it lands change nothing it will not
                // re-derive from the snapshot and the replay.
                if (resyncing) {
                  return;
                }
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
                    if (engineReady && !freezeRef.current) {
                      if (seq > feedFloor) {
                        feedFrame(decoded);
                      }
                    } else {
                      tail.push({ seq, frame: decoded });
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
                  noteEphReceived(stats, sender);
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
                noteAck(stats, ref, Date.now());
                const b = bridge;
                const s = sessionRef.current;
                if (b && s) {
                  s.applyEffects(b.onOwnFrameAcked(ref, seq));
                  stats.changesIndex = b.changes;
                }
              },
              onContent: (contentGeneration, contentChannelSeq) => {
                // Someone's save moved the stored bytes without touching
                // the log; remember where they stand for the next pairing,
                // and refresh so this client's entry follows the digest.
                markerBox.current = { generation: contentGeneration, seq: contentChannelSeq };
                void refreshLibraryOnce();
              },
              onPleaseSnapshot: (reason) => {
                // The next save carries the trim. "soft" arrives on the
                // slope with posts still landing; "ceiling" (or nothing,
                // from an older server) means posts are being refused,
                // which the barrier needs to know to proceed unlogged.
                trimAskRef.current = true;
                if (reason !== "soft") {
                  ceilingRef.current = true;
                }
                // The elected member saves now rather than on the next
                // quiet spell, unclogging the room for everyone.
                if (collabRef.current === "live" && electedSnapshotter(latestMembers) === connId) {
                  saveRef.current(true);
                }
              },
              onTruncated: (generation, snapshotSeq) => {
                void generation;
                // The trim cleared whatever ask or refusal was standing.
                ceilingRef.current = false;
                trimAskRef.current = false;
                // A truncation is also the "somebody moved the digest"
                // signal: refresh the library so this client's entry (and
                // any preview or reopen it feeds) matches the new bytes.
                void refreshLibraryOnce();
                // The author's engine IS the snapshot and must not reload.
                // A new server never sends the author this frame; against
                // an older one, the save this client just committed at
                // exactly this position is the tell.
                const last = lastSaveRef.current;
                if (last && last.upTo === snapshotSeq && Date.now() - last.at < 15_000) {
                  return;
                }
                void crossCheckpoint();
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
        let doc = await docPromise;
        if (cancelled || !doc?.imported) {
          return;
        }
        if (bridge) {
          // Pair the downloaded bytes with the channel's marker: the
          // replay must skip exactly the frames the bytes already
          // contain. Bytes of a different generation than the marker
          // names cannot be paired; one refreshed re-download usually
          // heals it (a save landed mid-open), else the reload path.
          let verdict = reconcile({
            bytesGeneration: doc.generation,
            marker: markerBox.current,
            refetched: false,
          });
          if (verdict === "refetch") {
            diag("collab", "bytes and channel marker disagree; refreshing and refetching once");
            await refreshLibraryOnce();
            const again = await fetchDocument();
            if (cancelled) {
              return;
            }
            if (again?.imported) {
              doc = again;
            }
            verdict = reconcile({
              bytesGeneration: doc.generation,
              marker: markerBox.current,
              refetched: true,
            });
          }
          if (verdict === "resync") {
            resync();
            return;
          }
          feedFloor = verdict === "ready" && markerBox.current ? markerBox.current.seq : 0;
          if (feedFloor > 0) {
            diag("collab", `bytes contain the log through ${feedFloor}; replay starts after it`);
          }
        }
        session.deliver(doc.imported.bin, doc.imported.media);
        setStage("loading");
      } catch (err) {
        if (!cancelled) {
          // A collaborative document whose digest keeps moving under the
          // open (back-to-back checkpoints) deserves the bounded repair
          // road, not a permanent refusal screen: the next incarnation
          // downloads the then-current bytes, and the breaker still ends
          // a truly unfollowable session honestly.
          if (err instanceof IntegrityError && (bridge || opened.shared)) {
            diag("collab", "the digest moved under the open; taking the repair road");
            resync();
            return;
          }
          setStage("failed");
          setError(err instanceof Error ? err.message : "could not open this document");
        }
      }
    })();

    // The elected member turns quiet spells into snapshots, so a room
    // nobody saves in still converges and the log stays bounded. Election
    // is the lowest index present, computed identically everywhere; a
    // second snapshotter would be redundant, never harmful.
    let latestMembers: Array<{ connId: string; index: number; name?: string; role?: string }> = [];
    const rememberMembers = (
      members: Array<{ connId: string; index: number; name?: string; role?: string }>,
    ) => {
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
        shouldContentSave({
          pendingFrames: pendingFramesRef.current,
          msSinceLastFrame: Date.now() - lastFrameAtRef.current,
        })
      ) {
        saveRef.current(true);
      }
    }, 10_000);

    // The counters land in the diagnostics panel on a slow pulse, and once
    // more on the way out, so a session that ended badly leaves its numbers.
    const statsPulse = window.setInterval(() => {
      if (collabRef.current === "live") {
        diag("collab", describeCollabStats(stats));
      }
    }, 30_000);

    // A change the relay never acknowledged means the stream is dead in a
    // way the socket has not noticed; a repair is the only way forward,
    // and it is cheap now that a resync reloads the frame cleanly.
    const ackWatchdog = window.setInterval(() => {
      const waited = oldestPendingMs(stats, Date.now());
      if (waited !== null && waited > 30_000 && collabRef.current === "live") {
        diag("collab", `a change went ${Math.round(waited / 1000)}s without its ack; repairing`);
        stats.pendingAcks.clear();
        resync(false);
      }
    }, 10_000);

    return () => {
      cancelled = true;
      window.clearTimeout(startupDeadline);
      window.clearTimeout(shieldProbe);
      window.clearInterval(autoSnapshot);
      window.clearInterval(statsPulse);
      window.clearInterval(ackWatchdog);
      if (stats.chgPosted || stats.ephSent || stats.ephReceivedBySender.size) {
        diag("collab", `closing: ${describeCollabStats(stats)}`);
      }
      cursorThrottle.cancel();
      channel?.close();
      channelRef.current = null;
      sessionRef.current?.close();
      sessionRef.current = null;
      converter.close();
      converterRef.current = null;
      freezeRef.current = false;
      drainHookRef.current = () => {};
      statsRef.current = null;
      connRef.current = "";
      ceilingRef.current = false;
      trimAskRef.current = false;
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

  /**
   * The save barrier: brings the engine and channel to a moment of quiet,
   * then captures the position and the serialization with nothing able to
   * land in between.
   *
   * Flushing runs with remote frames still applying, because a marker may
   * only ever name frames the bytes truly contain: freezing first would
   * let arrivals queue while lastSeenSeq kept counting them. Only once
   * everything seen is applied and acked does the freeze land, the
   * position get read, and the frame serialize; the shim re-checks quiet
   * in the same synchronous turn as the serialization, and any post that
   * slipped in re-runs the loop. Null means the room never went quiet and
   * the save is declined rather than inexact.
   */
  const settleBarrier = useCallback(
    async (checkpoint: boolean): Promise<{ bin: string; upTo: number } | null> => {
      const session = sessionRef.current;
      if (!session) {
        return null;
      }
      try {
        for (let attempt = 0; attempt <= 8; attempt += 1) {
          const delay = barrierDelayMs(attempt);
          if (delay > 0) {
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
          const flush = await session.flushChanges();
          const stats = statsRef.current;
          const verdict = barrierVerdict({
            haveChanges: flush.haveChanges === true,
            haveOtherChanges: flush.haveOtherChanges === true,
            pendingAcks: stats?.pendingAcks.size ?? 0,
            postsAtCapture: 0,
            postsNow: 0,
            ceilingReached: ceilingRef.current,
            checkpoint,
            attempt,
          });
          if (verdict === "retry") {
            continue;
          }
          if (verdict === "abandon") {
            return null;
          }
          if (verdict === "proceed-unlogged") {
            // The relay is refusing posts, so the log is frozen and
            // lastSeenSeq cannot move; a plain serialization is exact,
            // and whatever the engine still holds rides the bytes,
            // never the log.
            freezeRef.current = true;
            const upTo = channelRef.current?.lastSeenSeq ?? 0;
            const bin = await session.save();
            return { bin, upTo };
          }
          // Quiet. Freeze remote delivery and read the position in the
          // same synchronous block: everything seen is applied, so
          // lastSeenSeq is exactly what the serialization will contain.
          freezeRef.current = true;
          const upTo = channelRef.current?.lastSeenSeq ?? 0;
          const postsAtCapture = stats?.chgPosted ?? 0;
          const result = await session.saveAtBarrier();
          const moved =
            result.stale ||
            (statsRef.current?.chgPosted ?? 0) !== postsAtCapture ||
            (statsRef.current?.pendingAcks.size ?? 0) !== 0;
          if (moved) {
            freezeRef.current = false;
            drainHookRef.current();
            continue;
          }
          freezeRef.current = false;
          drainHookRef.current();
          return { bin: result.bin, upTo };
        }
        return null;
      } finally {
        freezeRef.current = false;
        drainHookRef.current();
      }
    },
    [],
  );

  const save = useCallback(async (auto = false) => {
    const converter = converterRef.current;
    const session = sessionRef.current;
    if (!converter || !session || busy || stage !== "ready" || conflict) {
      return;
    }
    // Most conflicts can be caught before the work of exporting: if the
    // library's entry moved since this editor opened, someone else already
    // saved, and the question gets asked now rather than after a 409. In a
    // LIVE room this gate must not run: a co-editor's save moves the
    // entry on every sync, but its content already reached this engine as
    // frames, so a save from here is cooperative, not a conflict.
    const live = collabRef.current === "live";
    const current = useStore.getState().files.get(fileId);
    if (!live && current && describeConflict(openedAtRef.current, current.updatedAt) === "stale") {
      setConflict({ bytes: null });
      return;
    }
    setBusy(true);
    setError(null);
    let release: () => void = () => {};
    saveInFlightRef.current = new Promise<void>((resolve) => {
      release = resolve;
    });
    let out: Uint8Array | null = null;
    // A room the relay asked to trim needs a checkpoint, and this save is
    // the one that carries it; every other live save leaves the log alone.
    const checkpoint = live && trimAskRef.current;
    try {
      let bin: string;
      let upTo = 0;
      if (live) {
        // A live save writes bytes and stamps where they stand; it must
        // never guess. The barrier makes the position exact or declines.
        const settled = await settleBarrier(checkpoint);
        if (!settled) {
          diag("collab", "the room never went quiet; save declined rather than inexact");
          if (!auto) {
            setError("still catching up with the room's changes; try again in a moment");
          }
          return;
        }
        bin = settled.bin;
        upTo = settled.upTo;
      } else {
        bin = await session.save();
      }
      if (!bin) {
        throw new Error("the editor returned nothing to save");
      }
      out = await converter.exportDocument(`document.${fileType}`, bin);
      await props.onSave(out, {
        snapshot: live,
        upTo,
        mode: live ? (checkpoint ? "checkpoint" : "content") : undefined,
        conn: live && connRef.current ? connRef.current : undefined,
      });
      setDirty(false);
      dirtyRef.current = false;
      setSavedAt(Date.now());
      openedAtRef.current = useStore.getState().files.get(fileId)?.updatedAt ?? Date.now();
      if (live) {
        lastSaveRef.current = { upTo, at: Date.now() };
        if (checkpoint) {
          ceilingRef.current = false;
          trimAskRef.current = false;
        }
        if (upTo > 0) {
          // The server decides what, if anything, gets trimmed as part of
          // committing this save; nothing here may ask for it.
          pendingFramesRef.current = 0;
        }
      }
      diag("office", `saved ${file.name} (${out.length} bytes)`);
    } catch (err) {
      if (err instanceof SaveConflictError) {
        const pendingAcks = statsRef.current?.pendingAcks.size ?? 0;
        if (!checkpoint && satisfiedByPeer({ live, pendingAcks })) {
          // The winner's bytes and the surviving log carry everything
          // this engine holds; losing the race lost nothing.
          setDirty(false);
          dirtyRef.current = false;
          setSavedAt(Date.now());
          void refreshLibraryOnce();
          diag("collab", "another member's save carried this content; nothing was lost");
          return;
        }
        if (checkpoint) {
          // The trim did not happen and the room may still be refusing
          // posts; refresh, then retry once the busy flag has cleared.
          diag("collab", "checkpoint save lost the race; retrying after a refresh");
          void refreshLibraryOnce().then(() => {
            window.setTimeout(() => saveRef.current(true), 400);
          });
          return;
        }
        // The export already happened; stash the very bytes that were
        // refused so "Save as a copy" keeps exactly what was typed.
        setConflict({ bytes: out });
      } else {
        setError(err instanceof Error ? err.message : "save failed");
      }
    } finally {
      setBusy(false);
      saveInFlightRef.current = null;
      release();
    }
  }, [busy, stage, conflict, fileId, fileType, props, file.name, settleBarrier]);

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
    saveRef.current = (auto = false) => void save(auto);
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
    if (dirty || dirtyRef.current) {
      setPendingClose(true);
      return;
    }
    props.onClose();
  }, [dirty, props]);

  return (
    <div className="preview-shell">
      {pendingClose && (
        <Confirm
          title="Close without saving your changes?"
          confirmLabel="Close"
          danger
          onConfirm={props.onClose}
          onClose={() => setPendingClose(false)}
        />
      )}
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
          <div className="preview-fallback">
            {error ?? "this document could not be opened"}
            {blockedFrame && (
              <button
                className="btn"
                onClick={() => {
                  setBlockedFrame(false);
                  setError(null);
                  setStage("decrypting");
                  setReloadNonce((n) => n + 1);
                }}
              >
                Try again
              </button>
            )}
          </div>
        ) : null}
        {stage !== "ready" && stage !== "failed" && (
          <div className="office-loading">
            <span className="spinner" />
            {STAGE_LABEL[stage]}
          </div>
        )}
        <iframe
          // The editor inside announces itself exactly once per frame load,
          // and only the session listening at that moment can ever start the
          // engine. A resync builds a new session, so it must get a new
          // frame: the key ties the frame's identity to the attempt. The
          // document bytes are re-delivered by the same effect re-run.
          key={editorFrameKey(fileId, fileType, reloadNonce)}
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
