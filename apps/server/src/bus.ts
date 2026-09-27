import pg from "pg";

/**
 * The bus between server instances. One instance's change has to reach
 * the streams and sockets another instance holds: a poke for the change
 * feed, a channel frame, a cache entry to drop. PostgreSQL carries it as
 * LISTEN/NOTIFY: it is already the shared store, a notification sent
 * inside a transaction is delivered only when that transaction commits,
 * and the volume is small. Payloads are tiny and never carry content;
 * anything large is re-read from its table by the receiver.
 *
 * The listener is one dedicated connection per instance, never from the
 * pool (a pooled connection is handed to the next query; a pooler in
 * transaction mode drops the subscription silently). Everything that can
 * go wrong with it is a connection event, and the answer to each is the
 * same: make a new client, LISTEN again, and tell the subscribers to
 * resync. Late events from a client already given up on are ignored.
 */
export interface Bus {
  /** Whether the listener is up right now. Informational: pokes from
   * other instances pause while it is down; nothing else does. */
  readonly connected: boolean;
  start(): void;
  /** Sends `payload` to every instance listening on `channel`, this one
   * included. Rejects payloads over the NOTIFY limit. */
  publish(channel: string, payload: string): Promise<void>;
  subscribe(channel: string, handler: (payload: string) => void): () => void;
  /** Runs after every successful (re)connect, `first` on the initial one.
   * A resync belongs here: whatever was notified while the listener was
   * down never arrives, so subscribers re-read their state. */
  onReconnect(handler: (first: boolean) => void | Promise<void>): () => void;
  /** Resolves true once connected, false after `waitMs` without a
   * connection; the bus keeps trying either way. */
  ready(waitMs: number): Promise<boolean>;
  close(): Promise<void>;
}

/** NOTIFY payloads are capped at 8000 bytes by PostgreSQL; this leaves
 * room for the channel name and framing. */
export const NOTIFY_PAYLOAD_MAX = 7500;

/** The one-instance bus: nothing to reach, so publish is a no-op and the
 * callers keep one code path. */
export class InProcessBus implements Bus {
  readonly connected = true;
  start(): void {}
  async publish(): Promise<void> {}
  subscribe(): () => void {
    return () => {};
  }
  onReconnect(): () => void {
    return () => {};
  }
  async ready(): Promise<boolean> {
    return true;
  }
  async close(): Promise<void> {}
}

/** The slice of node-postgres' Client the bus uses; tests supply fakes. */
export interface BusClient {
  connect(): Promise<void>;
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
  on(event: "notification", handler: (message: { channel: string; payload?: string }) => void): unknown;
  on(event: "error", handler: (err: Error) => void): unknown;
  on(event: "end", handler: () => void): unknown;
}

export interface PgBusOptions {
  /** A direct connection to the primary: LISTEN fails on a standby and
   * does not survive a transaction-mode pooler. */
  listenUrl: string;
  /** This instance's id; it names the connections in pg_stat_activity. */
  origin: string;
  createClient?: (role: "listener" | "publisher") => BusClient;
  backoffMs?: { min: number; max: number };
  heartbeatMs?: number;
  heartbeatTimeoutMs?: number;
  log?: (message: string) => void;
}

const CHANNEL_NAME = /^[a-z][a-z0-9_]*$/;

export class PgBus implements Bus {
  connected = false;
  private closed = false;
  /** Bumped whenever the current listener is replaced; events that carry
   * an older generation belong to a client already given up on. */
  private generation = 0;
  private connects = 0;
  private failures = 0;
  private listener: BusClient | null = null;
  private publisher: BusClient | null = null;
  private publisherReady: Promise<BusClient> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly handlers = new Map<string, Set<(payload: string) => void>>();
  private readonly reconnectHandlers = new Set<(first: boolean) => void | Promise<void>>();
  private readonly readyWaiters: Array<(ok: boolean) => void> = [];
  private readonly createClient: (role: "listener" | "publisher") => BusClient;
  private readonly backoff: { min: number; max: number };
  private readonly heartbeatMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly log: (message: string) => void;

  constructor(options: PgBusOptions) {
    this.backoff = options.backoffMs ?? { min: 250, max: 5_000 };
    this.heartbeatMs = options.heartbeatMs ?? 30_000;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 5_000;
    this.log = options.log ?? ((message) => console.warn(`bus: ${message}`));
    this.createClient =
      options.createClient ??
      ((role) =>
        new pg.Client({
          connectionString: options.listenUrl,
          application_name: `engram-${role}-${options.origin}`,
          // A session that dies silently behind a proxy or a NAT shows up
          // as a keepalive failure; the heartbeat catches the rest.
          keepAlive: true,
          keepAliveInitialDelayMillis: 30_000,
        }) as unknown as BusClient);
  }

  start(): void {
    if (this.closed || this.listener || this.reconnectTimer) {
      return;
    }
    void this.connectListener();
  }

