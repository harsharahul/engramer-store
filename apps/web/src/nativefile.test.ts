import { describe, expect, it } from "vitest";
import { NativePickedFile, materializeForAnalysis } from "./nativefile";

/**
 * A picked video used to cross the shell bridge whole: one read call, the
 * entire file serialized through the IPC and copied again into a
 * memory-backed File. A 30-second clip was several hundred megabytes
 * resident before the first uploaded byte, and iOS killed the app. These
 * tests pin the replacement: a handle that reads bounded windows on
 * demand and never holds more than one of them.
 */

const WINDOW = 4 * 1024 * 1024;

/** A fake shell: serves ranged reads from a deterministic buffer. */
function fakeShell(bytes: Uint8Array, opts?: { shortReads?: boolean; asArrays?: boolean }) {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  const invoke = async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args: args ?? {} });
    if (cmd === "picked_file_read_range") {
      const offset = args?.offset as number;
      const length = args?.length as number;
      let window = bytes.slice(offset, offset + length);
      if (opts?.shortReads && window.length > 8) {
        window = window.slice(0, 8);
      }
      return opts?.asArrays ? Array.from(window) : window;
    }
    if (cmd === "picked_file_delete") {
      return null;
    }
    throw new Error(`unexpected command ${cmd}`);
  };
  return { invoke, calls };
}

function sourceBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    bytes[i] = (i * 31 + 7) % 256;
  }
  return bytes;
}

function picked(shell: ReturnType<typeof fakeShell>, size: number, name = "clip.mov") {
  return new NativePickedFile(shell.invoke, `/tmp/engram-picked/${name}`, {
    name,
    type: "video/quicktime",
    size,
    lastModified: 1_754_700_000_000,
  });
}

describe("NativePickedFile", () => {
  it("reads exactly the asked-for window per slice", async () => {
    const bytes = sourceBytes(64);
    const shell = fakeShell(bytes);
    const file = picked(shell, 64);
    const read = new Uint8Array(await file.slice(2, 7).arrayBuffer());
    expect(read).toEqual(bytes.slice(2, 7));
    const ranged = shell.calls.filter((c) => c.cmd === "picked_file_read_range");
    expect(ranged).toHaveLength(1);
    expect(ranged[0]!.args).toMatchObject({ offset: 2, length: 5 });
  });

  it("clamps a slice past the end, like a Blob does", async () => {
    const bytes = sourceBytes(10);
    const shell = fakeShell(bytes);
    const slice = picked(shell, 10).slice(8, 99);
    expect(slice.size).toBe(2);
    expect(new Uint8Array(await slice.arrayBuffer())).toEqual(bytes.slice(8, 10));
  });

  it("assembles a whole file from bounded windows, byte-exact", async () => {
    const size = 9 * 1024 * 1024 + 3;
    const bytes = sourceBytes(size);
    const shell = fakeShell(bytes);
    const whole = new Uint8Array(await picked(shell, size).arrayBuffer());
    expect(whole.length).toBe(size);
    expect(whole).toEqual(bytes);
    const ranged = shell.calls.filter((c) => c.cmd === "picked_file_read_range");
    expect(ranged.length).toBeGreaterThanOrEqual(3);
    for (const call of ranged) {
      expect(call.args.length as number).toBeLessThanOrEqual(WINDOW);
    }
  });

  it("survives the eval transport's number arrays", async () => {
    const bytes = sourceBytes(32);
    const shell = fakeShell(bytes, { asArrays: true });
    expect(new Uint8Array(await picked(shell, 32).slice(0, 32).arrayBuffer())).toEqual(bytes);
  });

  it("refuses a short read instead of storing wrong bytes", async () => {
    const shell = fakeShell(sourceBytes(64), { shortReads: true });
    await expect(picked(shell, 64).arrayBuffer()).rejects.toThrow(/bytes/);
  });

  it("deletes the staged file once, however often it is asked", async () => {
    const shell = fakeShell(sourceBytes(8));
    const file = picked(shell, 8);
    await file.dispose();
    await file.dispose();
    expect(shell.calls.filter((c) => c.cmd === "picked_file_delete")).toHaveLength(1);
  });

  it("serves media elements from the picked protocol", () => {
    const shell = fakeShell(sourceBytes(8));
    const file = picked(shell, 8, "clip one.mov");
    expect(file.mediaUrl).toBe("picked://localhost/clip%20one.mov");
  });
});

describe("materializeForAnalysis", () => {
  it("turns an image handle into a real File and cleans up its staging", async () => {
    const bytes = sourceBytes(1024);
    const shell = fakeShell(bytes);
    const handle = new NativePickedFile(shell.invoke, "/tmp/engram-picked/IMG_1.HEIC", {
      name: "IMG_1.HEIC",
      type: "image/heic",
      size: 1024,
      lastModified: 5,
    });
    const local = await materializeForAnalysis(handle);
    expect(local).toBeInstanceOf(File);
    expect(local.name).toBe("IMG_1.HEIC");
    expect(new Uint8Array(await local.arrayBuffer())).toEqual(bytes);
    expect(shell.calls.filter((c) => c.cmd === "picked_file_delete")).toHaveLength(1);
  });

  it("leaves videos as streamed handles: decoders take a URL, not a buffer", async () => {
    const shell = fakeShell(sourceBytes(64));
    const handle = picked(shell, 64);
    expect(await materializeForAnalysis(handle)).toBe(handle);
    expect(shell.calls.filter((c) => c.cmd === "picked_file_read_range")).toHaveLength(0);
  });

  it("passes a real File straight through", async () => {
    const file = new File([new Uint8Array(4)], "p.jpg", { type: "image/jpeg" });
    expect(await materializeForAnalysis(file)).toBe(file);
  });
});
