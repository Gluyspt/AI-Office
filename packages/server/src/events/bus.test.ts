// Unit tests for the pub/sub mechanism itself — filtering, subscribe /
// unsubscribe, and "nothing is queued while nobody is subscribed." These
// feed synthetic StoredEventRow-shaped objects straight into the real
// `ingestEmitter` seam (the same one ingest.ts's `publish()` uses), rather
// than mocking bus.ts, so the thing under test is the actual production
// wiring.
//
// Why synthetic rows for project_id: nothing in this codebase populates
// `project_id` on a stored event until tickets 008/010 map a session to a
// project (see events/ingest.ts's `persist`, which never writes that
// column, and docs/tasks/006-websocket-fanout.md's "Critical context").
// Every *real* ingested event today has projectId === null. Testing
// project-scoped filtering against real ingest would therefore either (a)
// only pass because every event is null — exactly the dishonest test the
// ticket warns against — or (b) be impossible to write at all. Feeding
// hand-built rows with distinct project_id values through the same emitter
// proves the filter mechanism is correct today and ready for the day
// something populates the column, without inventing that mapping here.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ingestEmitter } from "./ingest.ts";
import type { StoredEventRow } from "./ingest.ts";
import { __resetForTests, subscribe, subscriberCount } from "./bus.ts";

function fakeEvent(overrides: Partial<StoredEventRow> = {}): StoredEventRow {
  const id = randomUUID();
  const receivedAt = new Date().toISOString();
  return {
    id,
    projectId: null,
    sessionId: null,
    type: "SyntheticBusTestEvent",
    payload: { synthetic: true },
    receivedAt,
    cursor: `${receivedAt}|${id}`,
    ...overrides,
  };
}

function publish(event: StoredEventRow): void {
  ingestEmitter.emit("event", event);
}

afterEach(() => {
  __resetForTests();
});

describe("subscribe / project_id filtering", () => {
  it("delivers an event to a project subscription and not to a different project's", () => {
    const receivedA: StoredEventRow[] = [];
    const receivedB: StoredEventRow[] = [];
    subscribe({ projectId: "project-a" }, (e) => receivedA.push(e));
    subscribe({ projectId: "project-b" }, (e) => receivedB.push(e));

    const event = fakeEvent({ projectId: "project-a" });
    publish(event);

    expect(receivedA.map((e) => e.id)).toEqual([event.id]);
    expect(receivedB).toHaveLength(0);
  });

  it("does not deliver a project-scoped event to a subscription with no project filter match", () => {
    const received: StoredEventRow[] = [];
    subscribe({ projectId: "project-x" }, (e) => received.push(e));
    publish(fakeEvent({ projectId: null })); // the honest real-world shape today
    publish(fakeEvent({ projectId: "project-y" }));
    expect(received).toHaveLength(0);
  });
});

describe("subscribe / session_id filtering", () => {
  it("delivers only events for the subscribed session", () => {
    const sessionA = randomUUID();
    const sessionB = randomUUID();
    const received: StoredEventRow[] = [];
    subscribe({ sessionId: sessionA }, (e) => received.push(e));

    const matching = fakeEvent({ sessionId: sessionA });
    publish(matching);
    publish(fakeEvent({ sessionId: sessionB }));
    publish(fakeEvent({ sessionId: null }));

    expect(received.map((e) => e.id)).toEqual([matching.id]);
  });
});

describe("fan-out to multiple subscribers", () => {
  it("delivers the same event to three subscribers on the same filter, exactly once each", () => {
    const buckets: StoredEventRow[][] = [[], [], []];
    for (const bucket of buckets) {
      subscribe({ projectId: "shared-project" }, (e) => bucket.push(e));
    }
    const event = fakeEvent({ projectId: "shared-project" });
    publish(event);

    for (const bucket of buckets) {
      expect(bucket.map((e) => e.id)).toEqual([event.id]);
    }
  });
});

describe("unsubscribe and subscriber count", () => {
  it("stops delivering events once unsubscribed, and count reflects live subscriptions", () => {
    expect(subscriberCount()).toBe(0);
    const received: StoredEventRow[] = [];
    const unsubscribe = subscribe({ sessionId: "s1" }, (e) => received.push(e));
    expect(subscriberCount()).toBe(1);

    publish(fakeEvent({ sessionId: "s1" }));
    expect(received).toHaveLength(1);

    unsubscribe();
    expect(subscriberCount()).toBe(0);

    publish(fakeEvent({ sessionId: "s1" }));
    expect(received).toHaveLength(1); // unchanged — no delivery after unsubscribe
  });

  it("returns to zero subscribers after 100 subscribe/unsubscribe cycles", () => {
    for (let i = 0; i < 100; i += 1) {
      const unsubscribe = subscribe({ sessionId: `cycle-${i}` }, () => {});
      expect(subscriberCount()).toBe(1);
      unsubscribe();
    }
    expect(subscriberCount()).toBe(0);
  });

  it("calling the returned unsubscribe twice is a no-op the second time", () => {
    const unsubscribe = subscribe({ sessionId: "s1" }, () => {});
    expect(subscriberCount()).toBe(1);
    unsubscribe();
    unsubscribe();
    expect(subscriberCount()).toBe(0);
  });
});

describe("events published with no subscribers", () => {
  it("are dropped silently — nothing is queued or replayed to a later subscriber", () => {
    expect(subscriberCount()).toBe(0);
    // No subscriber exists yet; this must not throw, buffer, or otherwise
    // remember the event.
    expect(() => publish(fakeEvent({ sessionId: "nobody-listening" }))).not.toThrow();

    const received: StoredEventRow[] = [];
    subscribe({ sessionId: "nobody-listening" }, (e) => received.push(e));
    // A subscriber arriving *after* the publish sees nothing from before it
    // subscribed — there is no backlog/replay in this module by design.
    expect(received).toHaveLength(0);
  });
});

describe("a throwing subscriber", () => {
  it("does not stop the same event reaching other subscribers, and is removed", () => {
    const received: StoredEventRow[] = [];
    subscribe({ sessionId: "s1" }, () => {
      throw new Error("simulated subscriber failure");
    });
    subscribe({ sessionId: "s1" }, (e) => received.push(e));
    expect(subscriberCount()).toBe(2);

    const originalConsoleError = console.error;
    console.error = () => {}; // the throw is expected and logged; keep test output clean
    try {
      publish(fakeEvent({ sessionId: "s1" }));
    } finally {
      console.error = originalConsoleError;
    }

    expect(received).toHaveLength(1);
    expect(subscriberCount()).toBe(1); // the throwing one was removed
  });
});