  subscribe(channel: string, handler: (payload: string) => void): () => void {
    if (!CHANNEL_NAME.test(channel)) {
      throw new Error(`bus: channel name "${channel}" is not a plain identifier`);
    }
    let set = this.handlers.get(channel);
    const fresh = !set;
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
    }
    set.add(handler);
    if (fresh && this.listener) {
      this.listener.query(`LISTEN ${channel}`).catch((err: Error) => this.log(`LISTEN ${channel} failed: ${err.message}`));
    }
    return () => {
      set!.delete(handler);
    };
  }

  onReconnect(handler: (first: boolean) => void | Promise<void>): () => void {
    this.reconnectHandlers.add(handler);
    return () => {
      this.reconnectHandlers.delete(handler);
    };
  }

  ready(waitMs: number): Promise<boolean> {
    if (this.connected) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const waiter = (ok: boolean) => {
        clearTimeout(timer);
        resolve(ok);
      };
      const timer = setTimeout(() => {
        const at = this.readyWaiters.indexOf(waiter);
        if (at >= 0) {
          this.readyWaiters.splice(at, 1);
        }
        resolve(false);
      }, waitMs);
      timer.unref?.();
      this.readyWaiters.push(waiter);
    });
  }

  async publish(channel: string, payload: string): Promise<void> {
    if (!CHANNEL_NAME.test(channel)) {
      throw new Error(`bus: channel name "${channel}" is not a plain identifier`);
    }
    const bytes = Buffer.byteLength(payload);
    if (bytes > NOTIFY_PAYLOAD_MAX) {
      throw new Error(`bus: a ${bytes}-byte payload exceeds the ${NOTIFY_PAYLOAD_MAX}-byte notification limit`);
    }
    const client = await this.publisherClient();
    try {
      await client.query("SELECT pg_notify($1, $2)", [channel, payload]);
    } catch (err) {
      this.forgetPublisher(client);
      throw err;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.generation++;
    this.connected = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearHeartbeat();
    const listener = this.listener;
    this.listener = null;
    await listener?.end().catch(() => {});
    const publisher = this.publisher ?? (this.publisherReady ? await this.publisherReady.catch(() => null) : null);
    this.publisher = null;
    this.publisherReady = null;
    await publisher?.end().catch(() => {});
    this.readyWaiters.splice(0).forEach((wake) => wake(false));
  }

  private async connectListener(): Promise<void> {
    if (this.closed) {
      return;
    }
    const generation = ++this.generation;
    const stale = () => this.closed || generation !== this.generation;
    const client = this.createClient("listener");
    client.on("error", (err) => {
      if (!stale()) {
        this.dropListener(client, `connection error: ${err.message}`);
      }
    });
    client.on("end", () => {
      if (!stale()) {
        this.dropListener(client, "connection ended");
      }
    });
    client.on("notification", (message) => {
      if (!stale()) {
        this.dispatch(message.channel, message.payload ?? "");
      }
    });
    try {
      await client.connect();
      for (const channel of this.handlers.keys()) {
        await client.query(`LISTEN ${channel}`);
      }
    } catch (err) {
      client.end().catch(() => {});
      if (!stale()) {
        this.scheduleReconnect(`connect failed: ${(err as Error).message}`);
      }
      return;
    }
    if (stale()) {
      client.end().catch(() => {});
      return;
    }
    this.listener = client;
    this.connected = true;
    this.failures = 0;
    const first = this.connects === 0;
    this.connects++;
    this.armHeartbeat(generation);
    this.readyWaiters.splice(0).forEach((wake) => wake(true));
    for (const handler of this.reconnectHandlers) {
      try {
        await handler(first);
      } catch (err) {
        this.log(`resync handler failed: ${(err as Error).message}`);
      }
    }
  }

  /** Gives up on the current listener and arranges its replacement. */
  private dropListener(client: BusClient, reason: string): void {
    this.generation++;
    this.connected = false;
    this.listener = null;
    this.clearHeartbeat();
    client.end().catch(() => {});
    this.scheduleReconnect(reason);
  }

  private scheduleReconnect(reason: string): void {
    if (this.closed || this.reconnectTimer) {
      return;
    }
    const base = Math.min(this.backoff.max, this.backoff.min * 2 ** Math.min(this.failures, 10));
    this.failures++;
    const delay = Math.floor(base / 2 + Math.random() * (base / 2));
    this.log(`listener ${reason}; reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectListener();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private dispatch(channel: string, payload: string): void {
    const set = this.handlers.get(channel);
    if (!set) {
      return;
    }
    for (const handler of set) {
      try {
        handler(payload);
      } catch (err) {
        this.log(`handler for ${channel} failed: ${(err as Error).message}`);
      }
    }
  }

  private armHeartbeat(generation: number): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => void this.heartbeat(generation), this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** A session can die without a single event reaching the client, and
   * LISTEN on a standby receives nothing; a periodic query on the listening
   * connection notices both. Running a query while listening is safe. */
  private async heartbeat(generation: number): Promise<void> {
    const client = this.listener;
    if (!client || generation !== this.generation) {
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.heartbeatTimeoutMs);
      timer.unref?.();
    });
    try {
      const result = await Promise.race([
        client.query("SELECT pg_is_in_recovery() AS pg_is_in_recovery"),
        timeout,
      ]);
      if (result === "timeout") {
        throw new Error("heartbeat timed out");
      }
      const row = (result as { rows: Array<{ pg_is_in_recovery: boolean }> }).rows[0];
      if (row?.pg_is_in_recovery) {
        throw new Error("connected to a standby");
      }
    } catch (err) {
      if (generation === this.generation) {
        this.dropListener(client, (err as Error).message);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private publisherClient(): Promise<BusClient> {
    if (this.publisherReady) {
      return this.publisherReady;
    }
    this.publisherReady = (async () => {
      const client = this.createClient("publisher");
      client.on("error", (err) => {
        this.log(`publisher connection error: ${err.message}`);
        this.forgetPublisher(client);
      });
      client.on("end", () => this.forgetPublisher(client));
      await client.connect();
      // A notification that carries no data change needs no durability
      // of its own; skipping the WAL flush wait keeps publishing cheap on a
      // cluster with synchronous replication.
      await client.query("SET synchronous_commit = off");
      this.publisher = client;
      return client;
    })().catch((err: unknown) => {
      this.publisherReady = null;
      throw err;
    });
    return this.publisherReady;
  }

  private forgetPublisher(client: BusClient): void {
    if (this.publisher === client) {
      this.publisher = null;
      this.publisherReady = null;
    }
    client.end().catch(() => {});
  }
}
