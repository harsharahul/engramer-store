import type { Readable } from "node:stream";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import {
  byteLimiter,
  sliceRange,
  type BlobRange,
  type BlobStore,
  type PartReceipt,
} from "./blobs.js";
import { attachBudget } from "./budget.js";

export interface S3Config {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  /** Optional request budget; 0 or absent means unlimited. */
  maxTps?: number;
  maxConcurrent?: number;
  /** SDK checksum posture; "when-required" keeps streaming bodies plain
   * for third-party servers that refuse aws-chunked framing. */
  checksums?: "when-supported" | "when-required";
  /** Whether init() may create a missing bucket. */
  createBucket?: boolean;
}

/**
 * S3-compatible store for enterprise deployments: AWS S3, MinIO, Cloudflare
 * R2, Garage, Ceph RGW. Blobs are ciphertext before they arrive, so the
 * object store needs no trust; durability and replication are its job.
 */
export class S3BlobStore implements BlobStore {
  private readonly client: S3Client;

  constructor(private readonly config: S3Config) {
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      // "when-required" keeps a streaming body a plain sized body. The
      // default rewrites it into aws-chunked framing with checksum
      // trailers and drops Content-Length, which strict third-party
      // servers refuse with 411, failing every part upload.
      ...(config.checksums === "when-required"
        ? {
            requestChecksumCalculation: "WHEN_REQUIRED",
            responseChecksumValidation: "WHEN_REQUIRED",
          }
        : {}),
    });
    // Budget lives at the client so every HTTP attempt pays it, multipart
    // parts and SDK retries included; see budget.ts.
    attachBudget(this.client, {
      maxTps: config.maxTps,
      maxConcurrent: config.maxConcurrent,
    });
  }

  /** Creates the bucket on first run so self-hosting stays one-command.
   * Hosts that hand out a fixed bucket deny CreateBucket; there the
   * bucket must already exist, and a missing one is said plainly.
   *
   * An unreachable endpoint is retried briefly rather than failed: in the
   * sidecar topology the object store is a container starting beside this
   * one, and nothing guarantees it binds its port first. An error that
   * carries an HTTP status came from a live server and acts immediately. */
  async init(): Promise<void> {
    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        await this.client.send(new HeadBucketCommand({ Bucket: this.config.bucket }));
        return;
      } catch (err) {
        const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode;
        if (status === undefined && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }
        if (this.config.createBucket === false) {
          throw new Error(
            `bucket "${this.config.bucket}" is not reachable and ENGRAMER_S3_CREATE_BUCKET is off: ${(err as Error).message}`,
          );
        }
        await this.client.send(new CreateBucketCommand({ Bucket: this.config.bucket }));
        return;
      }
    }
  }

  async put(key: string, source: Readable, maxBytes: number): Promise<number> {
    const limiter = byteLimiter(maxBytes);
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.config.bucket,
        Key: key,
        Body: source.pipe(limiter.transform),
      },
    });
    try {
      await upload.done();
      return limiter.written();
    } catch (err) {
      await upload.abort().catch(() => {});
      throw err;
    }
  }

  async get(key: string, range?: BlobRange): Promise<Readable> {
    const result = await this.client.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
      }),
    );
    const body = result.Body as Readable;
    // A compliant partial answer names its window; an answer without one
    // ignored the Range and carries the whole object (some gateway-backed
    // deployments do). Serving that AS the range would hand every client
    // wrong bytes, silently; cut the window out of it instead.
    if (range && !result.ContentRange) {
      if (!this.warnedRangeBlind) {
        this.warnedRangeBlind = true;
        console.warn(
          "blob backend ignores Range requests; serving ranges by reading through the full object (correct, but slow for media playback)",
        );
      }
      return sliceRange(body, range.start, range.end - range.start + 1);
    }
    return body;
  }

  private warnedRangeBlind = false;

  async remove(key: string): Promise<void> {
    await this.client
      .send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }))
      .catch(() => {});
  }

  // Part sessions map straight onto S3 multipart uploads, so large blobs
  // stream through without ever touching the server's disk.

  async beginParts(key: string): Promise<string> {
    const result = await this.client.send(
      new CreateMultipartUploadCommand({ Bucket: this.config.bucket, Key: key }),
    );
    return result.UploadId!;
  }

  async putPart(
    key: string,
    handle: string,
    partNo: number,
    source: Readable,
    length: number,
  ): Promise<PartReceipt> {
    const limiter = byteLimiter(length);
    const result = await this.client.send(
      new UploadPartCommand({
        Bucket: this.config.bucket,
        Key: key,
        UploadId: handle,
        PartNumber: partNo,
        Body: source.pipe(limiter.transform),
        ContentLength: length,
      }),
    );
    return { bytes: limiter.written(), etag: result.ETag };
  }

  async completeParts(
    key: string,
    handle: string,
    parts: { partNo: number; etag?: string }[],
  ): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
        UploadId: handle,
        MultipartUpload: {
          Parts: [...parts]
            .sort((a, b) => a.partNo - b.partNo)
            .map((part) => ({ PartNumber: part.partNo, ETag: part.etag })),
        },
      }),
    );
  }

  async abortParts(key: string, handle: string): Promise<void> {
    await this.client
      .send(
        new AbortMultipartUploadCommand({ Bucket: this.config.bucket, Key: key, UploadId: handle }),
      )
      .catch(() => {});
  }
}
