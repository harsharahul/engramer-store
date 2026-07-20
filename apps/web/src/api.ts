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

  createShare: (fileId: string) =>
    request<{ token: string }>("/api/shares", {
      method: "POST",
      body: JSON.stringify({ fileId }),
    }),

  listShares: () =>
    request<{ shares: Array<{ token: string; fileId: string; createdAt: number }> }>("/api/shares"),

  revokeShare: (token: string) => request<void>(`/api/shares/${token}`, { method: "DELETE" }),

  publicMeta: (token: string) =>
    request<{ encryptedMeta: SecretBox; size: number }>(`/api/public/${token}/meta`),

  publicData: async (token: string): Promise<Uint8Array> => {
    const response = await fetch(`/api/public/${token}/data`);
    if (!response.ok) {
      throw new ApiError(response.status, "this link is no longer available");
    }
    return new Uint8Array(await response.arrayBuffer());
  },
};

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
