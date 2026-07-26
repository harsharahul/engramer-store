import type { KdfParams, KeyAttributes, SecretBox } from "@engramer/crypto";

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
  register: (email: string, loginKey: string, keyAttributes: KeyAttributes) =>
    request<{ token: string }>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, loginKey, keyAttributes }),
    }),

  kdfAttributes: (email: string) =>
    request<{ kdf: KdfParams }>(`/api/auth/attributes?email=${encodeURIComponent(email)}`),

  login: (email: string, loginKey: string) =>
    request<{ token: string; keyAttributes: KeyAttributes }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, loginKey }),
    }),

  user: () =>
    request<{ email: string; usedBytes: number; quotaBytes: number; createdAt: number }>(
      "/api/user",
    ),

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

  downloadBlob: async (id: string, kind: "data" | "thumbnail"): Promise<Uint8Array> => {
    const response = await fetch(`/api/files/${id}/${kind}`, {
      headers: { authorization: `Bearer ${authToken}` },
    });
    if (!response.ok) {
      throw new ApiError(response.status, `download failed (${response.status})`);
    }
    return new Uint8Array(await response.arrayBuffer());
  },

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

/** Anonymous upload to a file request; same XHR progress pattern, no auth. */
export function uploadRequestBlob(
  requestToken: string,
  uploadId: string,
  kind: "data" | "thumbnail",
  payload: Uint8Array,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/public/requests/${requestToken}/files/${uploadId}/${kind}`);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(event.loaded / event.total);
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else if (xhr.status === 413) {
        reject(new ApiError(413, "the recipient is out of storage space"));
      } else {
        reject(new ApiError(xhr.status, `upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, "network error during upload"));
    xhr.send(payload.slice().buffer as ArrayBuffer);
  });
}

/** Upload with real progress reporting; fetch cannot observe upload progress. */
export function uploadBlob(
  fileId: string,
  kind: "data" | "thumbnail",
  payload: Uint8Array,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/files/${fileId}/${kind}`);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    if (authToken) {
      xhr.setRequestHeader("authorization", `Bearer ${authToken}`);
    }
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(event.loaded / event.total);
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else if (xhr.status === 413) {
        reject(new ApiError(413, "storage quota exceeded"));
      } else {
        reject(new ApiError(xhr.status, `upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, "network error during upload"));
    xhr.send(payload.slice().buffer as ArrayBuffer);
  });
}
