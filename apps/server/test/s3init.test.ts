import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { S3BlobStore } from "../src/s3.js";

/**
 * In the sidecar topology the object store is a container that starts
 * beside the server, and nothing guarantees it binds its port first.
 * init() must therefore treat "endpoint not reachable" as "not yet",
 * retrying briefly, while an actual HTTP answer (403, 404) still acts
 * immediately. Without this the first boot of a compose stack is a coin
 * flip.
 */
describe("s3 init against a late endpoint", () => {
  let server: Server | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it("waits out a backend that binds its port late", async () => {
    const port = 39_431;
    const store = new S3BlobStore({
      endpoint: `http://127.0.0.1:${port}`,
      region: "us-east-1",
      bucket: "blobs",
      accessKeyId: "k",
      secretAccessKey: "s",
      forcePathStyle: true,
      createBucket: false,
    });
    setTimeout(() => {
      server = createServer((_req, res) => {
        res.statusCode = 200;
        res.end();
      });
      server.listen(port, "127.0.0.1");
    }, 1200);
    await expect(store.init()).resolves.toBeUndefined();
  }, 15_000);

  it("still fails promptly when the endpoint answers that the bucket is missing", async () => {
    const port = 39_432;
    server = createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    server.listen(port, "127.0.0.1");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const store = new S3BlobStore({
      endpoint: `http://127.0.0.1:${port}`,
      region: "us-east-1",
      bucket: "blobs",
      accessKeyId: "k",
      secretAccessKey: "s",
      forcePathStyle: true,
      createBucket: false,
    });
    const started = Date.now();
    await expect(store.init()).rejects.toThrow(/blobs/);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);
});
