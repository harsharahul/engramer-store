/**
 * A held change-feed stream for the conformance suites, read over real
 * HTTP. Every wait is bounded, and every stream is closed by the test
 * that opened it.
 */
import { expect } from "vitest";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class Feed {
  status = 0;
  headers: Record<string, string> = {};
  private buffer = "";
  private readonly events: Array<{ seq: number }> = [];
  private readonly comments: string[] = [];
  private ended = false;
  private readonly controller = new AbortController();

  async open(baseUrl: string, token?: string): Promise<this> {
    const response = await fetch(`${baseUrl}/api/events`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: this.controller.signal,
    });
    this.status = response.status;
    response.headers.forEach((value, key) => {
      this.headers[key] = value;
    });
    if (response.status === 200 && response.body) {
      void this.pump(response.body);
    } else {
      await response.body?.cancel();
      this.ended = true;
    }
    return this;
  }

  private async pump(body: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of body) {
        this.buffer += decoder.decode(chunk, { stream: true });
        let cut = this.buffer.indexOf("\n\n");
        while (cut >= 0) {
          for (const line of this.buffer.slice(0, cut).split("\n")) {
            if (line.startsWith("data:")) {
              this.events.push(JSON.parse(line.slice(5)) as { seq: number });
            } else if (line.startsWith(":")) {
              this.comments.push(line);
            }
          }
          this.buffer = this.buffer.slice(cut + 2);
          cut = this.buffer.indexOf("\n\n");
        }
      }
    } catch {
      // An aborted or server-ended stream reads the same to a waiter.
    }
    this.ended = true;
  }

  async next(timeoutMs = 3000): Promise<{ seq: number }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const event = this.events.shift();
      if (event) {
        return event;
      }
      await pause(10);
    }
    throw new Error("no event arrived");
  }

  /** Reads until a sequence past the mark arrives. A stale re-announcement
   * is allowed (it costs one empty pull), so assertions wait for the value,
   * never the position. */
  async nextAbove(mark: number, timeoutMs = 3000): Promise<{ seq: number }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const event = this.events.shift();
      if (event && event.seq > mark) {
        return event;
      }
      if (!event) {
        await pause(10);
      }
    }
    throw new Error(`no event above ${mark} arrived`);
  }

  /** Asserts silence: nothing new within the window, after any flush armed
   * before the stream opened has landed. */
  async none(windowMs = 400): Promise<void> {
    await pause(250);
    this.events.length = 0;
    await pause(windowMs);
    expect(this.events).toHaveLength(0);
  }

  /** Lets pending flushes land, then forgets everything received so far. */
  async settle(): Promise<void> {
    await pause(250);
    this.events.length = 0;
  }

  /** Every poke received since the last settle or read. */
  async drain(windowMs = 400): Promise<Array<{ seq: number }>> {
    await pause(windowMs);
    return this.events.splice(0);
  }

  async heartbeat(timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.comments.length > 0) {
        return;
      }
      await pause(10);
    }
    throw new Error("no heartbeat arrived");
  }

  async closedByServer(timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.ended) {
        return;
      }
      await pause(10);
    }
    throw new Error("stream still open");
  }

  close(): void {
    this.controller.abort();
  }
}
