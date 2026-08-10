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
  /** Rotation counter; absent on rows cached before it existed. */
  keyEpoch?: number;
  /** Content generation; absent on rows cached before it traveled. */
  generation?: number;
  /** Whether anyone else holds a key; absent when the query did not say. */
  hasCollaborators?: boolean;
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

/**
 * A file shared into this account, shaped for its recipient: the key
 * arrives sealed to the account's public key, the location is the owner's
 * business and so is always null, and the cursor is the membership's own
 * sequence. `revoked` doubles as the tombstone.
 */
export interface SharedFileDto {
  id: string;
  folderId: null;
  encryptedMeta: SecretBox;
  generation?: number;
  size: number;
  thumbSize: number;
  indexSize: number;
  uploaded: boolean;
  updateSeq: number;
  createdAt: number;
  updatedAt: number;
  ownerEmail: string;
  role: "viewer" | "editor";
  sealedKey: string;
  keyEpoch: number;
  revoked: boolean;
}

export interface CollabInviteInfo {
  token: string;
  fileId: string;
  role: "viewer" | "editor";
  createdAt: number;
  expiresAt: number | null;
  revoked: boolean;
  granted: boolean;
  claimed: boolean;
  claimantEmail?: string;
  claimantPublicKey?: string;
}

/** One person on one file, across the whole library's people shares. */
export interface SharedPersonInfo {
  fileId: string;
  userId: number;
  email: string;
  role: "viewer" | "editor";
  createdAt: number;
}

export interface CollaboratorInfo {
  userId: number;
  email: string;
  /** The member's account public key, for re-sealing a rotated file key. */
  publicKey: string;
  role: "viewer" | "editor";
  keyEpoch: number;
  createdAt: number;
}

export interface SyncResponse {
  seq: number;
  folders: FolderDto[];
  files: FileDto[];
  /** Absent from rows cached before sharing existed; treat as empty. */
  shared?: SharedFileDto[];
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

  recoveryBegin: (email: string) =>
    request<{
      challengeId: string;
      publicKey: string;
      masterKeyEncryptedWithRecoveryKey: SecretBox;
      encryptedPrivateKey: SecretBox;
      sealedChallenge: string;
    }>("/api/auth/recovery/begin", { method: "POST", body: JSON.stringify({ email }) }),

  recoveryProve: (challengeId: string, nonce: string) =>
    request<{ resetToken: string; twoFactorRequired: boolean }>("/api/auth/recovery/prove", {
      method: "POST",
      body: JSON.stringify({ challengeId, nonce }),
    }),

  recoveryTwoFactor: (resetToken: string, code: string) =>
    request<{ resetToken: string }>("/api/auth/recovery/2fa", {
      method: "POST",
      body: JSON.stringify({ resetToken, code }),
    }),

  recoveryFinish: (
    resetToken: string,
    loginKey: string,
    kdf: KdfParams,
    encryptedMasterKey: SecretBox,
  ) =>
    request<{ token: string; keyAttributes: KeyAttributes }>("/api/auth/recovery/finish", {
      method: "POST",
      body: JSON.stringify({ resetToken, loginKey, kdf, encryptedMasterKey }),
    }),

  keyAttributes: () => request<{ keyAttributes: KeyAttributes }>("/api/user/key-attributes"),

  changePassword: (
    currentLoginKey: string,
    loginKey: string,
    kdf: KdfParams,
    encryptedMasterKey: SecretBox,
  ) =>
    request<{ token: string }>("/api/auth/password", {
      method: "POST",
      body: JSON.stringify({ currentLoginKey, loginKey, kdf, encryptedMasterKey }),
    }),

