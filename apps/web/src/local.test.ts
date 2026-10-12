import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PackStatus } from "./api";

const start = vi.fn();
const packs = vi.fn();
vi.mock("./api", () => ({
  api: {
    localPackStart: (name: string) => start(name),
    localPacks: () => packs(),
  },
}));

const {
  downloadPack,
  defaultDeviceLabel,
  packDisplayName,
  packGate,
  packPromptTitle,
  packPromptBody,
  LOCAL_ACCOUNT,
  NEEDS_SERVER,
} = await import("./local");

function status(state: PackStatus["state"], downloaded: number, error: string | null = null): PackStatus {
  return { state, archiveBytes: 94_429_296, installedBytes: 247_345_551, downloadedBytes: downloaded, error };
}

function hooks() {
  return { begin: vi.fn(), update: vi.fn(), end: vi.fn() };
}

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

  it("does nothing more for a pack that is already installed", async () => {
    start.mockResolvedValueOnce({ packs: { office: status("installed", 94_429_296) } });
    const h = hooks();
    await downloadPack("office", h);
    expect(h.begin).not.toHaveBeenCalled();
    expect(packs).not.toHaveBeenCalled();
  });
});
