import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { verifySigV4 } from "./sigv4.js";
import { Vault, fileEtag, type VaultFile } from "./vault.js";
import {
  ROOT_BUCKET,
  bucketExists,
  bucketNames,
  listObjects,
  resolveObject,
} from "./s3model.js";
import { errorXml, listBucketsXml, listObjectsXml } from "./xml.js";
import { CREATION_DATE } from "./s3model.js";

export interface BridgeCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * The local S3 bridge server. It runs inside the user's trust boundary, holds
 * the vault's keys in memory, verifies S3 requests with a locally generated
 * credential, and answers ListBuckets, ListObjectsV2, HeadObject, and ranged
 * GetObject by decrypting on the fly. The Engram Store server still sees only
 * ciphertext.
 */
export function buildBridge(vault: Vault, creds: BridgeCredentials): FastifyInstance {
  const app = Fastify({ logger: false, exposeHeadRoutes: false });

  const sendError = (reply: FastifyReply, status: number, code: string, message: string, resource: string) =>
    reply.code(status).type("application/xml").send(errorXml(code, message, resource));

  // Every request must carry a valid SigV4 signature for our local credential.
  app.addHook("onRequest", async (request, reply) => {
    const verdict = verifySigV4({
      method: request.method,
      rawUrl: request.raw.url ?? "/",
      headers: request.headers,
      lookupSecret: (id) => (id === creds.accessKeyId ? creds.secretAccessKey : null),
    });
    if (!verdict.ok) {
      const status = verdict.code === "SignatureDoesNotMatch" || verdict.code === "InvalidAccessKeyId" ? 403 : 400;
      return sendError(reply, status, verdict.code, verdict.message, request.url.split("?")[0] ?? "/");
    }
  });

  // GET / -> ListBuckets
  app.get("/", async (_request, reply) => {
    const buckets = bucketNames(vault).map((name) => ({ name, creationDate: CREATION_DATE }));
    return reply.type("application/xml").send(listBucketsXml(buckets));
  });

  // ListObjectsV2 (list-type=2). Clients address a bucket as `/bucket` or,
  // with a trailing slash, `/bucket/`.
  const respondList = (bucket: string, query: Record<string, string>, reply: FastifyReply) => {
    if (!bucketExists(vault, bucket)) {
      return sendError(reply, 404, "NoSuchBucket", "no such bucket", `/${bucket}`);
    }
    const result = listObjects(vault, bucket, {
      prefix: query["prefix"] ?? "",
      delimiter: query["delimiter"] ?? "",
      continuationToken: query["continuation-token"],
      maxKeys: Math.min(Number(query["max-keys"] ?? 1000) || 1000, 1000),
    });
    return reply.type("application/xml").send(listObjectsXml(result));
  };

  app.get<{ Params: { bucket: string }; Querystring: Record<string, string> }>(
    "/:bucket",
    async (request, reply) => respondList(request.params.bucket, request.query, reply),
  );

  app.head<{ Params: { bucket: string } }>("/:bucket", async (request, reply) => {
    return bucketExists(vault, request.params.bucket)
      ? reply.code(200).send()
      : reply.code(404).send();
  });

  const findObject = (bucket: string, wildcard: string): VaultFile | null =>
    bucketExists(vault, bucket) ? resolveObject(vault, bucket, wildcard) : null;

  const setObjectHeaders = (reply: FastifyReply, file: VaultFile) => {
    reply.header("etag", `"${fileEtag(file)}"`);
    reply.header("last-modified", new Date(file.mtime).toUTCString());
    reply.header("content-type", file.mime || "application/octet-stream");
    reply.header("accept-ranges", "bytes");
  };

  app.head<{ Params: { bucket: string; "*": string } }>("/:bucket/*", async (request, reply) => {
    if (request.params["*"] === "") {
      return bucketExists(vault, request.params.bucket) ? reply.code(200).send() : reply.code(404).send();
    }
    const file = findObject(request.params.bucket, request.params["*"]);
    if (!file) {
      return reply.code(404).send();
    }
    setObjectHeaders(reply, file);
    return reply.header("content-length", file.size).code(200).send();
  });

  // GET /:bucket/key -> decrypt and stream, honoring a single Range. An empty
  // key (a trailing slash on the bucket) is a bucket listing.
  app.get<{ Params: { bucket: string; "*": string }; Querystring: Record<string, string> }>(
    "/:bucket/*",
    async (request, reply) => {
    const { bucket } = request.params;
    const key = request.params["*"];
    if (key === "") {
      return respondList(bucket, request.query, reply);
    }
    const file = findObject(bucket, key);
    if (!file) {
      return sendError(reply, 404, "NoSuchKey", "no such key", `/${bucket}/${key}`);
    }
    const plaintext = await vault.read(file);
    setObjectHeaders(reply, file);

    const range = parseRange(request.headers["range"], plaintext.length);
    if (range === "invalid") {
      return reply.code(416).header("content-range", `bytes */${plaintext.length}`).send();
    }
    if (range) {
      const slice = plaintext.subarray(range.start, range.end + 1);
      return reply
        .code(206)
        .header("content-range", `bytes ${range.start}-${range.end}/${plaintext.length}`)
        .header("content-length", slice.length)
        .send(Buffer.from(slice));
    }
    return reply.header("content-length", plaintext.length).send(Buffer.from(plaintext));
  });

  app.setNotFoundHandler((request, reply) =>
    sendError(reply, 404, "NoSuchKey", "not found", request.url.split("?")[0] ?? "/"),
  );

  return app;
}

/** Parses a single-range `bytes=start-end` header against a known length. */
function parseRange(
  header: string | string[] | undefined,
  length: number,
): { start: number; end: number } | null | "invalid" {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) {
    return null;
  }
  const m = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!m) {
    return "invalid";
  }
  const [, s, e] = m;
  let start: number;
  let end: number;
  if (s === "" && e === "") {
    return "invalid";
  }
  if (s === "") {
    // Suffix range: last N bytes.
    const n = Number(e);
    start = Math.max(0, length - n);
    end = length - 1;
  } else {
    start = Number(s);
    end = e === "" ? length - 1 : Math.min(Number(e), length - 1);
  }
  if (start > end || start >= length) {
    return "invalid";
  }
  return { start, end };
}

declare module "fastify" {
  interface FastifyRequest {
    _bridge?: never;
  }
}

export type { FastifyRequest };
