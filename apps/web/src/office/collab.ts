/**
 * The bridge between the engine's collaboration protocol and channel
 * frames. Pure state and data: sockets, crypto and the DOM live elsewhere,
 * which is what makes every mapping here testable — and every one of them
 * is load-bearing, read out of the vendored engine and proven by the
 * injection spike:
 *
 *  - The engine's outgoing `saveChanges.changes` is a JSON string of an
 *    ARRAY of change strings.
 *  - Delivering a change to the engine takes ONE entry per change string,
 *    whose `change` field is `JSON.stringify(oneString)` — the engine
 *    parses it straight into its change reader, and an array-valued parse
 *    either crashes its sanity check or applies nothing.
 *  - Catch-up must happen after the document is open, as incoming
 *    saveChanges messages; auth-time authChanges is consumed then lost.
 *  - Collaboration engages only when auth reports company.
 *
 * Locks are derived from the channel's total order, identically on every
 * client: the first claim since the last release wins, and our own claim
 * is decided only once its ack names its position. The server arbitrates
 * nothing.
 */

export interface EngineMessage {
  type?: string;
  [key: string]: unknown;
}

/**
 * The prefix the editor's own user id carries. The engine computes its
 * identity as editorConfig.user.id + indexUser and compares that string to
 * the `user` field on every lock and change frame; session.ts sets the
 * editor's user.id to this same prefix, so member N's identity is exactly
 * engineUserId(N) on every client, keyed only on the relay index.
 */
export const ENGINE_USER_PREFIX = "u";

/** The identity the engine holds for a member at this relay index. */
export function engineUserId(index: number): string {
  return `${ENGINE_USER_PREFIX}${index}`;
}

export type BridgeFrameKind = "chg" | "lock" | "unlock" | "cursor";

/** A frame the caller must seal and post (durable) or broadcast (eph). */
export interface OutFrame {
  ref: number;
  k: BridgeFrameKind;
  d: Record<string, unknown>;
}

export interface BridgeEffects {
  toEditor: EngineMessage[];
  post: OutFrame[];
  eph: OutFrame[];
}

interface Member {
  connId: string;
  index: number;
  /** Who this is, shown beside their cursor and in the participant list. */
  name?: string;
}

interface PendingPost {
  kind: BridgeFrameKind;
  /** Change strings riding this frame, for the cumulative index. */
  changes: string[];
  /** Lock block this frame claims, when it is a claim. */
  block?: string;
  /** Whether the engine expects more chunks after this one. */
  partial?: boolean;
}

const none = (): BridgeEffects => ({ toEditor: [], post: [], eph: [] });

function participant(member: Member) {
  return {
    id: engineUserId(member.index),
    idOriginal: engineUserId(member.index),
    username: member.name ?? `member ${member.index}`,
    indexUser: member.index,
    connectionId: member.connId,
  };
}

/**
 * A phantom participant at reserved index 0, in every list the engine
 * sees. The engine's lock-release machinery only runs while it believes
 * other editors exist; alone, released locks stick at their intermediate
 * state and the brackets never clear. The relay's member counter starts
 * at 1, so index 0 can never collide with a real member.
 */
const HISTORY_KEEPER = {
  id: engineUserId(0),
  idOriginal: engineUserId(0),
  username: "history",
  indexUser: 0,
  connectionId: "history-keeper",
  view: false,
};

function participants(members: Member[]) {
  return [HISTORY_KEEPER, ...members.map(participant)];
}

export class CollabBridge {
  private readonly fileId: string;
  private readonly selfIndex: number;
  private members: Member[];
  /** Total change strings accepted into the order so far, ours included. */
  private appliedChanges = 0;
  /** block -> holding member index; save lock rides the same table. */
  private readonly locks = new Map<string, number>();
  private readonly pending = new Map<number, PendingPost>();
  private nextRef = 1;

  constructor(options: {
    fileId: string;
    selfConnId: string;
    selfIndex: number;
    members: Member[];
  }) {
    this.fileId = options.fileId;
    this.selfIndex = options.selfIndex;
    this.members = options.members;
  }

  /** The engine's identity is keyed to this index at init time. */
  get index(): number {
    return this.selfIndex;
  }

  /** The cumulative change count fed to the engine; read for diagnostics. */
  get changes(): number {
    return this.appliedChanges;
  }

