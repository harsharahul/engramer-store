import type { KdfParams, KeyAttributes, SecretBox } from "@engramer/crypto";
import { diag } from "./diag";

export interface FolderDto {
  id: string;
  parentId: string | null;
  encryptedKey: SecretBox;
  encryptedMeta: SecretBox;
  deleted: boolean;
  updateSeq: number;
  createdAt: number;
  updatedAt: number;
}

export interface FileDto {
  id: string;
  folderId: string | null;
  encryptedKey: SecretBox;
  encryptedMeta: SecretBox;
  size: number;
  thumbSize: number;
  indexSize: number;
  uploaded: boolean;
  trashed: boolean;
  deleted: boolean;
  updateSeq: number;
  createdAt: number;
  updatedAt: number;
}

export interface SyncResponse {
  seq: number;
  folders: FolderDto[];
  files: FileDto[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

let authToken: string | null = null;
let onUnauthorized: (() => void) | null = null;

export function setAuthToken(token: string | null): void {
  authToken = token;
}

export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

const RETRYABLE = new Set([429, 503]);
const MAX_ATTEMPTS = 5;

/**
 * Mass transfers must survive throttling: 429/503 responses are retried with
 * the server's Retry-After when present, otherwise exponential backoff.
 */
export async function withRetry<T>(run: () => Promise<T>): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await run();
    } catch (err) {
      attempt++;
      if (!(err instanceof ApiError) || !RETRYABLE.has(err.status) || attempt >= MAX_ATTEMPTS) {
        throw err;
      }
      const wait = err.retryAfterMs ?? Math.min(15_000, 500 * 2 ** attempt);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (authToken) {
    headers.set("authorization", `Bearer ${authToken}`);
  }
  if (init.body && typeof init.body === "string") {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(path, { ...init, headers });
  if (response.status === 401 && authToken) {
    onUnauthorized?.();
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(response.status, body.error ?? `request failed (${response.status})`);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export const api = {
  register: (email: string, loginKey: string, keyAttributes: KeyAttributes, inviteToken?: string) =>
    request<{ token: string }>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, loginKey, keyAttributes, ...(inviteToken ? { inviteToken } : {}) }),
    }),

  registration: () => request<{ mode: "open" | "invite" | "closed" }>("/api/auth/registration"),

  kdfAttributes: (email: string) =>
    request<{ kdf: KdfParams }>(`/api/auth/attributes?email=${encodeURIComponent(email)}`),

