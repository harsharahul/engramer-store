// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * On a vault kept on this device the sign-in screen has one account and no
 * server: it offers to create the vault or to unlock it with the passphrase
 * alone, hides the address and the recovery path, and names the device.
 */

const registration = vi.fn();
vi.mock("../api", () => ({
  api: { registration: () => registration(), setDisplayName: vi.fn() },
  ApiError: class ApiError extends Error {},
}));
vi.mock("../native", () => ({ nativeShell: () => true, nativeServerUrlSet: vi.fn() }));
vi.mock("../store", () => ({ useStore: (select: (s: unknown) => unknown) => select({ startSession: vi.fn() }) }));

const { Auth } = await import("./Auth");

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  if (!window.matchMedia) {
    window.matchMedia = () =>
      ({ matches: false, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList;
  }
});

beforeEach(() => {
  registration.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render() {
  await act(async () => {
    root.render(<Auth />);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe("the sign-in screen for a vault on this device", () => {
  it("offers to create the vault with a passphrase alone", async () => {
    registration.mockResolvedValue({ mode: "open", macAppUrl: null, local: true, vault: "empty" });
    await render();
    expect(container.textContent).toContain("Create your vault");
    expect(container.querySelector("#email")).toBeNull();
    expect(container.querySelector("#password")).not.toBeNull();
    expect(container.querySelector("#confirm")).not.toBeNull();
    expect(container.textContent).toContain("Confirm passphrase");
    expect(container.textContent).toContain("Your passphrase is the only way into this vault.");
    expect(container.textContent).not.toContain("Forgot your password?");
    expect(container.textContent).toContain("This device");
    expect(container.textContent).not.toContain("Server:");
  });

  it("offers to unlock an existing vault", async () => {
    registration.mockResolvedValue({ mode: "open", macAppUrl: null, local: true, vault: "created" });
    await render();
    expect(container.textContent).toContain("Unlock your vault");
    expect(container.querySelector("#email")).toBeNull();
    expect(container.querySelector("#confirm")).toBeNull();
    expect(container.textContent).not.toContain("Create a vault");
    expect(container.textContent).not.toContain("Forgot your password?");
  });

  it("keeps the server form for a server", async () => {
    registration.mockResolvedValue({ mode: "open", macAppUrl: null });
    await render();
    expect(container.querySelector("#email")).not.toBeNull();
    expect(container.textContent).toContain("Forgot your password?");
    expect(container.textContent).toContain("Server:");
    expect(container.textContent).not.toContain("Unlock your vault");
  });
});
