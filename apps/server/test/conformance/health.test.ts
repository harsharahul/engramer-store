import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTarget, type Target } from "../helpers/target.js";

/**
 * The discovery routes every client calls before anything else: the
 * shell's server probe, the readiness check and the sign-up mode.
 */
let target: Target;

beforeAll(async () => {
  target = await startTarget();
});

afterAll(async () => {
  // Undefined when the start failed; that error is the one to read.
  await target?.close();
});

describe("health and discovery", () => {
  it("answers the health probe the shell and the server picker use", async () => {
    const response = await target.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^application\/json/);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("reports ready", async () => {
    const response = await target.inject({ method: "GET", url: "/api/ready" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready" });
  });

  it("lets a new account be created, with no Mac app named", async () => {
    const response = await target.inject({ method: "GET", url: "/api/auth/registration" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.mode).toBe("open");
    expect(body.macAppUrl).toBeNull();
  });

  it("answers a served path called with another method with a JSON 404", async () => {
    const response = await target.inject({ method: "POST", url: "/api/health", payload: {} });
    expect(response.statusCode).toBe(404);
    expect(typeof response.json().error).toBe("string");
  });

  it("answers an unknown API route with a JSON 404", async () => {
    const response = await target.inject({ method: "GET", url: "/api/no-such-route" });
    expect(response.statusCode).toBe(404);
    expect(typeof response.json().error).toBe("string");
  });
});
