import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ready, generateAccountKeys } from "@engramer/crypto";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { totpAt } from "../src/totp.js";

/** Regression cover for the hardening a public deployment depends on. */
describe("public-exposure hardening", () => {
  let app: FastifyInstance;
  let dataDir: string;

  beforeAll(async () => {
    await ready();
    dataDir = mkdtempSync(join(tmpdir(), "engramer-harden-"));
    app = await buildApp({ dataDir, webDistDir: null });
    const keys = generateAccountKeys("a hardening password");
    await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "known@example.com", loginKey: keys.loginKey, keyAttributes: keys.keyAttributes },
    });
  });

  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("sets a restrictive content security policy and companion headers", async () => {
    const response = await app.inject({ method: "GET", url: "/api/health" });
    const csp = response.headers["content-security-policy"] as string;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    // The OCR engine needs wasm; nothing else may be evaluated.
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).not.toContain(" 'unsafe-eval'"); // wasm only, never bare eval
    // No external origin is reachable, so a bad dependency cannot exfiltrate.
    expect(csp).toContain("connect-src 'self'");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["cross-origin-opener-policy"]).toBe("same-origin");
  });

  it("names every origin the editor can be reached on in its own policy", async () => {
    // The editor runs in an opaque origin, so its policy cannot say 'self'
    // and has to name the origin its assets come from. Behind a proxy that
    // rewrites Host, the server sees an internal name and would name only
    // that one, refusing every asset the editor loads.
    process.env.ENGRAMER_PUBLIC_ORIGINS = "https://store.example.com, not-an-origin, https://alt.example.com/";
    const dir = mkdtempSync(join(tmpdir(), "engramer-office-"));
    const proxied = await buildApp({ dataDir: dir, webDistDir: null });
    try {
      const response = await proxied.inject({
        method: "GET",
        url: "/office/anything.js",
        headers: { host: "internal.cluster.local" },
      });
      const csp = response.headers["content-security-policy"] as string;
      expect(csp).toContain("https://internal.cluster.local");
      expect(csp).toContain("https://store.example.com");
      expect(csp).toContain("https://alt.example.com");
      // A malformed entry must never reach a security header verbatim.
      expect(csp).not.toContain("not-an-origin");
      expect(csp).toContain("frame-ancestors 'self'");
    } finally {
      await proxied.close();
      rmSync(dir, { recursive: true, force: true });
      delete process.env.ENGRAMER_PUBLIC_ORIGINS;
    }
  });

  it("does not reveal which emails have accounts", async () => {
    const known = await app.inject({ method: "GET", url: "/api/auth/attributes?email=known@example.com" });
    const unknown = await app.inject({ method: "GET", url: "/api/auth/attributes?email=nobody@example.com" });
    expect(known.statusCode).toBe(unknown.statusCode);
    const knownKdf = known.json().kdf as { salt: string; opsLimit: number; memLimit: number };
    const unknownKdf = unknown.json().kdf as { salt: string; opsLimit: number; memLimit: number };
    // Same shape and parameters; only the salt differs, as it would between
    // two real accounts.
    expect(Object.keys(unknownKdf).sort()).toEqual(Object.keys(knownKdf).sort());
    expect(unknownKdf.opsLimit).toBe(knownKdf.opsLimit);
    expect(unknownKdf.memLimit).toBe(knownKdf.memLimit);
    expect(unknownKdf.salt).not.toBe(knownKdf.salt);
    // Stable across calls, so repeated probing cannot distinguish either.
    const again = await app.inject({ method: "GET", url: "/api/auth/attributes?email=nobody@example.com" });
    expect((again.json().kdf as { salt: string }).salt).toBe(unknownKdf.salt);
  });

  it("refuses to enrol two-factor over an already-enabled account", async () => {
    const keys = generateAccountKeys("a two factor password");
    const registered = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "tfa@example.com", loginKey: keys.loginKey, keyAttributes: keys.keyAttributes },
    });
    const auth = { authorization: `Bearer ${registered.json().token as string}` };
    const setup = await app.inject({ method: "POST", url: "/api/auth/totp/setup", headers: auth, payload: {} });
    const secret = setup.json().secret as string;
    await app.inject({
      method: "POST",
      url: "/api/auth/totp/confirm",
      headers: auth,
      payload: { code: totpAt(secret, Date.now()) },
    });
    // A session token alone must not be able to strip the second factor.
    const again = await app.inject({ method: "POST", url: "/api/auth/totp/setup", headers: auth, payload: {} });
    expect(again.statusCode).toBe(409);
    const me = await app.inject({ method: "GET", url: "/api/user", headers: auth });
    expect(me.json().totpEnabled).toBe(true);
  });

  it("rejects accounts created with weak password-hashing parameters", async () => {
    const keys = generateAccountKeys("a weak kdf password");
    const weak = {
      ...keys.keyAttributes,
      kdf: { ...keys.keyAttributes.kdf, opsLimit: 1, memLimit: 8192 },
    };
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "weak@example.com", loginKey: keys.loginKey, keyAttributes: weak },
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects malformed key material without a server error", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "known@example.com", loginKey: "***not base64***" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("keeps validation errors opaque", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "not-an-email" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid request" });
  });

  it("refuses cross-origin browser access by default", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { origin: "https://evil.example" },
    });
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("trusted proxy attribution", () => {
  let dataDir: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), "engramer-proxies-"));
  });

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  const trustFor = (value: string | undefined) => {
    if (value === undefined) {
      delete process.env.ENGRAMER_TRUSTED_PROXIES;
    } else {
      process.env.ENGRAMER_TRUSTED_PROXIES = value;
    }
    try {
      return loadConfig({ dataDir }).trustedProxies;
    } finally {
      delete process.env.ENGRAMER_TRUSTED_PROXIES;
    }
  };

  it("ignores forwarded headers unless trust is declared", () => {
    expect(trustFor(undefined)).toBe(false);
    expect(trustFor("")).toBe(false);
    expect(trustFor("0")).toBe(false);
  });

  it("accepts a hop count", () => {
    expect(trustFor("2")).toBe(2);
  });

  it("accepts an allowlist of addresses and ranges", () => {
    const proxies = "10.0.0.0/8,172.16.0.0/12,127.0.0.1";
    expect(trustFor(proxies)).toBe(proxies);
  });
});

