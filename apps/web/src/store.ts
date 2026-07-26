import { create } from "zustand";
import {
  decryptFileMetadata,
  decryptFolderMetadata,
  encryptBytes,
  encryptFileMetadata,
  encryptFolderMetadata,
  encryptJson,
  generateKey,
  openSealed,
  secretBoxOpen,
  secretBoxSeal,
  utf8Encode,
  type FileMetadata,
} from "@engramer/crypto";
import { api, uploadBlob, type FileDto, type FolderDto } from "./api";
import { clearSession, type Session } from "./session";
import { analyzeFile, encryptAndUpload } from "./transfer";

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
  category?: string;
  tags: string[];
  favorite: boolean;
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

export interface RevealItem {
  fileId: string;
  name: string;
  category: string;
  folderId: string | null;
  folderName: string | null;
  tags: string[];
}

export interface Reveal {
  items: RevealItem[];
  at: number;
}

interface StoreState {
  session: Session | null;
  synced: boolean;
  folders: Map<string, FolderEntry>;
  files: Map<string, FileEntry>;
  usage: Usage | null;
  uploads: UploadItem[];
  reveal: Reveal | null;

  startSession: (session: Session) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
  refreshUsage: () => Promise<void>;
  createFolder: (name: string, parentId: string | null) => Promise<void>;
  renameFolder: (id: string, name: string) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;
  uploadFiles: (files: File[], folderId: string | null) => Promise<void>;
  saveFileContent: (id: string, text: string) => Promise<void>;
  createNote: (name: string, folderId: string | null) => Promise<string>;
  renameFile: (id: string, name: string) => Promise<void>;
  setTags: (id: string, tags: string[]) => Promise<void>;
  toggleFavorite: (id: string) => Promise<void>;
  moveFile: (id: string, folderId: string | null) => Promise<void>;
  trashFile: (id: string) => Promise<void>;
  restoreFile: (id: string) => Promise<void>;
  deleteForever: (id: string) => Promise<void>;
  clearFinishedUploads: () => void;
  dismissReveal: () => void;
  createFileRequest: (label: string, folderId: string | null, expiresAt: number | null) => Promise<string>;
  ingestRequestUploads: () => Promise<number>;
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
    category: meta.category,
    tags: meta.tags ?? [],
    favorite: meta.favorite ?? false,
    key,
    hasThumb: dto.thumbSize > 0,
    trashed: dto.trashed,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
  };
}

