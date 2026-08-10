/**
 * The socket half of the collaboration channel: dial with a single-use
 * ticket, greet with the last position seen, hand every ordered event to
 * the wiring, and redial with backoff when the connection drops. All
 * decisions about frames — crypto, ordering, what they mean — live in
 * channel.ts and collab.ts; this file only moves bytes and survives
 * disconnects.
 */

import { api } from "../api";

export interface ChannelWelcome {
  channelSeq: number;
  snapshotGeneration: number;
  snapshotSeq: number;
  /** Which generation the stored bytes are; absent on an older server. */
  contentGeneration?: number;
  /** The channel position those bytes contain; absent on an older server. */
  contentChannelSeq?: number;
  you: string;
  yourIndex: number;
  members: Array<{ connId: string; index: number; name?: string; role?: string }>;
}

export interface ChannelEvents {
  onWelcome(welcome: ChannelWelcome): void;
  onLog(seq: number, sender: string, payload: string): void;
  onCaughtUp(seq: number): void;
  onEph(sender: string, payload: string): void;
  onMembers(members: Array<{ connId: string; index: number; name?: string; role?: string }>): void;
  onAck(ref: number, seq: number): void;
  onTruncated(snapshotGeneration: number, snapshotSeq: number): void;
  /** A content save moved the stored bytes without touching the log. */
  onContent?(contentGeneration: number, contentChannelSeq: number): void;
  /** The log wants a trim: "soft" warns while posts still land, "ceiling"
   * (or nothing, from an older server) means posts are being refused. */
  onPleaseSnapshot(reason?: string): void;
  /** The channel is gone and redialing has been abandoned. */
  onDead(): void;
}

const MAX_REDIALS = 5;

export class ChannelClient {
  private socket: WebSocket | null = null;
  private closed = false;
  private redials = 0;
  private lastSeq = 0;
  /** Posts issued while offline wait here and drain in order on reconnect. */
  private outbox: Array<{ ref: number; payload: string }> = [];

  constructor(
    private readonly fileId: string,
    private readonly events: ChannelEvents,
  ) {}

  /**
   * Keeps bytes moving while the editor loads. A phone can spend a
   * minute starting the editor with the socket completely idle, and
   * idle-timeout proxies kill quiet connections; the relay ignores
   * unknown frame kinds, so this costs one tiny frame every 20s.
   */
  private keepalive: number | null = null;

  /** Dials and resolves once the welcome arrives. */
  async connect(): Promise<ChannelWelcome> {
    const { ticket } = await api.collabTicket(this.fileId);
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(
      `${scheme}://${location.host}/api/collab/${this.fileId}/channel?ticket=${ticket}`,
    );
    // One live socket, ever. A redial racing a slow earlier dial would
    // otherwise leave two sockets replaying the same log interleaved,
    // which reads as counter gaps and burns the repair budget; closing
    // the loser here and gating every handler below on identity makes
    // the newest dial the only voice.
    const superseded = this.socket;
    this.socket = socket;
    if (superseded && superseded !== socket) {
      superseded.onmessage = null;
      superseded.onclose = null;
      superseded.close();
    }
    if (this.keepalive === null) {
      this.keepalive = window.setInterval(() => {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
          this.socket.send(JSON.stringify({ t: "ping" }));
        }
      }, 20_000);
    }
    return new Promise<ChannelWelcome>((resolve, reject) => {
      let welcomed = false;
      socket.onopen = () => {
        socket.send(JSON.stringify({ t: "hello", lastSeq: this.lastSeq }));
      };
      socket.onmessage = (event) => {
        if (this.socket !== socket) {
          return;
        }
        const frame = JSON.parse(String(event.data)) as { t: string; [key: string]: unknown };
        switch (frame.t) {
          case "welcome": {
            welcomed = true;
            this.redials = 0;
            const welcome = frame as unknown as ChannelWelcome & { t: string };
            this.events.onWelcome(welcome);
            for (const queued of this.outbox.splice(0)) {
              socket.send(JSON.stringify({ t: "post", ref: queued.ref, payload: queued.payload }));
            }
            resolve(welcome);
            return;
          }
          case "log":
            this.lastSeq = Math.max(this.lastSeq, Number(frame.seq));
            this.events.onLog(Number(frame.seq), String(frame.sender), String(frame.payload));
            return;
          case "caught-up":
            this.lastSeq = Math.max(this.lastSeq, Number(frame.seq));
            this.events.onCaughtUp(Number(frame.seq));
            return;
          case "eph":
            this.events.onEph(String(frame.sender), String(frame.payload));
            return;
          case "members":
            this.events.onMembers(frame.members as Array<{ connId: string; index: number; name?: string }>);
            return;
          case "ack":
            this.lastSeq = Math.max(this.lastSeq, Number(frame.seq));
            this.events.onAck(Number(frame.ref), Number(frame.seq));
            return;
          case "truncated":
            // A checkpoint also names where the new bytes stand; keep the
            // marker fresh before the truncation decision runs.
            if (frame.contentGeneration !== undefined) {
              this.events.onContent?.(
                Number(frame.contentGeneration),
                Number(frame.contentChannelSeq),
              );
            }
            this.events.onTruncated(Number(frame.snapshotGeneration), Number(frame.snapshotSeq));
            return;
          case "content":
            this.events.onContent?.(
              Number(frame.contentGeneration),
              Number(frame.contentChannelSeq),
            );
            return;
          case "please-snapshot":
            this.events.onPleaseSnapshot(
              typeof frame.reason === "string" ? frame.reason : undefined,
            );
            return;
          default:
            return;
        }
      };
      socket.onclose = () => {
        if (this.closed || this.socket !== socket) {
          return;
        }
        if (!welcomed) {
          reject(new Error("the channel refused the connection"));
          this.events.onDead();
          return;
        }
        this.redial();
      };
      socket.onerror = () => {
        // onclose follows and carries the decision.
      };
    });
  }

  private redial(): void {
    if (this.closed || this.redials >= MAX_REDIALS) {
      this.events.onDead();
      return;
    }
    // Full jitter keeps a room of dropped clients from stampeding back.
    const delay = Math.random() * Math.min(15_000, 500 * 2 ** this.redials);
    this.redials += 1;
    setTimeout(() => {
      if (!this.closed) {
        // A NEW connection id and member index arrive with the fresh
        // welcome; the wiring rebuilds its bridge state from it.
        this.connect().catch(() => this.events.onDead());
      }
    }, delay);
  }

  /** Posts a durable frame; queued for the next connection when offline. */
  post(ref: number, payload: string): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ t: "post", ref, payload }));
    } else {
      this.outbox.push({ ref, payload });
    }
  }

  /** Broadcasts an ephemeral frame; silently dropped while offline. */
  eph(payload: string): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ t: "eph", payload }));
    }
  }

  /** The highest channel position this client has seen or been acked. */
  get lastSeenSeq(): number {
    return this.lastSeq;
  }

  close(): void {
    this.closed = true;
    if (this.keepalive !== null) {
      window.clearInterval(this.keepalive);
      this.keepalive = null;
    }
    this.socket?.close();
  }
}