  /** Everything the engine sends "to the server" enters here. */
  onEngineMessage(message: EngineMessage): BridgeEffects {
    const effects = none();
    switch (message.type) {
      case "auth": {
        effects.toEditor.push({ type: "authChanges", changes: [] });
        effects.toEditor.push({
          type: "auth",
          result: 1,
          sessionId: "channel",
          participants: participants(this.members),
          locks: [],
          changes: [],
          changesIndex: 0,
          indexUser: this.selfIndex,
          buildVersion: "5.2.6",
          buildNumber: 2,
          licenseType: 3,
          settings: { websocketMaxPayloadSize: 65536 },
        });
        effects.toEditor.push({
          type: "documentOpen",
          data: {
            type: "open",
            status: "ok",
            data: {
              "Editor.bin": (message.openCmd as { url?: string } | undefined)?.url ?? "engram:document",
            },
          },
        });
        return effects;
      }
      case "isSaveLock": {
        const ref = this.postFrame(effects, "lock", { block: SAVE_LOCK }, { block: SAVE_LOCK });
        void ref;
        return effects;
      }
      case "saveChanges": {
        const changes = JSON.parse(String(message.changes ?? "[]")) as string[];
        this.postFrame(
          effects,
          "chg",
          {
            changes,
            // The blocks this member holds ride the frame: for text
            // documents the locks array on a saveChanges is the only way
            // a peer's engine ever clears them.
            locks: this.ownBlocks(),
            deleteIndex: message.deleteIndex ?? null,
            excelAdditionalInfo: message.excelAdditionalInfo ?? null,
          },
          { changes, partial: message.endSaveChanges === false },
        );
        return effects;
      }
      case "getLock": {
        const block = String(message.block);
        this.postFrame(effects, "lock", { block }, { block });
        return effects;
      }
      case "unLockDocument": {
        this.postFrame(effects, "unlock", { save: message.isSave === true }, {});
        if (message.isSave) {
          effects.toEditor.push({ type: "unSaveLock", time: -1, index: -1 });
        }
        return effects;
      }
      case "cursor": {
        effects.eph.push({
          ref: 0,
          k: "cursor",
          // Cloned: the engine reuses and mutates the object it handed
          // over, and the frame may be sealed on a later tick.
          d: { idx: this.selfIndex, cursor: structuredClone(message.cursor) },
        });
        return effects;
      }
      case "getMessages": {
        effects.toEditor.push({ type: "message" });
        return effects;
      }
      default:
        return effects;
    }
  }

  /**
   * Our own durable frame took its place in the order. Locks decide here
   * and never earlier: an earlier remote claim has, by now, already been
   * delivered ahead of this ack.
   */
  onOwnFrameAcked(ref: number, seq: number): BridgeEffects {
    void seq;
    const effects = none();
    const sent = this.pending.get(ref);
    if (!sent) {
      return effects;
    }
    this.pending.delete(ref);
    switch (sent.kind) {
      case "chg": {
        this.appliedChanges += sent.changes.length;
        this.releaseOwnBlocks();
        if (sent.partial) {
          // -1 = "leave your counter alone": savePartChanges is only the
          // ack that pulls the next chunk, and a live value here would
          // feed the engine's deleteIndex arithmetic with our bookkeeping.
          effects.toEditor.push({ type: "savePartChanges", changesIndex: -1 });
        } else {
          effects.toEditor.push({
            type: "unSaveLock",
            index: this.appliedChanges,
            time: Date.now(),
          });
        }
        return effects;
      }
      case "lock": {
        const block = sent.block!;
        if (!this.locks.has(block)) {
          this.locks.set(block, this.selfIndex);
        }
        const holder = this.locks.get(block)!;
        if (block === SAVE_LOCK) {
          effects.toEditor.push({ type: "saveLock", saveLock: holder !== this.selfIndex });
          if (holder === this.selfIndex) {
            // A save lock is a moment, not a tenure; it frees on the save.
            this.locks.delete(block);
          }
        } else {
          effects.toEditor.push({
            type: "getLock",
            locks: { [block]: { user: engineUserId(holder), block, time: Date.now() } },
          });
        }
        return effects;
      }
      case "unlock": {
        this.releaseOwnBlocks();
        return effects;
      }
      default:
        return effects;
    }
  }

