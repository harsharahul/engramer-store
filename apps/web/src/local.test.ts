import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectStatus, PackStatus } from "./api";

const start = vi.fn();
const packs = vi.fn();
const connectStart = vi.fn();
const connect = vi.fn();
vi.mock("./api", () => ({
  api: {
    localPackStart: (name: string) => start(name),
    localPacks: () => packs(),
    localConnectStart: (body: unknown) => connectStart(body),
    localConnect: () => connect(),
  },
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));
vi.mock("./accountdeletion", () => ({
  deletionProof: (passphrase: string) => {
    if (passphrase !== "right") {
      throw new Error("That is not your password.");
    }
    return "LOGIN-KEY";
  },
}));

const {
  downloadPack,
  defaultDeviceLabel,
  packDisplayName,
  packGate,
  packPromptTitle,
  packPromptBody,
  packDownloading,
  connectSentence,
  followConnect,
  loginKeyFor,
  LOCAL_ACCOUNT,
  NEEDS_SERVER,
} = await import("./local");

function connecting(step: ConnectStatus["step"], patch: Partial<ConnectStatus> = {}): ConnectStatus {
  return {
    running: step !== "done" && step !== "failed" && step !== null,
    server: "https://vault.example.com",
    host: "vault.example.com",
    email: "alice@example.com",
    step,
    foldersDone: 0,
    foldersTotal: 0,
    filesDone: 0,
    filesTotal: 0,
    bytesDone: 0,
    bytesTotal: 0,
    verified: null,
    error: null,
    ...patch,
  };
}

function status(state: PackStatus["state"], downloaded: number, error: string | null = null): PackStatus {
  return { state, archiveBytes: 94_429_296, installedBytes: 247_345_551, downloadedBytes: downloaded, error };
}

function hooks() {
  return { begin: vi.fn(), update: vi.fn(), end: vi.fn() };
}

describe("connecting the vault to a server", () => {
  beforeEach(() => {
    connectStart.mockReset();
    connect.mockReset();
  });

  it("derives the login key only for the vault's passphrase", () => {
    const attributes = {} as Parameters<typeof loginKeyFor>[1];
    expect(loginKeyFor("right", attributes)).toBe("LOGIN-KEY");
    expect(() => loginKeyFor("wrong", attributes)).toThrow("That is not your passphrase.");
  });

  it("turns where the copy stands into one sentence", () => {
    expect(connectSentence(connecting(null))).toBe("");
    expect(connectSentence(connecting("reaching"))).toBe("Reaching vault.example.com…");
    expect(connectSentence(connecting("folders", { foldersDone: 2, foldersTotal: 5 }))).toBe("Folders: 2 of 5.");
    expect(
      connectSentence(
        connecting("files", { filesDone: 3, filesTotal: 12, bytesDone: 40_000_000, bytesTotal: 94_429_296 }),
      ),
    ).toBe("Files: 3 of 12 · 38.1 MB of 90.1 MB.");
    expect(
      connectSentence(
        connecting("done", { verified: { folders: 5, files: 12, bytes: 94_429_296, checked: 12, problems: [] } }),
      ),
    ).toBe("Verified: 5 folders, 12 files, 90.1 MB on vault.example.com; the server read every file back.");
    expect(
      connectSentence(connecting("done", { verified: { folders: 1, files: 1, bytes: 176, checked: 1, problems: [] } })),
    ).toBe("Verified: 1 folder, 1 file, 176 B on vault.example.com; the server read every file back.");
    expect(connectSentence(connecting("failed", { error: "could not reach vault.example.com" }))).toBe(
      "Not connected: could not reach vault.example.com.",
    );
    expect(connectSentence(connecting("failed", { error: "stopped" }))).toBe(
      "Stopped. Connect again to continue where it left off.",
    );
  });

  it("follows the copy in Activity to a verified end", async () => {
    const request = { server: "vault.example.com", email: "alice@example.com", loginKey: "LOGIN-KEY", create: true };
    connectStart.mockResolvedValueOnce(connecting("reaching"));
    connect
      .mockResolvedValueOnce(connecting("files", { filesDone: 1, filesTotal: 2, bytesDone: 10, bytesTotal: 20 }))
      .mockResolvedValueOnce(
        connecting("done", { filesDone: 2, filesTotal: 2, verified: { folders: 1, files: 2, bytes: 20, checked: 2, problems: [] } }),
      );
    const h = { ...hooks(), status: vi.fn() };
    const status = await followConnect(request, h, { sleep: async () => {} });
    expect(connectStart).toHaveBeenCalledWith(request);
    expect(status.step).toBe("done");
    // Every answer from the backend reaches the row, not only the last one.
    expect(h.status.mock.calls.map((call) => call[0].step)).toEqual(["reaching", "files", "done"]);
    expect(h.begin).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "connecting", title: "Connecting to vault.example.com", current: "Reaching vault.example.com…" }),
    );
    expect(h.update.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ done: 1, total: 2, current: "Files: 1 of 2 · 10 B of 20 B." }));
    expect(h.end).toHaveBeenCalledWith(
      expect.objectContaining({ detail: "Verified: 1 folder, 2 files, 20 B on vault.example.com; the server read every file back." }),
    );
  });

  it("says why a copy did not verify, and joins one already running", async () => {
    const request = { server: "vault.example.com", email: "alice@example.com", loginKey: "LOGIN-KEY", create: false };
    const { ApiError } = await import("./api");
    connectStart.mockRejectedValueOnce(new ApiError(409, "a copy is already running"));
    connect
      .mockResolvedValueOnce(connecting("verifying"))
      .mockResolvedValueOnce(connecting("failed", { error: "the account alice@example.com at vault.example.com already holds 3 folders and 9 files; connect an empty account" }));
    const h = hooks();
    await expect(followConnect(request, h, { sleep: async () => {} })).rejects.toThrow("already holds 3 folders and 9 files");
    expect(h.begin).toHaveBeenCalledTimes(1);
    expect(h.end).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.stringContaining("Not connected: the account alice@example.com") }),
    );
  });

  it("does not follow a running copy to another server as its own", async () => {
    const request = { server: "other.example.com", email: "alice@example.com", loginKey: "LOGIN-KEY", create: true };
    const { ApiError } = await import("./api");
    connectStart.mockRejectedValueOnce(new ApiError(409, "a copy is already running"));
    connect.mockResolvedValueOnce(connecting("files"));
    const h = hooks();
    await expect(followConnect(request, h, { sleep: async () => {} })).rejects.toThrow(
      "a copy to vault.example.com is already running; stop it first",
    );
    expect(h.begin).not.toHaveBeenCalled();
  });
});

