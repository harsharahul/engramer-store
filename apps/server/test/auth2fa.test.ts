import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ready, generateAccountKeys, type AccountKeys } from "@engramer/crypto";
import { buildApp } from "../src/app.js";
import { base32Decode, base32Encode, totpAt, verifyTotp } from "../src/totp.js";
import { AuthThrottle } from "../src/ratelimit.js";

describe("totp primitives", () => {
  // RFC 6238 Appendix B vectors, SHA-1 mode: ASCII secret "12345678901234567890".
  const RFC_SECRET = base32Encode(new TextEncoder().encode("12345678901234567890"));
  const VECTORS: Array<[number, string]> = [
    [59_000, "94287082"],
    [1_111_111_109_000, "07081804"],
    [1_111_111_111_000, "14050471"],
    [1_234_567_890_000, "89005924"],
    [2_000_000_000_000, "69279037"],
  ];

  it("matches the RFC 6238 test vectors", () => {
    for (const [epochMs, expected] of VECTORS) {
      // The RFC lists 8-digit codes; ours are the standard 6 (the suffix).
      expect(totpAt(RFC_SECRET, epochMs)).toBe(expected.slice(-6));
    }
  });

  it("accepts one step of clock drift and nothing more", () => {
    const now = 1_111_111_111_000;
    const previous = totpAt(RFC_SECRET, now - 30_000);
    const ancient = totpAt(RFC_SECRET, now - 90_000);
    expect(verifyTotp(RFC_SECRET, previous, now).valid).toBe(true);
    expect(verifyTotp(RFC_SECRET, ancient, now).valid).toBe(false);
    expect(verifyTotp(RFC_SECRET, "000000", now).valid).toBe(false);
    expect(verifyTotp(RFC_SECRET, "not-a-code", now).valid).toBe(false);
  });

  it("round-trips base32", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255, 42]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
  });
});

describe("auth throttle", () => {
  it("blocks after repeated failures with growing delays and clears on success", () => {
    const throttle = new AuthThrottle();
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) {
      throttle.fail("k", t0);
      expect(throttle.check("k", t0).allowed).toBe(true);
    }
    throttle.fail("k", t0); // sixth failure starts blocking
    const first = throttle.check("k", t0);
    expect(first.allowed).toBe(false);
    throttle.fail("k", t0 + first.retryAfterMs);
    const second = throttle.check("k", t0 + first.retryAfterMs);
    expect(second.retryAfterMs).toBeGreaterThan(first.retryAfterMs);
    throttle.succeed("k");
    expect(throttle.check("k", t0).allowed).toBe(true);
  });
});