  rotateRecoveryKey: (
    currentLoginKey: string,
    masterKeyEncryptedWithRecoveryKey: SecretBox,
    recoveryKeyEncryptedWithMasterKey: SecretBox,
  ) =>
    request<{ ok: boolean }>("/api/user/recovery-key", {
      method: "POST",
      body: JSON.stringify({
        currentLoginKey,
        masterKeyEncryptedWithRecoveryKey,
        recoveryKeyEncryptedWithMasterKey,
      }),
    }),

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
      displayName: string | null;
      totpEnabled: boolean;
      recoveryCodesLeft: number;
      isAdmin: boolean;
    }>("/api/user"),

  /** The name collaborators see instead of this account's address. */
  setDisplayName: (displayName: string | null) =>
    request<{ displayName: string | null }>("/api/user", {
      method: "PATCH",
      body: JSON.stringify({ displayName }),
    }),

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

  createCollabInvite: (fileId: string, role: "viewer" | "editor", expiresAt?: number | null) =>
    request<{ token: string }>("/api/collab/invites", {
      method: "POST",
      body: JSON.stringify({ fileId, role, ...(expiresAt ? { expiresAt } : {}) }),
    }),
  listCollabInvites: () => request<{ invites: CollabInviteInfo[] }>("/api/collab/invites"),
  revokeCollabInvite: (token: string) =>
    request<void>(`/api/collab/invites/${token}`, { method: "DELETE" }),
  claimCollabInvite: (token: string) =>
    request<{ ownerEmail: string; role: "viewer" | "editor" }>(
      `/api/collab/invites/${token}/claim`,
      { method: "POST", body: "{}" },
    ),
  grantCollabInvite: (token: string, sealedKey: string) =>
    request<{ ok: boolean }>(`/api/collab/invites/${token}/grant`, {
      method: "POST",
      body: JSON.stringify({ sealedKey }),
    }),
  listCollaborators: (fileId: string) =>
    request<{ collaborators: CollaboratorInfo[] }>(`/api/collab/files/${fileId}/collaborators`),
  listSharedPeople: () =>
    request<{ shared: SharedPersonInfo[] }>("/api/collab/files"),
  patchCollaborator: (fileId: string, userId: number, role: "viewer" | "editor") =>
    request<void>(`/api/collab/files/${fileId}/collaborators/${userId}`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    }),
  removeCollaborator: (fileId: string, userId: number) =>
    request<void>(`/api/collab/files/${fileId}/collaborators/${userId}`, { method: "DELETE" }),
  leaveShared: (fileId: string) =>
    request<void>(`/api/collab/files/${fileId}/me`, { method: "DELETE" }),
  rekeyShared: (fileId: string, epoch: number, keys: Array<{ userId: number; sealedKey: string }>) =>
    request<void>(`/api/collab/files/${fileId}/rekey`, {
      method: "POST",
      body: JSON.stringify({ epoch, keys }),
    }),
  collabTicket: (fileId: string) =>
    request<{ ticket: string; expiresIn: number }>(`/api/collab/${fileId}/ticket`, {
      method: "POST",
      body: "{}",
    }),

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

  patchFile: (
    id: string,
    patch: { folderId?: string | null; encryptedMeta?: SecretBox; encryptedKey?: SecretBox },
  ) => request<FileDto>(`/api/files/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  trashFile: (id: string) => request<void>(`/api/files/${id}`, { method: "DELETE" }),
  restoreFile: (id: string) => request<void>(`/api/trash/${id}/restore`, { method: "POST" }),
  deleteForever: (id: string) => request<void>(`/api/trash/${id}`, { method: "DELETE" }),

  downloadBlob: async (id: string, kind: "data" | "thumbnail" | "index"): Promise<Uint8Array> => {
    const { bytes } = await api.downloadBlobDetailed(id, kind);
    return bytes;
  },

  /**
   * The same download, keeping the generation the server names for the
   * bytes, so callers can pair them with the channel's content marker
   * exactly. Null on an older server that does not name one.
   */
  downloadBlobDetailed: async (
    id: string,
    kind: "data" | "thumbnail" | "index",
  ): Promise<{ bytes: Uint8Array; generation: number | null }> => {
    const response = await fetch(`/api/files/${id}/${kind}`, {
      headers: { authorization: `Bearer ${authToken}` },
    });
    if (!response.ok) {
      throw new ApiError(response.status, `download failed (${response.status})`);
    }
    const named = response.headers.get("x-generation");
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      generation: named === null ? null : Number(named),
    };
  },

  /**
   * Asks the server whether the blobs it holds are still what it was given.
   * No file content crosses the wire, so a vault of any size can be checked
   * without downloading it. Bounded per call so the caller drives progress.
   */
  verifyStored: (ids: string[]) =>
    request<{ results: { id: string; verdict: string }[] }>(`/api/files/verify`, {
      method: "POST",
      body: JSON.stringify({ ids }),
    }),

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
/**
 * Sends bytes and returns the number the server says it wrote.
 *
 * That count is the one independent measurement available at upload time,
 * and it was being discarded: an upload that stored fewer bytes than it sent
 * reported success like any other.
 */
function putBytes(
  url: string,
  payload: Uint8Array,
  opts: {
    auth?: boolean;
    onProgress?: (fraction: number) => void;
    signal?: AbortSignal;
    errorFor?: (status: number) => string | undefined;
    headers?: Record<string, string>;
    /** The parsed response body, for callers that need more than size. */
    onBody?: (body: unknown) => void;
  },
): Promise<number | null> {
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
    for (const [name, value] of Object.entries(opts.headers ?? {})) {
      xhr.setRequestHeader(name, value);
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
          let written: number | null = null;
          try {
            const body = JSON.parse(xhr.responseText) as { size?: unknown };
            written = typeof body.size === "number" ? body.size : null;
            opts.onBody?.(body);
          } catch {
            // Not every endpoint answers with a body; absence is not failure.
          }
          resolve(written);
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
): Promise<number | null> {
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
): Promise<number | null> {
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
  opts?: {
    collabSnapshot?: boolean;
    collabUpTo?: number;
    /** "content" writes bytes and stamps the marker without trimming the
     * log; "checkpoint" (or absence, for older bundles) trims as before. */
    collabMode?: "content" | "checkpoint";
    /** This member's channel connection, so the room's broadcasts can
     * skip the author of the save they describe. */
    collabConn?: string;
    /** Metadata to commit in the same transaction as the bytes, closing
     * the window where a reader sees a new generation beside an old
     * digest. An older server ignores it; the reply says whether it
     * landed by carrying the committed file. */
    encryptedMeta?: SecretBox;
    onBody?: (body: unknown) => void;
  },
): Promise<number | null> {
  // One headers object: metadata riding the save and the live-save
  // markers can travel together.
  const headers: Record<string, string> = {};
  if (opts?.encryptedMeta) {
    headers["x-encrypted-meta"] = btoa(JSON.stringify(opts.encryptedMeta));
  }
  // Marks this whole-document write as a claimed snapshot of the live
  // channel, which is what lets it through the tail-base guard. The
  // snapshot header always travels with a live save, even for a content
  // save, so an older server still admits the write.
  if (opts?.collabSnapshot) {
    headers["x-collab-snapshot"] = "1";
    headers["x-collab-upto"] = String(opts.collabUpTo ?? 0);
    if (opts.collabMode) {
      headers["x-collab-mode"] = opts.collabMode;
    }
    if (opts.collabConn) {
      headers["x-collab-conn"] = opts.collabConn;
    }
  }
  return putBytes(`/api/files/${fileId}/${kind}`, payload, {
    auth: true,
    onProgress,
    signal,
    errorFor: (status) => (status === 413 ? "storage quota exceeded" : undefined),
    onBody: opts?.onBody,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  });
}
