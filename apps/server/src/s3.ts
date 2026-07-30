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
import { byteLimiter, type BlobRange, type BlobStore, type PartReceipt } from "./blobs.js";
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
    });
    // Budget lives at the client so every HTTP attempt pays it, multipart
    // parts and SDK retries included; see budget.ts.
    attachBudget(this.client, {
      maxTps: config.maxTps,
      maxConcurrent: config.maxConcurrent,
    });
  }

  /** Creates the bucket on first run so self-hosting stays one-command. */
  async init(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.config.bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.config.bucket }));
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
    return result.Body as Readable;
  }

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
