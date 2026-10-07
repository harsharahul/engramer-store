/**
 * Content helpers shared by the conformance suites: sealed bytes up and
 * down the blob routes, parts sessions, versions and the storage check.
 */
import { encryptBytes, encryptFileMetadata, generateKey, secretBoxSeal, type SecretBox } from "@engramer/crypto";
import { expect } from "vitest";
import type { Target, TargetResponse } from "../helpers/target.js";
import { bearer } from "./accounts.js";
import { createFile, type Account } from "./storage.js";

export type BlobKind = "data" | "thumbnail" | "index";

export const OCTETS = { "content-type": "application/octet-stream" };

/** Byte equality for large buffers (a deep-equality matcher walks every
 * element and runs out of memory on tens of megabytes). */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
}

/** Deterministic bytes of a given length. */
export function payload(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    bytes[i] = (i * 31 + 7) % 251;
  }
  return bytes;
}

/** Splits bytes into n contiguous pieces (the last ones may be empty). */
export function split(bytes: Uint8Array, n: number): Uint8Array[] {
  const per = Math.ceil(bytes.length / n);
  const pieces: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += per) {
    pieces.push(bytes.subarray(i, Math.min(i + per, bytes.length)));
  }
  while (pieces.length < n) {
    pieces.push(new Uint8Array(0));
  }
  return pieces;
}

export function putBlob(
  target: Target,
  token: string,
  id: string,
  kind: BlobKind,
  bytes: Uint8Array,
  headers: Record<string, string> = {},
): Promise<TargetResponse> {
  return target.inject({
    method: "PUT",
    url: `/api/files/${id}/${kind}`,
    headers: { ...bearer(token), ...OCTETS, ...headers },
    payload: bytes,
  });
}

export function getBlob(
  target: Target,
  token: string,
  id: string,
  kind: BlobKind,
  headers: Record<string, string> = {},
): Promise<TargetResponse> {
  return target.inject({ method: "GET", url: `/api/files/${id}/${kind}`, headers: { ...bearer(token), ...headers } });
}

/** A file row with sealed content behind it. */
export async function uploadFile(target: Target, account: Account, name: string, plaintext: Uint8Array) {
  const file = await createFile(target, account, name);
  const ciphertext = encryptBytes(plaintext, file.key);
  const put = await putBlob(target, account.token, file.id, "data", ciphertext);
  expect(put.statusCode).toBe(200);
  return { id: file.id, key: file.key, ciphertext, plaintext };
}

export function metaFor(key: Uint8Array, name: string, size: number, text?: string): SecretBox {
  return encryptFileMetadata({ name, mime: "text/plain", size, mtime: Date.now(), ...(text ? { text } : {}) }, key);
}

export function freshKeyFor(account: Account) {
  const key = generateKey();
  return { key, encryptedKey: secretBoxSeal(key, account.keys.masterKey) };
}

export async function beginParts(target: Target, token: string, id: string, size: unknown): Promise<TargetResponse> {
  return target.inject({ method: "POST", url: `/api/files/${id}/data/parts`, headers: bearer(token), payload: { size } });
}

export function putPart(target: Target, token: string, id: string, session: string, part: number | string, bytes: Uint8Array) {
  return target.inject({
    method: "PUT",
    url: `/api/files/${id}/data/parts/${session}/${part}`,
    headers: { ...bearer(token), ...OCTETS },
    payload: bytes,
  });
}

export function completeParts(target: Target, token: string, id: string, session: string) {
  return target.inject({ method: "POST", url: `/api/files/${id}/data/parts/${session}/complete`, headers: bearer(token) });
}

export function abortParts(target: Target, token: string, id: string, session: string) {
  return target.inject({ method: "DELETE", url: `/api/files/${id}/data/parts/${session}`, headers: bearer(token) });
}

export interface VersionRow {
  generation: number;
  size: number;
  encryptedMeta: SecretBox;
  createdAt: number;
}

export async function listVersions(target: Target, token: string, id: string): Promise<VersionRow[]> {
  const response = await target.inject({ method: "GET", url: `/api/files/${id}/versions`, headers: bearer(token) });
  expect(response.statusCode).toBe(200);
  return response.json().versions as VersionRow[];
}

export function versionData(target: Target, token: string, id: string, generation: number | string) {
  return target.inject({ method: "GET", url: `/api/files/${id}/versions/${generation}/data`, headers: bearer(token) });
}

export function restoreVersion(target: Target, token: string, id: string, generation: number | string, payload: unknown) {
  return target.inject({
    method: "POST",
    url: `/api/files/${id}/versions/${generation}/restore`,
    headers: bearer(token),
    payload,
  });
}

export async function verify(target: Target, token: string, ids: unknown): Promise<TargetResponse> {
  return target.inject({ method: "POST", url: "/api/files/verify", headers: bearer(token), payload: { ids } });
}

export async function usedBytes(target: Target, token: string): Promise<number> {
  const response = await target.inject({ method: "GET", url: "/api/user", headers: bearer(token) });
  expect(response.statusCode).toBe(200);
  return response.json().usedBytes as number;
}