  login: (email: string, loginKey: string) =>
    request<{
      token?: string;
      keyAttributes?: KeyAttributes;
      twoFactorRequired?: boolean;
      pendingToken?: string;
    }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, loginKey }),
    }),

  twoFactor: (pendingToken: string, code: string) =>
    request<{ token: string; keyAttributes: KeyAttributes; recoveryCodesLeft?: number }>(
      "/api/auth/2fa",
      { method: "POST", body: JSON.stringify({ pendingToken, code }) },
    ),

  totpSetup: () =>
    request<{ secret: string; otpauthUri: string }>("/api/auth/totp/setup", { method: "POST", body: "{}" }),

  totpConfirm: (code: string) =>
    request<{ recoveryCodes: string[] }>("/api/auth/totp/confirm", {
      method: "POST",
      body: JSON.stringify({ code }),
    }),

  totpDisable: (code: string) =>
    request<{ disabled: boolean }>("/api/auth/totp/disable", {
      method: "POST",
      body: JSON.stringify({ code }),
    }),

  user: () =>
    request<{
      email: string;
      usedBytes: number;
      quotaBytes: number;
      createdAt: number;
      totpEnabled: boolean;
      recoveryCodesLeft: number;
      isAdmin: boolean;
    }>("/api/user"),

  adminListUsers: () =>
    request<{ users: AdminUserInfo[]; registration: "open" | "invite" | "closed" }>(
      "/api/admin/users",
    ),
  adminCreateInvite: () =>
    request<{ token: string }>("/api/admin/invites", { method: "POST", body: "{}" }),
  adminListInvites: () => request<{ invites: AdminInviteInfo[] }>("/api/admin/invites"),
  adminRevokeInvite: (token: string) =>
    request<void>(`/api/admin/invites/${token}`, { method: "DELETE" }),
  adminSetDisabled: (id: number, disabled: boolean) =>
    request<void>(`/api/admin/users/${id}/${disabled ? "disable" : "enable"}`, {
      method: "POST",
      body: "{}",
    }),
  adminSetQuota: (id: number, quotaBytes: number | null) =>
    request<void>(`/api/admin/users/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ quotaBytes }),
    }),
  adminDeleteUser: (id: number) => request<void>(`/api/admin/users/${id}`, { method: "DELETE" }),

  sync: (since: number) => request<SyncResponse>(`/api/sync?since=${since}`),

  createFolder: (parentId: string | null, encryptedKey: SecretBox, encryptedMeta: SecretBox) =>
    request<FolderDto>("/api/folders", {
      method: "POST",
      body: JSON.stringify({ parentId, encryptedKey, encryptedMeta }),
    }),

  patchFolder: (id: string, patch: { parentId?: string | null; encryptedMeta?: SecretBox }) =>
    request<FolderDto>(`/api/folders/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  deleteFolder: (id: string) => request<void>(`/api/folders/${id}`, { method: "DELETE" }),

  createFile: (folderId: string | null, encryptedKey: SecretBox, encryptedMeta: SecretBox) =>
    request<FileDto>("/api/files", {
      method: "POST",
      body: JSON.stringify({ folderId, encryptedKey, encryptedMeta }),
    }),

  patchFile: (id: string, patch: { folderId?: string | null; encryptedMeta?: SecretBox }) =>
    request<FileDto>(`/api/files/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  trashFile: (id: string) => request<void>(`/api/files/${id}`, { method: "DELETE" }),
  restoreFile: (id: string) => request<void>(`/api/trash/${id}/restore`, { method: "POST" }),
  deleteForever: (id: string) => request<void>(`/api/trash/${id}`, { method: "DELETE" }),

  downloadBlob: async (id: string, kind: "data" | "thumbnail" | "index"): Promise<Uint8Array> => {
    const response = await fetch(`/api/files/${id}/${kind}`, {
      headers: { authorization: `Bearer ${authToken}` },
    });
    if (!response.ok) {
      throw new ApiError(response.status, `download failed (${response.status})`);
    }
    return new Uint8Array(await response.arrayBuffer());
  },

  listVersions: (fileId: string) =>
    request<{ versions: FileVersionInfo[] }>(`/api/files/${fileId}/versions`),

  downloadVersionBlob: async (fileId: string, generation: number): Promise<Uint8Array> => {
    const response = await fetch(`/api/files/${fileId}/versions/${generation}/data`, {
      headers: { authorization: `Bearer ${authToken}` },
    });
    if (!response.ok) {
      throw new ApiError(response.status, `download failed (${response.status})`);
    }
    return new Uint8Array(await response.arrayBuffer());
  },

  restoreVersion: (fileId: string, generation: number, encryptedMeta: SecretBox) =>
    request<FileDto>(`/api/files/${fileId}/versions/${generation}/restore`, {
      method: "POST",
      body: JSON.stringify({ encryptedMeta }),
    }),

  createShare: (fileId: string, options?: ShareOptions) =>
    request<{ token: string }>("/api/shares", {
      method: "POST",
      body: JSON.stringify({ fileId, ...options }),
    }),

  listShares: () => request<{ shares: ShareInfo[] }>("/api/shares"),

  revokeShare: (token: string) => request<void>(`/api/shares/${token}`, { method: "DELETE" }),

  publicMeta: (token: string, accessKey?: string) =>
    request<PublicMeta>(`/api/public/${token}/meta`, {
      headers: accessKey ? { "x-share-access": accessKey } : {},
    }),

  publicData: async (token: string, accessKey?: string): Promise<Uint8Array> => {
    const response = await fetch(`/api/public/${token}/data`, {
      headers: accessKey ? { "x-share-access": accessKey } : {},
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(response.status, body.error ?? "this link is no longer available");
    }
    return new Uint8Array(await response.arrayBuffer());
  },

  createFileRequest: (folderId: string | null, encryptedMeta: SecretBox, expiresAt?: number | null) =>
    request<{ token: string }>("/api/requests", {
      method: "POST",
      body: JSON.stringify({ folderId, encryptedMeta, expiresAt }),
    }),

  listFileRequests: () => request<{ requests: FileRequestInfo[] }>("/api/requests"),

  revokeFileRequest: (token: string) => request<void>(`/api/requests/${token}`, { method: "DELETE" }),

  listRequestUploads: () => request<{ uploads: RequestUploadInfo[] }>("/api/requests/uploads"),

  acceptRequestUpload: (id: string, encryptedKey: SecretBox, encryptedMeta: SecretBox) =>
    request<FileDto>(`/api/requests/uploads/${id}/accept`, {
      method: "POST",
      body: JSON.stringify({ encryptedKey, encryptedMeta }),
    }),

  discardRequestUpload: (id: string) =>
    request<void>(`/api/requests/uploads/${id}`, { method: "DELETE" }),

  publicRequestInfo: (token: string) =>
    request<{ publicKey: string; maxBytes: number }>(`/api/public/requests/${token}`),

  publicRequestCreateFile: (token: string, sealedKey: string, encryptedMeta: SecretBox) =>
    request<{ id: string }>(`/api/public/requests/${token}/files`, {
      method: "POST",
      body: JSON.stringify({ sealedKey, encryptedMeta }),
    }),
};

export interface AdminUserInfo {
  id: number;
  email: string;
  createdAt: number;
  usedBytes: number;
  quotaBytes: number;
  quotaOverride: boolean;
  totpEnabled: boolean;
  disabled: boolean;
  isAdmin: boolean;
}

export interface AdminInviteInfo {
  token: string;
  createdAt: number;
  expiresAt: number | null;
  used: boolean;
  usedAt: number | null;
}

export interface FileVersionInfo {
  generation: number;
  size: number;
  encryptedMeta: SecretBox;
  createdAt: number;
}

export interface ShareOptions {
  expiresAt?: number | null;
  maxDownloads?: number | null;
  password?: {
    digest: string;
    kdf: KdfParams;
    wrappedKey: SecretBox;
  } | null;
}

export interface ShareInfo {
  token: string;
  fileId: string;
  createdAt: number;
  expiresAt: number | null;
  maxDownloads: number | null;
  downloadCount: number;
  protected: boolean;
}

export interface PublicMeta {
  protected: boolean;
  kdf?: KdfParams;
  encryptedMeta?: SecretBox;
  size?: number;
  wrappedKey?: SecretBox;
}

export interface FileRequestInfo {
  token: string;
  folderId: string | null;
  encryptedMeta: SecretBox;
  expiresAt: number | null;
  revoked: boolean;
  createdAt: number;
  received: number;
  pending: number;
}

export interface RequestUploadInfo {
  id: string;
  requestToken: string;
  sealedKey: string;
  encryptedMeta: SecretBox;
  size: number;
  thumbSize: number;
  createdAt: number;
}

/** ApiError status used when the user cancels; never retried anywhere. */
export const UPLOAD_CANCELLED = -1;

// A body that moves no bytes for this long is a dead connection, not a slow
// one; the request is aborted so the retry layer can start a fresh attempt
// instead of hanging the queue forever (seen with a stalled VPN tunnel).
const UPLOAD_STALL_MS = 30_000;
// After the body is fully sent the server may legitimately take a while
// (writing a part to object storage), so the response phase gets more room.
const RESPONSE_STALL_MS = 180_000;

/**
 * One PUT with progress, a stall watchdog, and optional cancellation.
 * XHR rather than fetch because fetch cannot observe upload progress.
 */
function putBytes(
  url: string,
  payload: Uint8Array,
  opts: {
    auth?: boolean;
    onProgress?: (fraction: number) => void;
    signal?: AbortSignal;
    errorFor?: (status: number) => string | undefined;
  },
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new ApiError(UPLOAD_CANCELLED, "upload cancelled"));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    if (opts.auth && authToken) {
      xhr.setRequestHeader("authorization", `Bearer ${authToken}`);
    }
    let lastMovement = Date.now();
    let bodySent = false;
    const watchdog = setInterval(() => {
      if (Date.now() - lastMovement > (bodySent ? RESPONSE_STALL_MS : UPLOAD_STALL_MS)) {
        xhr.abort();
      }
    }, 5_000);
    const onCancel = () => xhr.abort();
    opts.signal?.addEventListener("abort", onCancel);
    const settle = (outcome: () => void) => {
      clearInterval(watchdog);
      opts.signal?.removeEventListener("abort", onCancel);
      outcome();
    };
    xhr.upload.onprogress = (event) => {
      lastMovement = Date.now();
      if (event.lengthComputable && opts.onProgress) {
        opts.onProgress(event.loaded / event.total);
      }
    };
    xhr.upload.onload = () => {
      bodySent = true;
      lastMovement = Date.now();
    };
    xhr.onload = () =>
      settle(() => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
        } else {
          reject(
            new ApiError(xhr.status, opts.errorFor?.(xhr.status) ?? `upload failed (${xhr.status})`),
          );
        }
      });
    xhr.onerror = () =>
      settle(() => {
        diag("upload", `network error on PUT ${url.split("?")[0]}`);
        reject(new ApiError(0, "network error during upload"));
      });
    xhr.onabort = () =>
      settle(() => {
        if (!opts.signal?.aborted) {
          diag("upload", `stalled request aborted after no progress: ${url.split("?")[0]}`);
        }
        reject(
          opts.signal?.aborted
            ? new ApiError(UPLOAD_CANCELLED, "upload cancelled")
            : new ApiError(0, "upload stalled"),
        );
      });
    xhr.send(sendable(payload));
  });
}

/** Anonymous upload to a file request; same PUT machinery, no auth. */
export function uploadRequestBlob(
  requestToken: string,
  uploadId: string,
  kind: "data" | "thumbnail" | "index",
  payload: Uint8Array,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  return putBytes(`/api/public/requests/${requestToken}/files/${uploadId}/${kind}`, payload, {
    onProgress,
    errorFor: (status) => (status === 413 ? "the recipient is out of storage space" : undefined),
  });
}

// ----- part uploads: large content in bounded requests -----

/** Opens a part-upload session; the size is the exact ciphertext length. */
export function beginPartUpload(fileId: string, size: number): Promise<{ session: string }> {
  return request(`/api/files/${fileId}/data/parts`, {
    method: "POST",
    body: JSON.stringify({ size }),
  });
}

export function completePartUpload(fileId: string, session: string): Promise<{ size: number }> {
  return request(`/api/files/${fileId}/data/parts/${session}/complete`, { method: "POST" });
}

export function abortPartUpload(fileId: string, session: string): Promise<void> {
  return request(`/api/files/${fileId}/data/parts/${session}`, { method: "DELETE" });
}

/** Uploads one numbered part with progress; parts are retryable in place. */
export function uploadPart(
  fileId: string,
  session: string,
  partNo: number,
  payload: Uint8Array,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return putBytes(`/api/files/${fileId}/data/parts/${session}/${partNo}`, payload, {
    auth: true,
    onProgress,
    signal,
    errorFor: (status) => `part upload failed (${status})`,
  });
}

/** Sends without copying when the array owns its whole buffer, which is the
 * case for freshly encrypted payloads; a view into a larger buffer is sliced. */
function sendable(payload: Uint8Array): ArrayBuffer {
  return payload.byteOffset === 0 && payload.byteLength === payload.buffer.byteLength
    ? (payload.buffer as ArrayBuffer)
    : (payload.slice().buffer as ArrayBuffer);
}

/** Upload with real progress reporting; fetch cannot observe upload progress. */
export function uploadBlob(
  fileId: string,
  kind: "data" | "thumbnail" | "index",
  payload: Uint8Array,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return putBytes(`/api/files/${fileId}/${kind}`, payload, {
    auth: true,
    onProgress,
    signal,
    errorFor: (status) => (status === 413 ? "storage quota exceeded" : undefined),
  });
}
