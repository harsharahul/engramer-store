/**
 * Storage helpers shared by the conformance suites: folders and files
 * created through the real client crypto, and the account's delta sync.
 */
import {
  encryptFileMetadata,
  encryptFolderMetadata,
  generateKey,
  secretBoxSeal,
  type AccountKeys,
  type SecretBox,
} from "@engramer/crypto";
import { expect } from "vitest";
import type { Target } from "../helpers/target.js";
import { bearer } from "./accounts.js";

export interface Account {
  keys: AccountKeys;
  token: string;
}

export interface FolderRow {
  id: string;
  parentId: string | null;
  encryptedKey: SecretBox;
  encryptedMeta: SecretBox;
  deleted: boolean;
  updateSeq: number;
  createdAt: number;
  updatedAt: number;
}

export interface FileRow {
  id: string;
  folderId: string | null;
  encryptedKey: SecretBox;
  encryptedMeta: SecretBox;
  keyEpoch: number;
  generation: number;
  size: number;
  thumbSize: number;
  indexSize: number;
  uploaded: boolean;
  trashed: boolean;
  deleted: boolean;
  updateSeq: number;
  createdAt: number;
  updatedAt: number;
  hasCollaborators?: boolean;
}

export interface SyncPage {
  seq: number;
  folders: FolderRow[];
  files: FileRow[];
  shared: unknown[];
}

export function folderBody(account: Account, name: string, parentId: string | null = null) {
  const key = generateKey();
  return {
    key,
    payload: {
      parentId,
      encryptedKey: secretBoxSeal(key, account.keys.masterKey),
      encryptedMeta: encryptFolderMetadata({ name }, key),
    },
  };
}

export async function createFolder(target: Target, account: Account, name: string, parentId: string | null = null) {
  const { key, payload } = folderBody(account, name, parentId);
  const response = await target.inject({ method: "POST", url: "/api/folders", headers: bearer(account.token), payload });
  expect(response.statusCode).toBe(201);
  return { id: (response.json() as FolderRow).id, key, row: response.json() as FolderRow };
}

export function fileBody(account: Account, name: string, folderId: string | null = null) {
  const key = generateKey();
  return {
    key,
    payload: {
      folderId,
      encryptedKey: secretBoxSeal(key, account.keys.masterKey),
      encryptedMeta: encryptFileMetadata({ name, mime: "application/octet-stream", size: 1, mtime: 1 }, key),
    },
  };
}

export async function createFile(target: Target, account: Account, name: string, folderId: string | null = null) {
  const { key, payload } = fileBody(account, name, folderId);
  const response = await target.inject({ method: "POST", url: "/api/files", headers: bearer(account.token), payload });
  expect(response.statusCode).toBe(201);
  return { id: (response.json() as FileRow).id, key, row: response.json() as FileRow };
}

export async function syncFor(target: Target, account: Account, since = 0): Promise<SyncPage> {
  const response = await target.inject({
    method: "GET",
    url: `/api/sync?since=${since}`,
    headers: bearer(account.token),
  });
  expect(response.statusCode).toBe(200);
  return response.json() as SyncPage;
}
