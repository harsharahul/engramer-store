import { createHash } from "node:crypto";
import {
  ready,
  deriveKeyEncryptionKey,
  deriveLoginKey,
  secretBoxOpen,
  decryptBytes,
  decryptFileMetadata,
  decryptFolderMetadata,
  type KeyAttributes,
  type SecretBox,
} from "@engramer/crypto";

/**
 * A Node client for an Engram Store account, used inside the user's own trust
 * boundary. It logs in, unlocks the master key locally, syncs the encrypted
 * metadata, and decrypts blobs on demand. The server only ever sees ciphertext.
 */

interface FolderDto {
  id: string;
  parentId: string | null;
  encryptedKey: SecretBox;
  encryptedMeta: SecretBox;
  deleted: boolean;
  uploaded?: boolean;
}

interface FileDto {
  id: string;
  folderId: string | null;
  encryptedKey: SecretBox;
  encryptedMeta: SecretBox;
  size: number;
  uploaded: boolean;
  trashed: boolean;
  deleted: boolean;
  updatedAt: number;
}

export interface VaultFile {
  id: string;
  folderId: string | null;
  key: Uint8Array;
  name: string;
  mime: string;
  size: number;
  mtime: number;
}

export interface VaultFolder {
  id: string;
  parentId: string | null;
  name: string;
}

export class Vault {
  private token = "";
  private masterKey: Uint8Array = new Uint8Array();
  readonly folders = new Map<string, VaultFolder>();
  readonly files = new Map<string, VaultFile>();

  constructor(
    private readonly serverUrl: string,
    private readonly email: string,
    private readonly password: string,
  ) {}

  private url(path: string): string {
    return `${this.serverUrl.replace(/\/$/, "")}${path}`;
  }

  async connect(): Promise<void> {
    await ready();
    const attrRes = await fetch(
      this.url(`/api/auth/attributes?email=${encodeURIComponent(this.email)}`),
    );
    if (!attrRes.ok) {
      throw new Error(`could not fetch key attributes (${attrRes.status})`);
    }
    const { kdf } = (await attrRes.json()) as { kdf: KeyAttributes["kdf"] };
    const { kek } = deriveKeyEncryptionKey(this.password, kdf);
    const loginRes = await fetch(this.url("/api/auth/login"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: this.email, loginKey: deriveLoginKey(kek) }),
    });
    if (!loginRes.ok) {
      throw new Error("login failed: check email and password");
    }
    let login = (await loginRes.json()) as {
      token: string;
      keyAttributes: KeyAttributes;
      twoFactorRequired?: boolean;
      pendingToken?: string;
    };
    if (login.twoFactorRequired) {
      // Accounts with two-factor enabled provide the current authenticator
      // code (or a recovery code) through ENGRAM_TOTP.
      const code = process.env.ENGRAM_TOTP;
      if (!code) {
        throw new Error(
          "this account requires a second factor: set ENGRAM_TOTP to a current authenticator code",
        );
      }
      const twoFaRes = await fetch(this.url("/api/auth/2fa"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pendingToken: login.pendingToken, code }),
      });
      if (!twoFaRes.ok) {
        throw new Error("two-factor verification failed: check ENGRAM_TOTP");
      }
      login = (await twoFaRes.json()) as { token: string; keyAttributes: KeyAttributes };
    }
    this.token = login.token;
    this.masterKey = secretBoxOpen(login.keyAttributes.encryptedMasterKey, kek);
    await this.sync();
  }

  async sync(): Promise<void> {
    const res = await fetch(this.url("/api/sync?since=0"), {
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) {
      throw new Error(`sync failed (${res.status})`);
    }
    const body = (await res.json()) as { folders: FolderDto[]; files: FileDto[] };
    this.folders.clear();
    this.files.clear();
    for (const dto of body.folders) {
      if (dto.deleted) {
        continue;
      }
      const key = secretBoxOpen(dto.encryptedKey, this.masterKey);
      const meta = decryptFolderMetadata(dto.encryptedMeta, key);
      this.folders.set(dto.id, { id: dto.id, parentId: dto.parentId, name: meta.name });
    }
    for (const dto of body.files) {
      if (dto.deleted || dto.trashed || !dto.uploaded) {
        continue;
      }
      const key = secretBoxOpen(dto.encryptedKey, this.masterKey);
      const meta = decryptFileMetadata(dto.encryptedMeta, key);
      this.files.set(dto.id, {
        id: dto.id,
        folderId: dto.folderId,
        key,
        name: meta.name,
        mime: meta.mime,
        size: meta.size,
        mtime: meta.mtime,
      });
    }
  }

  /** Downloads and decrypts a file's content. */
  async read(file: VaultFile): Promise<Uint8Array> {
    const res = await fetch(this.url(`/api/files/${file.id}/data`), {
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) {
      throw new Error(`download failed (${res.status})`);
    }
    const ciphertext = new Uint8Array(await res.arrayBuffer());
    return decryptBytes(ciphertext, file.key);
  }
}

/** A weak ETag derived from stable file metadata (content stays encrypted). */
export function fileEtag(file: VaultFile): string {
  return createHash("md5").update(`${file.id}:${file.size}:${file.mtime}`).digest("hex");
}
