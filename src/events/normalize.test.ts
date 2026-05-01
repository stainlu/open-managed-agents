import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Event } from "../orchestrator/types.js";
import type { ManagedEventLog } from "./types.js";
import { CompositeManagedEventLog } from "./composite.js";
import { ManagedJsonlEventLog } from "./jsonl.js";
import {
  mergeManagedEventsForSession,
  normalizeManagedEventBatch,
} from "./normalize.js";

describe("managed event normalization", () => {
  it("rewrites managed session ids, dedupes event ids, and normalizes scalar fields", () => {
    const events = normalizeManagedEventBatch("ses_expected", [
      event({ eventId: " evt_1 ", sessionId: "native-session", createdAt: 9.8 }),
      event({ eventId: "evt_1", sessionId: "native-session", createdAt: 10 }),
      event({
        eventId: "evt_2",
        sessionId: "wrong",
        content: { ok: true } as unknown as string,
        createdAt: -10,
        tokensIn: -2,
        tokensOut: 4.9,
        costUsd: -1,
      }),
    ]);

    expect(events).toHaveLength(2);
    expect(events.map((e) => e.sessionId)).toEqual(["ses_expected", "ses_expected"]);
    expect(events[0]?.eventId).toBe("evt_1");
    expect(events[0]?.createdAt).toBe(9);
    expect(events[1]?.content).toBe('{"ok":true}');
    expect(events[1]?.createdAt).toBe(0);
    expect(events[1]?.tokensIn).toBe(0);
    expect(events[1]?.tokensOut).toBe(4);
    expect(events[1]?.costUsd).toBe(0);
  });

  it("merges multiple event sources with stable chronological ordering", () => {
    const merged = mergeManagedEventsForSession("ses_1", [
      event({ eventId: "evt_late", createdAt: 20 }),
      event({ eventId: "evt_early", createdAt: 10 }),
      event({ eventId: "evt_same_a", createdAt: 15 }),
      event({ eventId: "evt_same_b", createdAt: 15 }),
      event({ eventId: "evt_early", createdAt: 10 }),
    ]);

    expect(merged.map((e) => e.eventId)).toEqual([
      "evt_early",
      "evt_same_a",
      "evt_same_b",
      "evt_late",
    ]);
  });
});

describe("ManagedJsonlEventLog", () => {
  it("persists canonical managed events without duplicates", () => {
    const root = mkdtempSync(join(tmpdir(), "oma-events-"));
    try {
      const log = new ManagedJsonlEventLog(root);
      log.appendEvents("agt_1", "ses_1", [
        event({ eventId: "evt_2", sessionId: "native", createdAt: 20 }),
        event({ eventId: "evt_1", sessionId: "native", createdAt: 10 }),
        event({ eventId: "evt_2", sessionId: "native", createdAt: 20 }),
      ]);
      log.appendEvents("agt_1", "ses_1", [
        event({ eventId: "evt_1", sessionId: "native", createdAt: 10 }),
        event({ eventId: "evt_3", sessionId: "native", createdAt: 30 }),
      ]);

      const listed = log.listBySession("agt_1", "ses_1");
      expect(listed.map((e) => e.eventId)).toEqual(["evt_1", "evt_2", "evt_3"]);
      expect(listed.map((e) => e.sessionId)).toEqual(["ses_1", "ses_1", "ses_1"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("CompositeManagedEventLog", () => {
  it("dedupes normalized events across native and managed logs", () => {
    const first = fakeLog([
      event({ eventId: "evt_1", sessionId: "ses_native", createdAt: 10 }),
      event({ eventId: "evt_2", sessionId: "ses_native", createdAt: 20 }),
    ]);
    const second = fakeLog([
      event({ eventId: "evt_2", sessionId: "ses_managed", createdAt: 20 }),
      event({ eventId: "evt_3", sessionId: "ses_managed", createdAt: 30 }),
    ]);

    const composite = new CompositeManagedEventLog("/tmp/unused", [first, second]);
    const listed = composite.listBySession("agt_1", "ses_1");
    expect(listed.map((e) => e.eventId)).toEqual(["evt_1", "evt_2", "evt_3"]);
    expect(listed.map((e) => e.sessionId)).toEqual(["ses_1", "ses_1", "ses_1"]);
  });
});

function event(patch: Partial<Event> = {}): Event {
  return {
    eventId: "evt_default",
    sessionId: "ses_default",
    type: "agent.message",
    content: "hello",
    createdAt: 1,
    ...patch,
  };
}

function fakeLog(events: Event[]): ManagedEventLog {
  return {
    stateRoot: "/tmp/unused",
    listBySession: () => events,
    latestAgentMessage: () => events.find((event) => event.type === "agent.message"),
    latestAgentOutcome: () => events.find((event) => event.type === "agent.message"),
    countUserTurns: () => events.filter((event) => event.type === "user.message").length,
    statSessionLog: () => ({ bytes: 1 }),
    deleteBySession: () => {},
    async *follow() {
      for (const item of events) yield item;
    },
  };
}