describe("local mode", () => {
  beforeEach(() => {
    start.mockReset();
    packs.mockReset();
  });

  it("names the account once and the device by its kind", () => {
    expect(LOCAL_ACCOUNT).toBe("vault@this.device");
    expect(["This Mac", "This iPhone", "This iPad"]).toContain(defaultDeviceLabel());
    expect(NEEDS_SERVER).toBe("needs a server");
  });

  it("gates an entry point on its pack's state", () => {
    const vault = { bytes: 1, directory: "/v" };
    expect(packGate(null, "office")).toBe("run");
    expect(packGate({ packs: {}, vault }, "office")).toBe("run");
    expect(packGate({ packs: { office: "installed" }, vault }, "office")).toBe("run");
    expect(packGate({ packs: { office: "downloading" }, vault }, "office")).toBe("wait");
    expect(packGate({ packs: { office: "missing" }, vault }, "office")).toBe("ask");
    expect(packGate({ packs: { office: "missing" }, vault }, "intelligence")).toBe("run");
  });

  it("asks with the manifest's size, never a constant", () => {
    expect(packPromptTitle("office", 94_429_296)).toBe("Download the office editor (90.1 MB)?");
    expect(packPromptTitle("intelligence", 216_489_154)).toBe("Download on-device intelligence (206 MB)?");
    expect(packPromptBody("office")).toContain("Nothing about your vault leaves this device.");
    expect(packPromptBody("intelligence")).toContain("Search by meaning");
    expect(packDisplayName("office")).toBe("Office editor");
    expect(packDisplayName("intelligence")).toBe("On-device intelligence");
  });

  it("follows a download in Activity until the pack is installed", async () => {
    start.mockResolvedValueOnce({ packs: { office: status("downloading", 0) } });
    packs
      .mockResolvedValueOnce({ packs: { office: status("downloading", 40_000_000) } })
      .mockResolvedValueOnce({ packs: { office: status("installed", 94_429_296) } });
    const h = hooks();
    await downloadPack("office", h, { sleep: async () => {} });
    expect(start).toHaveBeenCalledWith("office");
    expect(h.begin).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "downloading", title: "Downloading the office editor", done: 0, total: 90 }),
    );
    expect(h.update).toHaveBeenLastCalledWith(expect.objectContaining({ done: 90, total: 90 }));
    expect(h.update.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ done: 38, current: "38.1 MB of 90.1 MB" }));
    expect(h.end).toHaveBeenCalledWith(
      expect.objectContaining({ detail: "The office editor is ready. 236 MB on this device." }),
    );
  });

  it("says the backend's sentence when a download does not install", async () => {
    start.mockResolvedValueOnce({ packs: { office: status("downloading", 0) } });
    packs.mockResolvedValueOnce({
      packs: { office: status("missing", 12_000, "the download did not match its checksum; it was discarded") },
    });
    const h = hooks();
    await expect(downloadPack("office", h, { sleep: async () => {} })).rejects.toThrow(
      "the download did not match its checksum; it was discarded",
    );
    expect(h.end).toHaveBeenCalledWith(
      expect.objectContaining({ detail: "Not installed: the download did not match its checksum; it was discarded." }),
    );
  });

  it("ends the job when the download cannot be followed", async () => {
    start.mockResolvedValueOnce({ packs: { office: status("downloading", 0) } });
    packs.mockRejectedValueOnce(new Error("Failed to fetch"));
    const h = hooks();
    await expect(downloadPack("office", h, { sleep: async () => {} })).rejects.toThrow("Failed to fetch");
    expect(h.end).toHaveBeenCalledTimes(1);
    expect(h.end).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: "Lost track of the download: Failed to fetch. The Profile row shows where it stands.",
      }),
    );
  });

  it("joins a download that is already running instead of starting a second", async () => {
    start.mockResolvedValueOnce({ packs: { office: status("downloading", 0) } });
    packs.mockResolvedValueOnce({ packs: { office: status("installed", 94_429_296) } });
    const h = hooks();
    expect(packDownloading("office")).toBe(false);
    const first = downloadPack("office", h, { sleep: async () => {} });
    const second = downloadPack("office", hooks(), { sleep: async () => {} });
    expect(packDownloading("office")).toBe(true);
    await Promise.all([first, second]);
    expect(start).toHaveBeenCalledTimes(1);
    expect(h.begin).toHaveBeenCalledTimes(1);
    expect(h.end).toHaveBeenCalledTimes(1);
    expect(packDownloading("office")).toBe(false);
  });

  it("does nothing more for a pack that is already installed", async () => {
    start.mockResolvedValueOnce({ packs: { office: status("installed", 94_429_296) } });
    const h = hooks();
    await downloadPack("office", h);
    expect(h.begin).not.toHaveBeenCalled();
    expect(packs).not.toHaveBeenCalled();
  });
});
