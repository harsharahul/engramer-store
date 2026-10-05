import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTarget, type Target } from "../helpers/target.js";

/**
 * Every response carries the server's security headers: the content
 * security policy for the origin it was served on, and its companions.
 */
let target: Target;

beforeAll(async () => {
  target = await startTarget();
});

afterAll(async () => {
  await target?.close();
});

function expectSecurityHeaders(headers: Record<string, string>) {
  const host = new URL(target.baseUrl).host;
  expect(headers["content-security-policy"]).toBe(
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; " +
      `connect-src 'self' ws://${host}; img-src 'self' blob: data:; media-src 'self' blob: stream:; ` +
      "font-src 'self'; style-src 'self' 'unsafe-inline'; frame-src 'self' blob:; object-src 'none'; " +
      "base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  );
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["referrer-policy"]).toBe("no-referrer");
  expect(headers["permissions-policy"]).toBe("camera=(), microphone=(), geolocation=()");
  expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
  expect(headers["cross-origin-resource-policy"]).toBe("same-origin");
}

describe("response headers", () => {
  it("are on a successful JSON answer", async () => {
    const response = await target.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
    expectSecurityHeaders(response.headers);
  });

  it("are on an error answer too", async () => {
    const response = await target.inject({ method: "GET", url: "/api/user" });
    expect(response.statusCode).toBe(401);
    expectSecurityHeaders(response.headers);
  });
});
