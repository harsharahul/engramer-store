import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies AWS Signature Version 4 on an incoming request, the way an S3 server
 * must. SigV4 is a symmetric HMAC construction, so verification means
 * recomputing the client's signature with the same secret and comparing. We
 * canonicalize from the raw request line (the exact path and query bytes the
 * client signed), which sidesteps every percent-encoding disagreement.
 *
 * The read path only needs GET and HEAD, so streaming chunked upload signatures
 * are out of scope here; header-based and presigned-URL signatures are covered.
 */

const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");
const CLOCK_SKEW_MS = 15 * 60 * 1000;

export type Verdict =
  | { ok: true; accessKeyId: string }
  | { ok: false; code: string; message: string };

export interface VerifyInput {
  method: string;
  /** The raw request target as received: path plus optional `?query`. */
  rawUrl: string;
  headers: Record<string, string | string[] | undefined>;
  /** Returns the secret for an access key id, or null if unknown. */
  lookupSecret: (accessKeyId: string) => string | null;
  now?: number;
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function signingKey(secret: string, date: string, region: string, service: string): Buffer {
  const dateKey = hmac(`AWS4${secret}`, date);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, service);
  return hmac(serviceKey, "aws4_request");
}

function header(headers: VerifyInput["headers"], name: string): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** Splits the raw target into path and the raw query string (undecoded). */
function splitTarget(rawUrl: string): { path: string; query: string } {
  const q = rawUrl.indexOf("?");
  return q === -1
    ? { path: rawUrl, query: "" }
    : { path: rawUrl.slice(0, q), query: rawUrl.slice(q + 1) };
}

/**
 * Canonical query string from the raw query: keep the client's own encoding,
 * sort by name then value, and optionally drop one parameter (the signature
 * itself, for presigned URLs).
 */
function canonicalQuery(rawQuery: string, exclude?: string): string {
  if (!rawQuery) {
    return "";
  }
  const pairs = rawQuery
    .split("&")
    .filter(Boolean)
    .map((p): [string, string] => {
      const eq = p.indexOf("=");
      return eq === -1 ? [p, ""] : [p.slice(0, eq), p.slice(eq + 1)];
    })
    .filter(([name]) => name !== exclude);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

function canonicalHeaders(
  headers: VerifyInput["headers"],
  signedHeaders: string[],
): string {
  return (
    signedHeaders
      .map((name) => `${name}:${(header(headers, name) ?? "").trim().replace(/\s+/g, " ")}`)
      .join("\n") + "\n"
  );
}

function parseAmzDate(amzDate: string): number | null {
  // Format: 20260723T060102Z
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(amzDate);
  if (!m) {
    return null;
  }
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
}

interface Parsed {
  accessKeyId: string;
  date: string;
  region: string;
  service: string;
  signedHeaders: string[];
  signature: string;
  amzDate: string;
  hashedPayload: string;
  excludeQueryParam?: string;
  expiresSeconds?: number;
}

function parseHeaderAuth(input: VerifyInput): Parsed | null {
  const auth = header(input.headers, "authorization");
  if (!auth || !auth.startsWith("AWS4-HMAC-SHA256 ")) {
    return null;
  }
  const parts = Object.fromEntries(
    auth
      .slice("AWS4-HMAC-SHA256 ".length)
      .split(",")
      .map((s) => s.trim())
      .map((s) => {
        const eq = s.indexOf("=");
        return [s.slice(0, eq), s.slice(eq + 1)];
      }),
  );
  const credential = parts["Credential"];
  const signedHeaders = parts["SignedHeaders"];
  const signature = parts["Signature"];
  if (!credential || !signedHeaders || !signature) {
    return null;
  }
  const [accessKeyId, date, region, service] = credential.split("/");
  const amzDate = header(input.headers, "x-amz-date");
  if (!accessKeyId || !date || !region || !service || !amzDate) {
    return null;
  }
  return {
    accessKeyId,
    date,
    region,
    service,
    signedHeaders: signedHeaders.split(";"),
    signature,
    amzDate,
    hashedPayload: header(input.headers, "x-amz-content-sha256") ?? EMPTY_SHA256,
  };
}

function parsePresigned(input: VerifyInput): Parsed | null {
  const { query } = splitTarget(input.rawUrl);
  if (!query) {
    return null;
  }
  const params = new URLSearchParams(query);
  if (params.get("X-Amz-Algorithm") !== "AWS4-HMAC-SHA256") {
    return null;
  }
  const credential = params.get("X-Amz-Credential");
  const signedHeaders = params.get("X-Amz-SignedHeaders");
  const signature = params.get("X-Amz-Signature");
  const amzDate = params.get("X-Amz-Date");
  if (!credential || !signedHeaders || !signature || !amzDate) {
    return null;
  }
  const [accessKeyId, date, region, service] = credential.split("/");
  if (!accessKeyId || !date || !region || !service) {
    return null;
  }
  return {
    accessKeyId,
    date,
    region,
    service,
    signedHeaders: signedHeaders.split(";"),
    signature,
    amzDate,
    hashedPayload: "UNSIGNED-PAYLOAD",
    excludeQueryParam: "X-Amz-Signature",
    expiresSeconds: Number(params.get("X-Amz-Expires") ?? "0"),
  };
}

export function verifySigV4(input: VerifyInput): Verdict {
  const parsed = parseHeaderAuth(input) ?? parsePresigned(input);
  if (!parsed) {
    return { ok: false, code: "AccessDenied", message: "missing or malformed signature" };
  }

  const now = input.now ?? Date.now();
  const signedAt = parseAmzDate(parsed.amzDate);
  if (signedAt === null) {
    return { ok: false, code: "AccessDenied", message: "invalid X-Amz-Date" };
  }
  if (parsed.expiresSeconds !== undefined) {
    if (now > signedAt + parsed.expiresSeconds * 1000) {
      return { ok: false, code: "AccessDenied", message: "presigned URL expired" };
    }
  } else if (Math.abs(now - signedAt) > CLOCK_SKEW_MS) {
    return { ok: false, code: "RequestTimeTooSkewed", message: "request time too skewed" };
  }

  const secret = input.lookupSecret(parsed.accessKeyId);
  if (!secret) {
    return { ok: false, code: "InvalidAccessKeyId", message: "unknown access key" };
  }

  const { path, query } = splitTarget(input.rawUrl);
  const canonicalRequest = [
    input.method.toUpperCase(),
    path,
    canonicalQuery(query, parsed.excludeQueryParam),
    canonicalHeaders(input.headers, parsed.signedHeaders),
    parsed.signedHeaders.join(";"),
    parsed.hashedPayload,
  ].join("\n");

  const scope = `${parsed.date}/${parsed.region}/${parsed.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    parsed.amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const expected = hmac(
    signingKey(secret, parsed.date, parsed.region, parsed.service),
    stringToSign,
  ).toString("hex");

  const a = Buffer.from(expected);
  const b = Buffer.from(parsed.signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, code: "SignatureDoesNotMatch", message: "signature mismatch" };
  }
  return { ok: true, accessKeyId: parsed.accessKeyId };
}