  /** A decoded, order-accepted frame from another connection. */
  onRemoteFrame(frame: {
    ch: string;
    s: string;
    n: number;
    k: string;
    d: unknown;
  }): BridgeEffects {
    const effects = none();
    const data = (frame.d ?? {}) as Record<string, unknown>;
    const senderIndex = Number(data.idx ?? 0);
    switch (frame.k) {
      case "chg": {
        const changes = (data.changes as string[] | undefined) ?? [];
        this.appliedChanges += changes.length;
        this.releaseBlocksOf(senderIndex);
        const time = Date.now();
        // The sender's held blocks travel on the frame; handing them to
        // the engine here is what clears its red lock brackets.
        const released = ((data.locks as string[] | undefined) ?? []).map((block) =>
          lockEntry(block, senderIndex),
        );
        effects.toEditor.push({
          type: "saveChanges",
          changes: changes.map((change) => ({
            change: JSON.stringify(change),
            user: engineUserId(senderIndex),
            useridoriginal: engineUserId(senderIndex),
            time,
          })),
          changesIndex: this.appliedChanges,
          syncChangesIndex: this.appliedChanges,
          endSaveChanges: true,
          locks: released,
        });
        return effects;
      }
      case "lock": {
        const block = String(data.block);
        if (!this.locks.has(block)) {
          this.locks.set(block, senderIndex);
        }
        if (block !== SAVE_LOCK) {
          effects.toEditor.push({
            type: "getLock",
            locks: {
              [block]: { user: engineUserId(this.locks.get(block)!), block, time: Date.now() },
            },
          });
        }
        return effects;
      }
      case "unlock": {
        this.releaseBlocksOf(senderIndex);
        return effects;
      }
      case "cursor": {
        effects.toEditor.push({
          type: "cursor",
          messages: [
            {
              cursor: data.cursor,
              user: engineUserId(senderIndex),
              useridoriginal: engineUserId(senderIndex),
            },
          ],
        });
        return effects;
      }
      default:
        return effects;
    }
  }

  /**
   * The channel's membership moved; the engine learns via connectState.
   * A departed member can never commit or unlock again, so its held
   * blocks are released on its behalf, delivered to the engine on the
   * same locks-on-saveChanges vehicle a commit would use, and its cursor
   * is erased with the engine's own empty-cursor string.
   */
  onMembers(members: Member[]): BridgeEffects {
    const present = new Set(members.map((m) => m.index));
    const departed = [...new Set([...this.locks.values()])].filter(
      (holder) => holder !== this.selfIndex && !present.has(holder),
    );
    this.members = members;
    const effects = none();
    effects.toEditor.push({
      type: "connectState",
      participants: participants(members),
      participantsTimestamp: Date.now(),
    });
    for (const index of departed) {
      const released = [...this.locks.entries()]
        .filter(([, holder]) => holder === index)
        .map(([block]) => lockEntry(block, index));
      this.releaseBlocksOf(index);
      if (released.length > 0) {
        effects.toEditor.push({
          type: "saveChanges",
          changes: [],
          changesIndex: this.appliedChanges,
          syncChangesIndex: this.appliedChanges,
          endSaveChanges: true,
          locks: released,
        });
      }
      effects.toEditor.push({
        type: "cursor",
        messages: [
          {
            cursor: EMPTY_CURSOR,
            user: engineUserId(index),
            useridoriginal: engineUserId(index),
          },
        ],
      });
    }
    return effects;
  }

  /** The non-save blocks this member currently holds. */
  private ownBlocks(): string[] {
    return [...this.locks.entries()]
      .filter(([block, holder]) => holder === this.selfIndex && block !== SAVE_LOCK)
      .map(([block]) => block);
  }

  private postFrame(
    effects: BridgeEffects,
    kind: BridgeFrameKind,
    data: Record<string, unknown>,
    pending: Omit<PendingPost, "kind" | "changes"> & { changes?: string[] },
  ): number {
    const ref = this.nextRef++;
    this.pending.set(ref, { kind, changes: pending.changes ?? [], ...pending });
    effects.post.push({ ref, k: kind, d: { idx: this.selfIndex, ...data } });
    return ref;
  }

  /** A member's committed batch or explicit unlock releases their claims. */
  private releaseBlocksOf(index: number): void {
    for (const [block, holder] of this.locks) {
      if (holder === index) {
        this.locks.delete(block);
      }
    }
  }

  private releaseOwnBlocks(): void {
    this.releaseBlocksOf(this.selfIndex);
  }
}

/** The whole-document save lock rides the lock table under one name. */
const SAVE_LOCK = "__save__";

/** A released lock as the engine's saveChanges handler expects it. */
function lockEntry(block: string, holder: number) {
  return { block, user: engineUserId(holder), time: Date.now() };
}

/** The engine's own "no cursor" string; showing it erases a caret. */
const EMPTY_CURSOR = "10;AgAAADIAAAAAAA==";
