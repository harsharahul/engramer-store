import { describe, expect, it } from "vitest";
import aws4, { type SignRequest } from "aws4";
import { verifySigV4 } from "../src/sigv4.js";

const CREDS = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
const lookup = (id: string) => (id === CREDS.accessKeyId ? CREDS.secretAccessKey : null);

/** Signs a request with aws4, then feeds it to our verifier the way Fastify would. */
function sign(method: string, path: string) {
  const opts: SignRequest = {
    host: "127.0.0.1:3081",
    method,
    path,
    service: "s3",
    region: "us-east-1",
  };
  aws4.sign(opts, CREDS);
  // Node/Fastify delivers header names lowercased; mirror that here.
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    headers[k.toLowerCase()] = v;
  }
  return { method, rawUrl: path, headers, lookupSecret: lookup };
}

describe("verifySigV4", () => {
  it("accepts a correctly signed GET", () => {
    const verdict = verifySigV4(sign("GET", "/Documents?list-type=2&prefix=&delimiter=%2F"));
    expect(verdict).toEqual({ ok: true, accessKeyId: CREDS.accessKeyId });
  });

  it("accepts a signed object GET with an encoded key", () => {
    const verdict = verifySigV4(sign("GET", "/Documents/quarterly%20report.pdf"));
    expect(verdict.ok).toBe(true);
  });

  it("rejects a tampered path", () => {
    const input = sign("GET", "/Documents?list-type=2");
    input.rawUrl = "/Secrets?list-type=2";
    const verdict = verifySigV4(input);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.code).toBe("SignatureDoesNotMatch");
    }
  });

  it("rejects a wrong secret", () => {
    const input = sign("GET", "/Documents");
    input.lookupSecret = () => "not-the-secret";
    expect(verifySigV4(input).ok).toBe(false);
  });

  it("rejects an unknown access key", () => {
    const input = sign("GET", "/Documents");
    input.lookupSecret = () => null;
    const verdict = verifySigV4(input);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.code).toBe("InvalidAccessKeyId");
    }
  });

  it("rejects a request with no signature", () => {
    const verdict = verifySigV4({
      method: "GET",
      rawUrl: "/Documents",
      headers: { host: "127.0.0.1:3081" },
      lookupSecret: lookup,
    });
    expect(verdict.ok).toBe(false);
  });

  it("rejects a skewed clock", () => {
    const input = sign("GET", "/Documents");
    const verdict = verifySigV4({ ...input, now: Date.now() + 60 * 60 * 1000 });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.code).toBe("RequestTimeTooSkewed");
    }
  });
});
