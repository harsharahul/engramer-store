import type { Readable } from "node:stream";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { byteLimiter, type BlobStore } from "./blobs.js";

export interface S3Config {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
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

  async get(key: string): Promise<Readable> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
    return result.Body as Readable;
  }

  async remove(key: string): Promise<void> {
    await this.client
      .send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }))
      .catch(() => {});
  }
}
