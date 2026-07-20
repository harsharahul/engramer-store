import { create } from "zustand";
import {
  decryptFileMetadata,
  decryptFolderMetadata,
  encryptFileMetadata,
  encryptFolderMetadata,
  generateKey,
  secretBoxOpen,
  secretBoxSeal,
} from "@engramer/crypto";
import { api, type FileDto, type FolderDto } from "./api";
import { clearSession, type Session } from "./session";
import { encryptAndUpload } from "./transfer";

export interface FolderEntry {
  id: string;
  parentId: string | null;
  name: string;
  key: Uint8Array;
  createdAt: number;
  updatedAt: number;
}

export interface FileEntry {
  id: string;
  folderId: string | null;
  name: string;
  mime: string;
  size: number;
  mtime: number;
  width?: number;
  height?: number;
  text?: string;
  key: Uint8Array;
  hasThumb: boolean;
  trashed: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface UploadItem {
  id: string;
  name: string;
  progress: number;
  status: "encrypting" | "uploading" | "done" | "error";
  error?: string;
}

export interface Usage {
  usedBytes: number;
  quotaBytes: number;
}

interface StoreState {
  session: Session | null;
  synced: boolean;
  folders: Map<string, FolderEntry>;
  files: Map<string, FileEntry>;
  usage: Usage | null;
  uploads: UploadItem[];

  startSession: (session: Session) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
  refreshUsage: () => Promise<void>;
  createFolder: (name: string, parentId: string | null) => Promise<void>;
  renameFolder: (id: string, name: string) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;
  uploadFiles: (files: File[], folderId: string | null) => Promise<void>;
  renameFile: (id: string, name: string) => Promise<void>;
  moveFile: (id: string, folderId: string | null) => Promise<void>;
  trashFile: (id: string) => Promise<void>;
  restoreFile: (id: string) => Promise<void>;
  deleteForever: (id: string) => Promise<void>;
  clearFinishedUploads: () => void;
}

function decryptFolder(dto: FolderDto, masterKey: Uint8Array): FolderEntry {
  const key = secretBoxOpen(dto.encryptedKey, masterKey);
  const meta = decryptFolderMetadata(dto.encryptedMeta, key);
  return {
    id: dto.id,
    parentId: dto.parentId,
    name: meta.name,
    key,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
  };
}

function decryptFile(dto: FileDto, masterKey: Uint8Array): FileEntry {
  const key = secretBoxOpen(dto.encryptedKey, masterKey);
  const meta = decryptFileMetadata(dto.encryptedMeta, key);
  return {
    id: dto.id,
    folderId: dto.folderId,
    name: meta.name,
    mime: meta.mime,
    size: meta.size,
    mtime: meta.mtime,
    width: meta.width,
    height: meta.height,
    text: meta.text,
    key,
    hasThumb: dto.thumbSize > 0,
    trashed: dto.trashed,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
  };
}

export const useStore = create<StoreState>((set, get) => {
  const masterKey = () => {
    const session = get().session;
    if (!session) {
      throw new Error("not signed in");
    }
    return session.masterKey;
  };

  const applyFolder = (dto: FolderDto) => {
    const folders = new Map(get().folders);
    if (dto.deleted) {
      folders.delete(dto.id);
    } else {
      folders.set(dto.id, decryptFolder(dto, masterKey()));
    }
    set({ folders });
  };

  const applyFile = (dto: FileDto) => {
    const files = new Map(get().files);
    if (dto.deleted) {
      files.delete(dto.id);
    } else {
      files.set(dto.id, decryptFile(dto, masterKey()));
    }
    set({ files });
  };

  return {
    session: null,
    synced: false,
    folders: new Map(),
    files: new Map(),
    usage: null,
    uploads: [],

    startSession: async (session) => {
      set({ session, synced: false, folders: new Map(), files: new Map(), uploads: [] });
      await get().refresh();
      await get().refreshUsage();
    },

    logout: () => {
      clearSession();
      set({
        session: null,
        synced: false,
        folders: new Map(),
        files: new Map(),
        usage: null,
        uploads: [],
      });
    },

    refresh: async () => {
      const key = masterKey();
      const response = await api.sync(0);
      const folders = new Map<string, FolderEntry>();
      const files = new Map<string, FileEntry>();
      for (const dto of response.folders) {
        if (!dto.deleted) {
          folders.set(dto.id, decryptFolder(dto, key));
        }
      }
      for (const dto of response.files) {
        if (!dto.deleted && dto.uploaded) {
          files.set(dto.id, decryptFile(dto, key));
        }
      }
      set({ folders, files, synced: true });
    },

    refreshUsage: async () => {
      const user = await api.user();
      set({ usage: { usedBytes: user.usedBytes, quotaBytes: user.quotaBytes } });
    },

    createFolder: async (name, parentId) => {
      const folderKey = generateKey();
      const dto = await api.createFolder(
        parentId,
        secretBoxSeal(folderKey, masterKey()),
        encryptFolderMetadata({ name }, folderKey),
      );
      applyFolder(dto);
    },

    renameFolder: async (id, name) => {
      const folder = get().folders.get(id);
      if (!folder) {
        return;
      }
      const dto = await api.patchFolder(id, {
        encryptedMeta: encryptFolderMetadata({ name }, folder.key),
      });
      applyFolder(dto);
    },

    deleteFolder: async (id) => {
      await api.deleteFolder(id);
      await get().refresh();
    },

    uploadFiles: async (fileList, folderId) => {
      const key = masterKey();
      for (const file of fileList) {
        const uploadId = crypto.randomUUID();
        set({
          uploads: [
            ...get().uploads,
            { id: uploadId, name: file.name, progress: 0, status: "encrypting" },
          ],
        });
        const update = (patch: Partial<UploadItem>) =>
          set({
            uploads: get().uploads.map((u) => (u.id === uploadId ? { ...u, ...patch } : u)),
          });
        try {
          const result = await encryptAndUpload(file, folderId, key, (fraction) =>
            update({ status: "uploading", progress: fraction }),
          );
          applyFile(result.dto);
          update({ status: "done", progress: 1 });
        } catch (err) {
          update({ status: "error", error: err instanceof Error ? err.message : "upload failed" });
        }
      }
      await get().refreshUsage();
    },

    renameFile: async (id, name) => {
      const file = get().files.get(id);
      if (!file) {
        return;
      }
      const dto = await api.patchFile(id, {
        encryptedMeta: encryptFileMetadata(
          {
            name,
            mime: file.mime,
            size: file.size,
            mtime: file.mtime,
            width: file.width,
            height: file.height,
            text: file.text,
          },
          file.key,
        ),
      });
      applyFile(dto);
    },

    moveFile: async (id, folderId) => {
      const dto = await api.patchFile(id, { folderId });
      applyFile(dto);
    },

    trashFile: async (id) => {
      await api.trashFile(id);
      const files = new Map(get().files);
      const file = files.get(id);
      if (file) {
        files.set(id, { ...file, trashed: true });
        set({ files });
      }
    },

    restoreFile: async (id) => {
      await api.restoreFile(id);
      await get().refresh();
    },

    deleteForever: async (id) => {
      await api.deleteForever(id);
      const files = new Map(get().files);
      files.delete(id);
      set({ files });
      await get().refreshUsage();
    },

    clearFinishedUploads: () => {
      set({ uploads: get().uploads.filter((u) => u.status !== "done" && u.status !== "error") });
    },
  };
});