function metadataOf(file: FileEntry): FileMetadata {
  return {
    name: file.name,
    mime: file.mime,
    size: file.size,
    mtime: file.mtime,
    width: file.width,
    height: file.height,
    text: file.text,
    category: file.category,
    tags: file.tags,
    favorite: file.favorite,
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

  const patchFileMeta = async (id: string, patch: Partial<FileMetadata>) => {
    const file = get().files.get(id);
    if (!file) {
      return;
    }
    const dto = await api.patchFile(id, {
      encryptedMeta: encryptFileMetadata({ ...metadataOf(file), ...patch }, file.key),
    });
    applyFile(dto);
  };

  /** Find or create a root folder for a category. Deduplicates concurrent creates. */
  const categoryFolderPromises = new Map<string, Promise<string>>();
  const ensureCategoryFolder = (name: string): Promise<string> => {
    for (const folder of get().folders.values()) {
      if (folder.parentId === null && folder.name === name) {
        return Promise.resolve(folder.id);
      }
    }
    let pending = categoryFolderPromises.get(name);
    if (!pending) {
      pending = (async () => {
        const folderKey = generateKey();
        const dto = await api.createFolder(
          null,
          secretBoxSeal(folderKey, masterKey()),
          encryptFolderMetadata({ name }, folderKey),
        );
        applyFolder(dto);
        categoryFolderPromises.delete(name);
        return dto.id;
      })();
      categoryFolderPromises.set(name, pending);
    }
    return pending;
  };

  return {
    session: null,
    synced: false,
    folders: new Map(),
    files: new Map(),
    usage: null,
    uploads: [],
    reveal: null,

    startSession: async (session) => {
      set({
        session,
        synced: false,
        folders: new Map(),
        files: new Map(),
        uploads: [],
        reveal: null,
      });
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
        reveal: null,
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
      // Anything that arrived through a file request gets filed automatically.
      await get().ingestRequestUploads().catch(() => 0);
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
      const revealItems: RevealItem[] = [];
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
          const prepared = await analyzeFile(file);
          // Root uploads are auto-filed into a category folder; uploads into a
          // folder the user picked stay where the user put them.
          const destination =
            folderId ?? (await ensureCategoryFolder(prepared.analysis.category));
          const result = await encryptAndUpload(file, destination, key, prepared, (fraction) =>
            update({ status: "uploading", progress: fraction }),
          );
          applyFile(result.dto);
          update({ status: "done", progress: 1 });
          revealItems.push({
            fileId: result.dto.id,
            name: file.name,
            category: prepared.analysis.category,
            folderId: destination,
            folderName: destination ? (get().folders.get(destination)?.name ?? null) : null,
            tags: prepared.analysis.tags,
          });
        } catch (err) {
          update({ status: "error", error: err instanceof Error ? err.message : "upload failed" });
        }
      }
      if (revealItems.length > 0) {
        set({ reveal: { items: revealItems, at: Date.now() } });
      }
      await get().refreshUsage();
    },

    // In-app editing: re-encrypt with the file's existing key and replace the
    // blob, then refresh the metadata (size, mtime, search text) in one patch.
    saveFileContent: async (id, text) => {
      const file = get().files.get(id);
      if (!file) {
        throw new Error("file not found");
      }
      const bytes = utf8Encode(text);
      await uploadBlob(id, "data", encryptBytes(bytes, file.key));
      await patchFileMeta(id, {
        size: bytes.length,
        mtime: Date.now(),
        text: text.slice(0, 100_000),
      });
      await get().refreshUsage();
    },

    createNote: async (name, folderId) => {
      const fileName = /\.(md|txt)$/i.test(name) ? name : `${name}.md`;
      const fileKey = generateKey();
      const meta: FileMetadata = {
        name: fileName,
        mime: "text/markdown",
        size: 0,
        mtime: Date.now(),
        category: "Notes",
        tags: ["notes", "md", String(new Date().getFullYear())],
        text: "",
      };
      const dto = await api.createFile(
        folderId,
        secretBoxSeal(fileKey, masterKey()),
        encryptFileMetadata(meta, fileKey),
      );
      await uploadBlob(dto.id, "data", encryptBytes(new Uint8Array(0), fileKey));
      applyFile({ ...dto, uploaded: true });
      return dto.id;
    },

    renameFile: async (id, name) => patchFileMeta(id, { name }),

    setTags: async (id, tags) =>
      patchFileMeta(id, { tags: [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))] }),

    toggleFavorite: async (id) => {
      const file = get().files.get(id);
      if (!file) {
        return;
      }
      // Optimistic flip so the star answers instantly.
      const files = new Map(get().files);
      files.set(id, { ...file, favorite: !file.favorite });
      set({ files });
      try {
        await patchFileMeta(id, { favorite: !file.favorite });
      } catch {
        const rollback = new Map(get().files);
        rollback.set(id, file);
        set({ files: rollback });
      }
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

    dismissReveal: () => set({ reveal: null }),

    createFileRequest: async (label, folderId, expiresAt) => {
      const { token } = await api.createFileRequest(
        folderId,
        encryptJson({ label }, masterKey()),
        expiresAt,
      );
      return token;
    },

    /**
     * Files every pending request upload into the vault: unseal the file key
     * with the account key pair, re-wrap it under the master key, accept. The
     * sender's device already computed metadata, thumbnail, and search text.
     */
    ingestRequestUploads: async () => {
      const session = get().session;
      if (!session) {
        return 0;
      }
      const { uploads } = await api.listRequestUploads();
      const revealItems: RevealItem[] = [];
      for (const upload of uploads) {
        try {
          const fileKey = openSealed(upload.sealedKey, session.publicKey, session.privateKey);
          const meta = decryptFileMetadata(upload.encryptedMeta, fileKey);
          const dto = await api.acceptRequestUpload(
            upload.id,
            secretBoxSeal(fileKey, session.masterKey),
            encryptFileMetadata(meta, fileKey),
          );
          applyFile(dto);
          revealItems.push({
            fileId: dto.id,
            name: meta.name,
            category: meta.category ?? "Other",
            folderId: dto.folderId,
            folderName: dto.folderId ? (get().folders.get(dto.folderId)?.name ?? null) : null,
            tags: meta.tags ?? [],
          });
        } catch {
          // Another tab may have filed it first, or the seal does not match;
          // either way this upload stays pending rather than blocking the rest.
        }
      }
      if (revealItems.length > 0) {
        set({ reveal: { items: revealItems, at: Date.now() } });
        await get().refreshUsage();
      }
      return revealItems.length;
    },
  };
});