describe("two-factor login flow", () => {
  let app: FastifyInstance;
  let dataDir: string;
  let account: AccountKeys;
  let token: string;
  let secret: string;
  let recoveryCodes: string[] = [];
  let fakeNow = Date.now();

  const authHeader = () => ({ authorization: `Bearer ${token}` });
  const advance = (ms: number) => {
    fakeNow += ms;
  };

  beforeAll(async () => {
    vi.spyOn(Date, "now").mockImplementation(() => fakeNow);
    await ready();
    dataDir = mkdtempSync(join(tmpdir(), "engramer-2fa-test-"));
    app = await buildApp({ dataDir, webDistDir: null });
    account = generateAccountKeys("a second factor awaits");
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "totp@example.com",
        loginKey: account.loginKey,
        keyAttributes: account.keyAttributes,
      },
    });
    token = response.json().token as string;
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("enrolls: setup returns a provisioning URI, confirm returns recovery codes", async () => {
    const setup = await app.inject({
      method: "POST",
      url: "/api/auth/totp/setup",
      headers: authHeader(),
    });
    expect(setup.statusCode).toBe(200);
    secret = setup.json().secret as string;
    expect(setup.json().otpauthUri).toContain("otpauth://totp/");
    expect(setup.json().otpauthUri).toContain(secret);

    // A wrong code cannot enable it.
    const denied = await app.inject({
      method: "POST",
      url: "/api/auth/totp/confirm",
      headers: authHeader(),
      payload: { code: "000000" },
    });
    expect(denied.statusCode).toBe(401);

    const confirm = await app.inject({
      method: "POST",
      url: "/api/auth/totp/confirm",
      headers: authHeader(),
      payload: { code: totpAt(secret, fakeNow) },
    });
    expect(confirm.statusCode).toBe(200);
    recoveryCodes = confirm.json().recoveryCodes as string[];
    expect(recoveryCodes).toHaveLength(10);

    const user = await app.inject({ method: "GET", url: "/api/user", headers: authHeader() });
    expect(user.json().totpEnabled).toBe(true);
    expect(user.json().recoveryCodesLeft).toBe(10);
  });

  it("login becomes two-step and withholds key material until the code", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "totp@example.com", loginKey: account.loginKey },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().twoFactorRequired).toBe(true);
    expect(login.json().keyAttributes).toBeUndefined();
    expect(login.json().token).toBeUndefined();
    const pendingToken = login.json().pendingToken as string;

    // The pending token is not a session.
    const probe = await app.inject({
      method: "GET",
      url: "/api/user",
      headers: { authorization: `Bearer ${pendingToken}` },
    });
    expect(probe.statusCode).toBe(401);

    // Wrong code fails; the right code completes the login.
    const denied = await app.inject({
      method: "POST",
      url: "/api/auth/2fa",
      payload: { pendingToken, code: "123456" },
    });
    expect(denied.statusCode).toBe(401);

    advance(30_000); // a fresh step, beyond the one enrollment consumed
    const code = totpAt(secret, fakeNow);
    const done = await app.inject({
      method: "POST",
      url: "/api/auth/2fa",
      payload: { pendingToken, code },
    });
    expect(done.statusCode).toBe(200);
    expect(done.json().token).toBeTruthy();
    expect(done.json().keyAttributes).toBeTruthy();

    // Replay of the same code is refused even with a fresh pending token.
    const again = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "totp@example.com", loginKey: account.loginKey },
    });
    const replay = await app.inject({
      method: "POST",
      url: "/api/auth/2fa",
      payload: { pendingToken: again.json().pendingToken as string, code },
    });
    expect(replay.statusCode).toBe(401);
  });

  it("accepts a recovery code exactly once", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "totp@example.com", loginKey: account.loginKey },
    });
    const pendingToken = login.json().pendingToken as string;
    const code = recoveryCodes[0]!;

    const used = await app.inject({
      method: "POST",
      url: "/api/auth/2fa",
      payload: { pendingToken, code },
    });
    expect(used.statusCode).toBe(200);
    expect(used.json().recoveryCodesLeft).toBe(9);

    const again = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "totp@example.com", loginKey: account.loginKey },
    });
    const reused = await app.inject({
      method: "POST",
      url: "/api/auth/2fa",
      payload: { pendingToken: again.json().pendingToken as string, code },
    });
    expect(reused.statusCode).toBe(401);
  });

  it("throttles repeated failures per address and identity", async () => {
    for (let i = 0; i < 6; i++) {
      await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "totp@example.com", loginKey: "d2ryb25nIGtleSBmb3Igc3VyZQ" },
      });
    }
    const blocked = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "totp@example.com", loginKey: account.loginKey },
    });
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);

    // A different identity from the same address is unaffected.
    const other = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "someone-else@example.com", loginKey: account.loginKey },
    });
    expect(other.statusCode).toBe(401);

    // Backoff passes and the correct password signs in again (two-step).
    advance(20 * 60_000);
    const after = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "totp@example.com", loginKey: account.loginKey },
    });
    expect(after.statusCode).toBe(200);
    expect(after.json().twoFactorRequired).toBe(true);
  });

  it("disables with a valid code and login returns to one step", async () => {
    advance(30_000);
    const disable = await app.inject({
      method: "POST",
      url: "/api/auth/totp/disable",
      headers: authHeader(),
      payload: { code: totpAt(secret, fakeNow) },
    });
    expect(disable.statusCode).toBe(200);

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "totp@example.com", loginKey: account.loginKey },
    });
    expect(login.json().twoFactorRequired).toBeUndefined();
    expect(login.json().token).toBeTruthy();
    expect(login.json().keyAttributes).toBeTruthy();
  });
});