/**
 * A page served over plain HTTP must not be told to upgrade its own
 * requests: there is nothing to upgrade to, and the browser applies the
 * rule to WebSockets too, turning ws:// into wss:// against a server with
 * no TLS. That silently killed live collaboration for every deployment
 * without HTTPS. Behind a TLS-terminating proxy the directive stays.
 */
describe("insecure-request upgrading follows the actual scheme", () => {
  let app: FastifyInstance;
  let dataDir: string;

  const priorProxies = process.env.ENGRAMER_TRUSTED_PROXIES;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "engramer-scheme-test-"));
    // A TLS-terminating proxy is the shape this has to work behind.
    process.env.ENGRAMER_TRUSTED_PROXIES = "127.0.0.1";
    app = await buildApp({ dataDir, webDistDir: null });
  });

  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
    if (priorProxies === undefined) {
      delete process.env.ENGRAMER_TRUSTED_PROXIES;
    } else {
      process.env.ENGRAMER_TRUSTED_PROXIES = priorProxies;
    }
  });

  it("omits the upgrade directive on a plain HTTP request", async () => {
    const response = await app.inject({ method: "GET", url: "/api/health" });
    const csp = response.headers["content-security-policy"] as string;
    expect(csp).not.toContain("upgrade-insecure-requests");
    // The channel still has to be reachable on the scheme actually in use.
    expect(csp).toContain("ws://");
  });

  it("keeps the upgrade directive when a trusted proxy reports https", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { "x-forwarded-proto": "https" },
      remoteAddress: "127.0.0.1",
    });
    const csp = response.headers["content-security-policy"] as string;
    expect(csp).toContain("upgrade-insecure-requests");
    expect(csp).toContain("wss://");
  });
});
