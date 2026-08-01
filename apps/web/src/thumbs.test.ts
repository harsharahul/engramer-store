import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./transfer", () => ({
  downloadThumbnail: vi.fn(),
  retryDelay: () => 0,
  whenOnline: () => Promise.resolve(),
}));

import { downloadThumbnail } from "./transfer";
import { clearThumbnailCache, thumbnailUrl } from "./thumbs";

const download = vi.mocked(downloadThumbnail);
const key = new Uint8Array(32);

beforeEach(() => {
  download.mockReset();
  let serial = 0;
  URL.createObjectURL = vi.fn(() => `blob:thumb-${serial++}`);
  URL.revokeObjectURL = vi.fn();
  clearThumbnailCache();
});

describe("thumbnailUrl", () => {
  it("caches a successful fetch and shares it across callers", async () => {
    download.mockResolvedValue(new Uint8Array([1, 2, 3]));
    const [first, second] = await Promise.all([thumbnailUrl("file-a", key), thumbnailUrl("file-a", key)]);
    expect(first).toBe("blob:thumb-0");
    expect(second).toBe(first);
    expect(download).toHaveBeenCalledTimes(1);
    expect(await thumbnailUrl("file-a", key)).toBe(first);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it("retries a failing fetch before giving up", async () => {
    download.mockRejectedValue(new Error("gateway timeout"));
    expect(await thumbnailUrl("file-b", key)).toBeNull();
    expect(download).toHaveBeenCalledTimes(4);
  });

  it("never pins a failure: the next look starts over and can succeed", async () => {
    download.mockRejectedValue(new Error("deploy blip"));
    expect(await thumbnailUrl("file-c", key)).toBeNull();
    download.mockResolvedValue(new Uint8Array([9, 9, 9]));
    expect(await thumbnailUrl("file-c", key)).toMatch(/^blob:thumb-/);
    expect(download).toHaveBeenCalledTimes(5);
  });
});
