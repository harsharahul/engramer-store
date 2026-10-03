import { createHash } from "node:crypto";
import {
  ready,
  deriveKeyEncryptionKey,
  deriveLoginKey,
  secretBoxOpen,
  decryptContent,
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

/** Renew once a token has served a day. A bridge runs for months; the
 * server's tokens end at thirty days, and a renewed one is minted at
 * the same epoch so nothing else changes. */
const RENEW_AFTER_MS = 24 * 3600 * 1000;

export class Vault {
  private token = "";
  /** When the current token was obtained, by sign-in or renewal. */
  private tokenObtainedAt = 0;
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
    await this.login();
    await this.sync();
  }

  /**
   * Signs in with the password and unlocks the master key locally. Also
   * the answer to a refused token: a session ended elsewhere ("sign out
   * everywhere", a password change) comes back through the password this
   * process already holds. An account with a second factor cannot sign
   * in again unattended, since ENGRAM_TOTP was one code; the error says
   * which of the two it was.
   */
  private async login(): Promise<void> {
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
    this.tokenObtainedAt = Date.now();
    this.masterKey = secretBoxOpen(login.keyAttributes.encryptedMasterKey, kek);
  }

  private send(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(this.url(path), {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${this.token}` },
    });
  }

  /**
   * A fresh token for a session still standing. A refusal here is left
   * to the request that follows: it will be a 401, and that signs in
   * again with the password.
   */
  private async renew(): Promise<void> {
    const res = await this.send("/api/auth/refresh", { method: "POST" });
    if (res.ok) {
      this.token = ((await res.json()) as { token: string }).token;
      this.tokenObtainedAt = Date.now();
    }
  }

  /**
   * An authorized request. The token renews once it has served a day,
   * and a refused one is answered with one fresh sign-in and a retry, so
   * a bridge left running never dies at the end of the token it started
   * with, and a session revoked elsewhere recovers on the next request.
   */
  private async authorized(path: string, init: RequestInit = {}): Promise<Response> {
    if (Date.now() - this.tokenObtainedAt > RENEW_AFTER_MS) {
      await this.renew();
    }
    const first = await this.send(path, init);
    if (first.status !== 401) {
      return first;
    }
    await this.login();
    return this.send(path, init);
  }

  async sync(): Promise<void> {
    const res = await this.authorized("/api/sync?since=0");
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
    const res = await this.authorized(`/api/files/${file.id}/data`);
    if (!res.ok) {
      throw new Error(`download failed (${res.status})`);
    }
    const ciphertext = new Uint8Array(await res.arrayBuffer());
    return decryptContent(ciphertext, file.key);
  }
}

/** A weak ETag derived from stable file metadata (content stays encrypted). */
export function fileEtag(file: VaultFile): string {
  return createHash("md5").update(`${file.id}:${file.size}:${file.mtime}`).digest("hex");
}
