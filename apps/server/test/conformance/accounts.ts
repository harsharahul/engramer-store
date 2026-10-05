/**
 * Account helpers shared by the conformance suites: register through the
 * real key ceremony, read a token's claims, and sign tokens with a
 * target's own session secret (both backends keep it in
 * `<dataDir>/jwt-secret` and use its text as the HMAC key).
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generateAccountKeys } from "@engramer/crypto";
import { expect } from "vitest";
import type { Target } from "../helpers/target.js";

export const PASSWORD = "correct horse battery staple";

export async function register(target: Target, email: string, password = PASSWORD) {
  const keys = generateAccountKeys(password);
  const response = await target.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { email, loginKey: keys.loginKey, keyAttributes: keys.keyAttributes },
  });
  expect(response.statusCode).toBe(201);
  return { keys, token: response.json().token as string };
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

export interface Claims {
  uid: number;
  ep: number;
  iat: number;
  exp: number;
}

export function claims(token: string): Claims {
  return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Claims;
}

/** An HS256 token over `payload`, signed with the target's own secret. */
export function signToken(target: Target, payload: Record<string, unknown>): string {
  const secret = readFileSync(join(target.dataDir, "jwt-secret"), "utf8").trim();
  const head = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${signature}`;
}
