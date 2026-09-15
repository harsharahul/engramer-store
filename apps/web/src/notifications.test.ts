import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { notificationsEnabled, notifyDue, resetNotificationSession, setNotificationsEnabled, type NotificationTransport } from "./notifications";
import type { Notice } from "./notices";

beforeAll(() => {
  const backing = new Map<string, string>();
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, String(v)),
    removeItem: (k: string) => void backing.delete(k),
    clear: () => backing.clear(),
    key: (i: number) => [...backing.keys()][i] ?? null,
    get length() {
      return backing.size;
    },
  } as Storage;
});

beforeEach(() => {
  localStorage.clear();
  resetNotificationSession();
});

type Rig = NotificationTransport & {
  asked: number;
  sent: Array<{ title: string; body: string }>;
  state: "granted" | "denied" | "prompt";
};

function rig(initial: "granted" | "denied" | "prompt", afterAsk: "granted" | "denied" = "granted"): Rig {
  const transport: Rig = {
    asked: 0,
    sent: [],
    state: initial,
    async permission() {
      return transport.state;
    },
    async request() {
      transport.asked += 1;
      transport.state = afterAsk;
      return transport.state;
    },
    async send(title: string, body: string) {
      transport.sent.push({ title, body });
    },
  };
  return transport;
}

const due: Notice[] = [
  { key: "fact:f3:c", title: "Payment due 7 Sep 2026", body: "invoice.pdf", fileId: "f3", severity: "overdue" },
  { key: "fact:f1:a", title: "Expires 22 Sep 2026", body: "insurance.pdf", fileId: "f1", severity: "soon" },
];

describe("the per-device switch", () => {
  it("is on until turned off", () => {
    expect(notificationsEnabled()).toBe(true);
    setNotificationsEnabled(false);
    expect(notificationsEnabled()).toBe(false);
  });
});

describe("notifyDue", () => {
  it("asks for permission the first time there is something to say, then says it once", async () => {
    const transport = rig("prompt");
    expect(await notifyDue("a@example.com", due, transport)).toBe(2);
    expect(transport.asked).toBe(1);
    expect(transport.sent.map((n) => n.body)).toEqual(["invoice.pdf", "insurance.pdf"]);
    expect(await notifyDue("a@example.com", due, transport)).toBe(0);
    expect(transport.sent).toHaveLength(2);
  });

  it("asks nothing when there is nothing due", async () => {
    const transport = rig("prompt");
    expect(await notifyDue("a@example.com", [], transport)).toBe(0);
    expect(transport.asked).toBe(0);
  });

  it("stays quiet once denied, and does not ask again this session", async () => {
    const transport = rig("prompt", "denied");
    expect(await notifyDue("a@example.com", due, transport)).toBe(0);
    expect(await notifyDue("a@example.com", due, transport)).toBe(0);
    expect(transport.asked).toBe(1);
    expect(transport.sent).toHaveLength(0);
  });

  it("does nothing with the switch off, and forgets nothing", async () => {
    setNotificationsEnabled(false);
    const transport = rig("granted");
    expect(await notifyDue("a@example.com", due, transport)).toBe(0);
    setNotificationsEnabled(true);
    expect(await notifyDue("a@example.com", due, transport)).toBe(2);
  });
});
