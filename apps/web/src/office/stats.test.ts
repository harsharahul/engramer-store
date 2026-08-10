import { describe, expect, it } from "vitest";
import {
  describeCollabStats,
  newCollabStats,
  noteAck,
  noteEphReceived,
  noteEphSent,
  notePost,
} from "./stats";

describe("collab stats", () => {
  it("measures the time from a posted change to its ack", () => {
    const s = newCollabStats();
    notePost(s, 1, 1000);
    notePost(s, 2, 1100);
    noteAck(s, 1, 1250);
    noteAck(s, 2, 1700);
    expect(s.chgPosted).toBe(2);
    expect(s.chgAcked).toBe(2);
    expect(s.ackLatency.count).toBe(2);
    expect(s.ackLatency.totalMs).toBe(850);
    expect(s.ackLatency.maxMs).toBe(600);
    expect(s.ackLatency.lastMs).toBe(600);
  });

  it("ignores an ack it never saw posted", () => {
    const s = newCollabStats();
    noteAck(s, 9, 1000);
    expect(s.chgAcked).toBe(0);
    expect(s.ackLatency.count).toBe(0);
  });

  it("counts ephemeral frames per sender", () => {
    const s = newCollabStats();
    noteEphSent(s);
    noteEphSent(s);
    noteEphReceived(s, "conn-a");
    noteEphReceived(s, "conn-a");
    noteEphReceived(s, "conn-b");
    expect(s.ephSent).toBe(2);
    expect(s.ephReceivedBySender.get("conn-a")).toBe(2);
    expect(s.ephReceivedBySender.get("conn-b")).toBe(1);
  });

  it("describes itself in one line", () => {
    const s = newCollabStats();
    notePost(s, 1, 1000);
    noteAck(s, 1, 1250);
    noteEphSent(s);
    noteEphReceived(s, "conn-a");
    s.changesIndex = 7;
    const line = describeCollabStats(s);
    expect(line).toContain("chg 1/1");
    expect(line).toContain("250");
    expect(line).toContain("eph out 1");
    expect(line).toContain("conn-a:1");
    expect(line).toContain("index 7");
    expect(line.includes("\n")).toBe(false);
  });
});
