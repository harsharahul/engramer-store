/** Minimal S3 XML serialization for the read path. */

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface BucketXml {
  name: string;
  creationDate: string;
}

export function listBucketsXml(buckets: BucketXml[]): string {
  const items = buckets
    .map((b) => `<Bucket><Name>${esc(b.name)}</Name><CreationDate>${b.creationDate}</CreationDate></Bucket>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Owner><ID>engram</ID><DisplayName>engram</DisplayName></Owner><Buckets>${items}</Buckets></ListAllMyBucketsResult>`;
}

export interface ObjectXml {
  key: string;
  lastModified: string;
  etag: string;
  size: number;
}

export interface ListObjectsResult {
  bucket: string;
  prefix: string;
  delimiter: string;
  keyCount: number;
  maxKeys: number;
  isTruncated: boolean;
  continuationToken?: string;
  nextContinuationToken?: string;
  contents: ObjectXml[];
  commonPrefixes: string[];
}

export function listObjectsXml(r: ListObjectsResult): string {
  const contents = r.contents
    .map(
      (o) =>
        `<Contents><Key>${esc(o.key)}</Key><LastModified>${o.lastModified}</LastModified><ETag>&quot;${o.etag}&quot;</ETag><Size>${o.size}</Size><StorageClass>STANDARD</StorageClass></Contents>`,
    )
    .join("");
  const prefixes = r.commonPrefixes
    .map((p) => `<CommonPrefixes><Prefix>${esc(p)}</Prefix></CommonPrefixes>`)
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
    `<Name>${esc(r.bucket)}</Name><Prefix>${esc(r.prefix)}</Prefix>` +
    (r.delimiter ? `<Delimiter>${esc(r.delimiter)}</Delimiter>` : "") +
    `<KeyCount>${r.keyCount}</KeyCount><MaxKeys>${r.maxKeys}</MaxKeys><IsTruncated>${r.isTruncated}</IsTruncated>` +
    (r.continuationToken ? `<ContinuationToken>${esc(r.continuationToken)}</ContinuationToken>` : "") +
    (r.nextContinuationToken ? `<NextContinuationToken>${esc(r.nextContinuationToken)}</NextContinuationToken>` : "") +
    contents +
    prefixes +
    `</ListBucketResult>`
  );
}

export function errorXml(code: string, message: string, resource: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${esc(code)}</Code><Message>${esc(message)}</Message><Resource>${esc(resource)}</Resource></Error>`;
}
