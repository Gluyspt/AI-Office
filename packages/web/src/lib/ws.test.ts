// The socket client's two load-bearing promises: it reconnects, and it does
// not lose or double an event while doing it.
//
// A fake socket rather than a real server. The thing under test is the
// client's own state machine — buffer during backfill, replay after, dedupe
// always — and driving it through a real network would make the interesting
// cases (a frame arriving *while* a backfill is in flight) a matter of
// timing luck rather than assertion.
import { describe, expect, it, vi } from "vitest";
import { backoffFor, BACKOFF_CAP_MS, openEventStream, type WebSocketLike } from "./ws.ts";
import type { StoredEvent } from "./api.ts";

function event(id: string, cursor = id): StoredEvent {
  return {
    id,
    projectId: null,
    sessionId: null,
    type: "Probe",
    payload: {},
    receivedAt: new Date().toISOString(),
    cursor,
  };
}

/** A socket the test drives by hand. */
class FakeSocket implements WebSocketLike {
  onopen: ((event?: unknown) => void) | null = null;
  onclose: ((event?: unknown) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  readonly sent: string[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.();
  }
  deliver(e: StoredEvent): void {
    this.onmessage?.({ data: JSON.stringify({ type: "event", event: e }) });
  }
  ping(): void {
    this.onmessage?.({ data: JSON.stringify({ type: "ping" }) });
  }
  drop(): void {
    this.onclose?.();
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("backoff", () => {
  it("rises and then caps, so an overnight outage still reconnects in seconds", () => {
    expect(backoffFor(0)).toBeLessThan(backoffFor(3));
    expect(backoffFor(99)).toBe(BACKOFF_CAP_MS);
  });
});

describe("openEventStream", () => {
  it("subscribes on open and answers pings", async () => {
    const socket = new FakeSocket();
    const stream = openEventStream({
      onEvent: () => {},
      socketFactory: () => socket,
      backfill: async () => [],
    });
    socket.open();
    await flush();

    expect(JSON.parse(socket.sent[0]!)).toMatchObject({ type: "subscribe" });
    socket.ping();
    expect(JSON.parse(socket.sent[1]!)).toEqual({ type: "pong" });
    stream.close();
  });

  it("reports a drop, so the board cannot look current while it is stale", async () => {
    const socket = new FakeSocket();
    const statuses: string[] = [];
    const stream = openEventStream({
      onEvent: () => {},
      onStatus: (status) => statuses.push(status),
      socketFactory: () => socket,
      backfill: async () => [],
    });
    socket.open();
    await flush();
    socket.drop();
    await flush();

    expect(statuses).toContain("open");
    expect(statuses).toContain("reconnecting");
    stream.close();
  });

  it("backfills the gap on reconnect: nothing lost, nothing applied twice", async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeSocket[] = [];
      const delivered: string[] = [];
      const backfill = vi.fn(async () => [event("b1"), event("b2")]);

      const stream = openEventStream({
        onEvent: (e) => delivered.push(e.id),
        socketFactory: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
        backfill,
      });

      // First connection delivers a1, so a cursor exists to backfill from.
      sockets[0]!.open();
      await vi.advanceTimersByTimeAsync(0);
      sockets[0]!.deliver(event("a1"));
      expect(stream.cursor).toBe("a1");

      // Server restarts.
      sockets[0]!.drop();
      await vi.advanceTimersByTimeAsync(BACKOFF_CAP_MS);
      expect(sockets).toHaveLength(2);

      sockets[1]!.open();
      await vi.advanceTimersByTimeAsync(0);

      // The gap was requested from the cursor we actually delivered.
      expect(backfill).toHaveBeenCalledWith(expect.objectContaining({ since: "a1" }));
      expect(delivered).toEqual(["a1", "b1", "b2"]);
      stream.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not deliver a live frame ahead of the backfill that precedes it", async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeSocket[] = [];
      const delivered: string[] = [];
      let releaseBackfill: (value: StoredEvent[]) => void = () => {};

      const stream = openEventStream({
        onEvent: (e) => delivered.push(e.id),
        socketFactory: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
        backfill: () =>
          new Promise<StoredEvent[]>((resolve) => {
            releaseBackfill = resolve;
          }),
      });

      sockets[0]!.open();
      await vi.advanceTimersByTimeAsync(0);
      sockets[0]!.deliver(event("a1"));
      sockets[0]!.drop();
      await vi.advanceTimersByTimeAsync(BACKOFF_CAP_MS);
      sockets[1]!.open();
      await vi.advanceTimersByTimeAsync(0);

      // A live frame arrives while the gap is still being fetched. Delivering
      // it now would advance the cursor past events we have not seen.
      sockets[1]!.deliver(event("live"));
      expect(delivered).toEqual(["a1"]);

      releaseBackfill([event("b1")]);
      await vi.advanceTimersByTimeAsync(0);

      // Gap first, then the buffered live frame — in order.
      expect(delivered).toEqual(["a1", "b1", "live"]);
      stream.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a duplicate the backfill window and the live stream both carry", async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeSocket[] = [];
      const delivered: string[] = [];
      const stream = openEventStream({
        onEvent: (e) => delivered.push(e.id),
        socketFactory: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
        // The server legitimately re-sends an event we already applied.
        backfill: async () => [event("a1"), event("b1")],
      });

      sockets[0]!.open();
      await vi.advanceTimersByTimeAsync(0);
      sockets[0]!.deliver(event("a1"));
      sockets[0]!.drop();
      await vi.advanceTimersByTimeAsync(BACKOFF_CAP_MS);
      sockets[1]!.open();
      await vi.advanceTimersByTimeAsync(0);

      expect(delivered).toEqual(["a1", "b1"]);
      stream.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays in a failed state when the backfill itself fails", async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeSocket[] = [];
      const statuses: string[] = [];
      const stream = openEventStream({
        onEvent: () => {},
        onStatus: (status, detail) => statuses.push(`${status}:${detail ?? ""}`),
        socketFactory: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
        backfill: async () => {
          throw new Error("server still down");
        },
      });

      sockets[0]!.open();
      await vi.advanceTimersByTimeAsync(0);
      sockets[0]!.deliver(event("a1"));
      sockets[0]!.drop();
      await vi.advanceTimersByTimeAsync(BACKOFF_CAP_MS);
      sockets[1]!.open();
      await vi.advanceTimersByTimeAsync(0);

      // An open socket with an unfilled gap is not a healthy board.
      expect(statuses.some((s) => s.startsWith("reconnecting:backfill failed"))).toBe(true);
      stream.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
