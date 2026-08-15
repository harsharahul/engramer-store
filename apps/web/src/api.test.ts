import { describe, expect, it, vi } from "vitest";
import { api } from "./api";

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
