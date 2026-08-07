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
  you: string;
  yourIndex: number;
  members: Array<{ connId: string; index: number; name?: string }>;
}

export interface ChannelEvents {
  onWelcome(welcome: ChannelWelcome): void;
  onLog(seq: number, sender: string, payload: string): void;
  onCaughtUp(seq: number): void;
  onEph(sender: string, payload: string): void;
  onMembers(members: Array<{ connId: string; index: number; name?: string }>): void;
  onAck(ref: number, seq: number): void;
  onTruncated(snapshotGeneration: number, snapshotSeq: number): void;
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

  /** Dials and resolves once the welcome arrives. */
  async connect(): Promise<ChannelWelcome> {
    const { ticket } = await api.collabTicket(this.fileId);
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(
      `${scheme}://${location.host}/api/collab/${this.fileId}/channel?ticket=${ticket}`,
    );
    this.socket = socket;
    return new Promise<ChannelWelcome>((resolve, reject) => {
      let welcomed = false;
      socket.onopen = () => {
        socket.send(JSON.stringify({ t: "hello", lastSeq: this.lastSeq }));
      };
      socket.onmessage = (event) => {
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
            this.events.onTruncated(Number(frame.snapshotGeneration), Number(frame.snapshotSeq));
            return;
          default:
            return;
        }
      };
      socket.onclose = () => {
        if (this.closed) {
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
    this.socket?.close();
  }
}
