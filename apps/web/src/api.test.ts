import { describe, expect, it, vi } from "vitest";
import { api, ApiError, setAuthToken, setUnauthorizedHandler, withRetry } from "./api";

/**
 * A phone on a failing radio produces connections that neither complete
 * nor error: the request simply hangs. Every sweep awaits a download, so
 * one hung fetch used to wedge the whole pass, the progress pill froze,
 * and the next app open started the same pass over. A download must give
 * up on its own.
 */
describe("downloadBlobDetailed under a stalled connection", () => {
  it("gives up rather than hanging forever, and aborts the request", async () => {
    let aborted = false;
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(api.downloadBlobDetailed("f1", "data", { timeoutMs: 30 })).rejects.toThrow();
      expect(aborted).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("passes a healthy download straight through", async () => {
    const body = new Uint8Array([1, 2, 3]);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(body, { status: 200, headers: { "x-generation": "7" } }),
      ),
    );
    try {
      const result = await api.downloadBlobDetailed("f1", "data", { timeoutMs: 5_000 });
      expect(result.bytes).toEqual(body);
      expect(result.generation).toBe(7);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

/**
 * The seekable flag tells the server which uploads are in the
 * random-access ciphertext format, so it spends eager tier work (hot
 * bookends, window warming) only where a ranged read can follow. It is a
 * hint about the ciphertext container: the client never reads it back,
 * and decryption identifies the format from the blob header alone.
 */
describe("createFile seekable hint", () => {
  const sealed = { ciphertext: "x", nonce: "y" };

  function captureBody(): { calls: Array<Record<string, unknown>> } {
    const seen: { calls: Array<Record<string, unknown>> } = { calls: [] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        seen.calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ id: "f1" }), { status: 201 });
      }),
    );
    return seen;
  }

  it("sends the flag for seekable content", async () => {
    const seen = captureBody();
    try {
      await api.createFile(null, sealed, sealed, true);
      expect(seen.calls[0]?.seekable).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("omits the flag entirely for ordinary content", async () => {
    const seen = captureBody();
    try {
      await api.createFile(null, sealed, sealed);
      expect(seen.calls[0]).not.toHaveProperty("seekable");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("the sign-out verdict belongs to the token that earned it", () => {
  it("a 401 for a superseded token does not sign out the new session", async () => {
    const signOuts = vi.fn();
    setUnauthorizedHandler(signOuts);
    let release: (() => void) | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = () =>
              resolve(new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }));
          }),
      ),
    );
    try {
      setAuthToken("stale-token");
      const inFlight = api.getSettings().catch(() => {});
      // A new login lands while the old request is still on the wire.
      setAuthToken("fresh-token");
      release!();
      await inFlight;
      expect(signOuts).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      setAuthToken(null);
      setUnauthorizedHandler(() => {});
    }
  });

  it("a 401 for the current token still signs out", async () => {
    const signOuts = vi.fn();
    setUnauthorizedHandler(signOuts);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })),
    );
    try {
      setAuthToken("current-token");
      await api.getSettings().catch(() => {});
      expect(signOuts).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      setAuthToken(null);
      setUnauthorizedHandler(() => {});
    }
  });

  it("quiet calls never reach the sign-out handler", async () => {
    const signOuts = vi.fn();
    setUnauthorizedHandler(signOuts);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })),
    );
    try {
      setAuthToken("current-token");
      await api.getSessionKey("skid").catch(() => {});
      expect(signOuts).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      setAuthToken(null);
      setUnauthorizedHandler(() => {});
    }
  });
});

describe("retry-after reaches the caller", () => {
  it("lands on the error in milliseconds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "too many attempts" }), {
            status: 429,
            headers: { "retry-after": "7" },
          }),
      ),
    );
    try {
      await api.registration();
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(429);
      expect((err as ApiError).retryAfterMs).toBe(7000);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("withRetry honors it but never sleeps past the clamp", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const run = async () => {
      calls++;
      if (calls === 1) {
        // A proxy-stamped hours-long header must not stall the loop.
        throw new ApiError(429, "too many attempts", 3_600_000);
      }
      return "done";
    };
    try {
      const outcome = withRetry(run);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await outcome).toBe("done");
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Warming the search index asks for many index blobs at once. The answer is
 * a run of frames; reading one wrong would hand a file another file's
 * ciphertext, which then fails to decrypt and silently leaves it unsearchable.
 */
describe("downloadIndexBatch", () => {
  const frame = (id: string, blob: Uint8Array) => {
    const idBytes = new TextEncoder().encode(id);
    const out = new Uint8Array(8 + idBytes.length + blob.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, idBytes.length);
    out.set(idBytes, 4);
    view.setUint32(4 + idBytes.length, blob.length);
    out.set(blob, 8 + idBytes.length);
    return out;
  };

  it("reads each frame's blob under its own id", async () => {
    const a = frame("a1", new Uint8Array([1, 2, 3]));
    const b = frame("b2", new Uint8Array([9]));
    const body = new Uint8Array(a.length + b.length);
    body.set(a);
    body.set(b, a.length);
    const fetchMock = vi.fn(async () => new Response(body, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const blobs = await api.downloadIndexBatch(["a1", "b2", "c3"]);
      expect([...blobs.keys()]).toEqual(["a1", "b2"]);
      expect([...blobs.get("a1")!]).toEqual([1, 2, 3]);
      expect([...blobs.get("b2")!]).toEqual([9]);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("/api/files/index/batch");
      expect(JSON.parse(String(init.body))).toEqual({ ids: ["a1", "b2", "c3"] });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("names the status when the server refuses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
    try {
      await expect(api.downloadIndexBatch(["a1"])).rejects.toMatchObject({ status: 404 });
      await expect(api.downloadIndexBatch(["a1"])).rejects.toBeInstanceOf(ApiError);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
