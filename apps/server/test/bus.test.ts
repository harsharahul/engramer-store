import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PgBus, type BusClient } from "../src/bus.js";

/**
 * The bus is one LISTEN connection per server instance. Everything that can
 * go wrong with it is a connection event: the socket ends during a database
 * failover, connect fails while the primary moves, a session dies silently
 * behind a proxy. The listener recreates its client every time, re-issues
 * LISTEN, and tells its subscribers to resync; events from a client it has
 * already given up on are ignored.
 */
class FakeClient extends EventEmitter implements BusClient {
  static created: FakeClient[] = [];
  static failNextConnect = 0;
  readonly queries: string[] = [];
  ended = false;
  /** Set by a test to make the heartbeat hang. */
  hang = false;

  constructor() {
    super();
    FakeClient.created.push(this);
  }

  async connect(): Promise<void> {
    if (FakeClient.failNextConnect > 0) {
      FakeClient.failNextConnect--;
      throw new Error("connection refused");
    }
  }

  async query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> {
    this.queries.push(values ? `${text} ${JSON.stringify(values)}` : text);
    if (this.hang && /pg_is_in_recovery/.test(text)) {
      return new Promise(() => {});
    }
    if (/pg_is_in_recovery/.test(text)) {
      return { rows: [{ pg_is_in_recovery: false }] };
    }
    return { rows: [] };
  }

  async end(): Promise<void> {
    this.ended = true;
  }

  notify(channel: string, payload: string): void {
    this.emit("notification", { channel, payload });
  }
}

function makeBus(overrides: Partial<ConstructorParameters<typeof PgBus>[0]> = {}) {
  return new PgBus({
    listenUrl: "postgres://unused",
    origin: "pod-test",
    createClient: () => new FakeClient(),
    backoffMs: { min: 5, max: 20 },
    heartbeatMs: 1_000_000,
    heartbeatTimeoutMs: 50,
    ...overrides,
  });
}

async function tick(ms = 10): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("PgBus", () => {
  afterEach(() => {
    FakeClient.created = [];
    FakeClient.failNextConnect = 0;
    vi.useRealTimers();
  });

  it("listens on every subscribed channel once connected and delivers notifications", async () => {
    const bus = makeBus();
    const seen: string[] = [];
    bus.subscribe("engram_seq", (payload) => seen.push(payload));
    bus.start();
    expect(await bus.ready(500)).toBe(true);
    const listener = FakeClient.created[0]!;
    expect(listener.queries.some((q) => /^LISTEN engram_seq$/.test(q))).toBe(true);
    listener.notify("engram_seq", "7:12:pod-other");
    listener.notify("engram_blob", "ignored: nobody subscribed");
    expect(seen).toEqual(["7:12:pod-other"]);
    // A channel subscribed after connecting is listened to right away.
    bus.subscribe("engram_blob", (payload) => seen.push(payload));
    await tick();
    expect(listener.queries.some((q) => /^LISTEN engram_blob$/.test(q))).toBe(true);
    await bus.close();
    expect(listener.ended).toBe(true);
  });

  it("reconnects with a new client when the socket ends, re-listens and asks subscribers to resync", async () => {
    const bus = makeBus();
    const resyncs: boolean[] = [];
    bus.subscribe("engram_seq", () => {});
    bus.onReconnect((first) => {
      resyncs.push(first);
    });
    bus.start();
    await bus.ready(500);
    const first = FakeClient.created[0]!;
    first.emit("end");
    await tick(60);
    expect(FakeClient.created.length).toBe(2);
    const second = FakeClient.created[1]!;
    expect(second.queries.some((q) => /^LISTEN engram_seq$/.test(q))).toBe(true);
    expect(resyncs).toEqual([true, false]);
    expect(bus.connected).toBe(true);
    await bus.close();
  });

  it("ignores events from a client it has already replaced", async () => {
    const bus = makeBus();
    const seen: string[] = [];
    bus.subscribe("engram_seq", (payload) => seen.push(payload));
    bus.start();
    await bus.ready(500);
    const first = FakeClient.created[0]!;
    first.emit("error", new Error("57P01 terminating connection"));
    await tick(60);
    expect(FakeClient.created.length).toBe(2);
    first.notify("engram_seq", "late from the dead client");
    FakeClient.created[1]!.notify("engram_seq", "live");
    expect(seen).toEqual(["live"]);
    await bus.close();
  });

  it("keeps retrying while connect fails, with backoff, and reports not connected meanwhile", async () => {
    FakeClient.failNextConnect = 2;
    const bus = makeBus();
    bus.subscribe("engram_seq", () => {});
    bus.start();
    expect(bus.connected).toBe(false);
    expect(await bus.ready(500)).toBe(true);
    expect(FakeClient.created.length).toBe(3);
    await bus.close();
  });

  it("treats a heartbeat that does not answer as a dead session", async () => {
    const bus = makeBus({ heartbeatMs: 30, heartbeatTimeoutMs: 30 });
    bus.subscribe("engram_seq", () => {});
    bus.start();
    await bus.ready(500);
    const first = FakeClient.created[0]!;
    first.hang = true;
    await tick(150);
    expect(FakeClient.created.length).toBeGreaterThanOrEqual(2);
    expect(first.ended).toBe(true);
    await bus.close();
  });

  it("publishes through its own connection and refuses payloads over the NOTIFY limit", async () => {
    const bus = makeBus();
    bus.start();
    await bus.ready(500);
    await bus.publish("engram_blob", "abc.thumb");
    const publisher = FakeClient.created.find((c) =>
      c.queries.some((q) => /synchronous_commit/.test(q)),
    );
    expect(publisher).toBeDefined();
    expect(publisher!.queries.some((q) => /pg_notify/.test(q) && /abc\.thumb/.test(q))).toBe(true);
    await expect(bus.publish("engram_blob", "x".repeat(8000))).rejects.toThrow(/7500/);
    await bus.close();
    expect(publisher!.ended).toBe(true);
  });

  it("ready() gives up after the bounded wait and the bus keeps trying", async () => {
    FakeClient.failNextConnect = 1000;
    const bus = makeBus();
    bus.start();
    expect(await bus.ready(60)).toBe(false);
    expect(bus.connected).toBe(false);
    await bus.close();
  });
});
