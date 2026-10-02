import { NOTIFY_PAYLOAD_MAX, type Bus } from "../../src/bus.js";

/**
 * A bus for tests: every publish reaches every subscriber of the channel,
 * on every attached instance, synchronously. A subscriber can be made to
 * miss notifications (its listener "down") and told to reconnect, which
 * runs its resync handlers exactly like the real bus does.
 */
export class LoopbackBus implements Bus {
  readonly connected = true;
  private readonly members = new Set<LoopbackMember>();

  /** One instance's view of the bus. */
  attach(): LoopbackMember {
    const member = new LoopbackMember(this);
    this.members.add(member);
    return member;
  }

  deliver(channel: string, payload: string): void {
    for (const member of this.members) {
      member.receive(channel, payload);
    }
  }

  start(): void {}
  async publish(channel: string, payload: string): Promise<void> {
    this.deliver(channel, payload);
  }
  subscribe(): () => void {
    throw new Error("subscribe through an attached member");
  }
  onReconnect(): () => void {
    throw new Error("subscribe through an attached member");
  }
  async ready(): Promise<boolean> {
    return true;
  }
  async close(): Promise<void> {}
}

export class LoopbackMember implements Bus {
  connected = true;
  /** While false, notifications addressed to this member are lost. */
  listening = true;
  readonly published: Array<{ channel: string; payload: string }> = [];
  private readonly handlers = new Map<string, Set<(payload: string) => void>>();
  private readonly reconnectHandlers = new Set<(first: boolean) => void | Promise<void>>();

  constructor(private readonly bus: LoopbackBus) {}

  start(): void {}

  async publish(channel: string, payload: string): Promise<void> {
    // The same limit the real bus enforces, so a hub that leans on the
    // rejection behaves here as it does on PostgreSQL.
    if (Buffer.byteLength(payload) > NOTIFY_PAYLOAD_MAX) {
      throw new Error(`payload exceeds the ${NOTIFY_PAYLOAD_MAX}-byte limit`);
    }
    this.published.push({ channel, payload });
    this.bus.deliver(channel, payload);
  }

  subscribe(channel: string, handler: (payload: string) => void): () => void {
    let set = this.handlers.get(channel);
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  onReconnect(handler: (first: boolean) => void | Promise<void>): () => void {
    this.reconnectHandlers.add(handler);
    return () => this.reconnectHandlers.delete(handler);
  }

  async ready(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {}

  receive(channel: string, payload: string): void {
    if (!this.listening) {
      return;
    }
    for (const handler of this.handlers.get(channel) ?? []) {
      handler(payload);
    }
  }

  /** The listener comes back: resync handlers run as after a real reconnect. */
  async reconnect(): Promise<void> {
    this.listening = true;
    for (const handler of this.reconnectHandlers) {
      await handler(false);
    }
  }
}
