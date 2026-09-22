// Real-socket tests for `/ws` — everything docs/tasks/006-websocket-fanout.md
// asks for that Fastify's `.inject()`/`injectWS()` can't exercise faithfully:
// heartbeat timing and genuine TCP/TLS backpressure. Mirrors
// server.integration.test.ts's approach (real `app.listen()`, the same dev
// cert, a real client) rather than inventing a different pattern.
//
// Why not `app.injectWS()`: `@fastify/websocket` decorates whatever
// encapsulation scope registers it — here, routes/ws.ts's own scope, since
// app.ts's autoloader gives every route module its own child scope (see
// that file's `autoloadRoutes`, which this ticket may not edit). Decorators
// don't propagate up to the root `app` a test holds, so `app.injectWS` is
// undefined at the root even though the `/ws` *route* is perfectly
// reachable — routing (unlike decorators) isn't scoped, which is exactly
// why a real socket connecting to a real listener works fine (verified by
// hand before writing this file). A real client sidesteps the question
// entirely and is what criteria 5 and 6 need regardless.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { WebSocket } from "ws";
import { buildApp } from "../app.ts";
import { loadServerConfig, loadTlsConfig } from "../config.ts";
import { pool } from "../db/pool.ts";
import { ingestEmitter, ingestHookPayload } from "../events/ingest.ts";
import type { StoredEventRow } from "../events/ingest.ts";
import { __resetForTests, subscriberCount } from "../events/bus.ts";

const certPem = readFileSync(loadTlsConfig().certPath);

interface WireEventFrame {
  readonly type: "event";
  readonly event: { readonly id: string; readonly sessionId: string | null; readonly cursor: string };
}

function wsUrlFor(app: FastifyInstance): string {
  const address = app.server.address() as AddressInfo;
  return `wss://127.0.0.1:${address.port}/ws`;
}

function connect(app: FastifyInstance): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrlFor(app), { ca: certPem });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function waitForMessage(client: WebSocket, timeoutMs = 2000): Promise<WireEventFrame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for a ws message")), timeoutMs);
    client.once("message", (raw: Buffer) => {
      clearTimeout(timer);
      resolve(JSON.parse(raw.toString("utf8")) as WireEventFrame);
    });
  });
}

function expectNoMessageWithin(client: WebSocket, timeoutMs = 200): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(true), timeoutMs);
    client.once("message", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

function waitForClose(client: WebSocket, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (client.readyState === client.CLOSED) {
      resolve();
      return;
    }
    const timer = setTimeout(() => reject(new Error("timed out waiting for close")), timeoutMs);
    client.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000, stepMs = 5): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitUntil: condition never became true");
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

function fakeEvent(overrides: Partial<StoredEventRow> = {}): StoredEventRow {
  const id = randomUUID();
  const receivedAt = new Date().toISOString();
  return {
    id,
    projectId: null,
    sessionId: null,
    type: "SyntheticWsIntegrationEvent",
    payload: { synthetic: true },
    receivedAt,
    cursor: `${receivedAt}|${id}`,
    ...overrides,
  };
}

async function cleanupBySessionId(sessionId: string): Promise<void> {
  await pool.query("delete from events where session_id = $1", [sessionId]);
}

/** Sets env vars for the duration of `fn`, restoring whatever was there
 * (or absent) before. Used to give a single test a short heartbeat
 * interval or a small backpressure limit without a config.ts edit and
 * without leaking the override into any other test. */
async function withEnv<T>(overrides: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// --- Criteria 1, 2, 3, 4, 7: default config, one shared listener ------------
describe("/ws over a real TLS socket — default config", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    __resetForTests();
  });

  // Criterion 1. Known limitation (see docs/tasks/006's "Critical context"
  // and bus.ts's SubscriptionFilter doc comment): nothing populates
  // `project_id` on a real ingested event until tickets 008/010, so every
  // event ingest.ts actually stores today has projectId === null. This
  // proves the /ws route's project filter is wired correctly end-to-end
  // (real socket, real route, real bus) by publishing synthetic
  // StoredEventRow objects with distinct project_id values through the same
  // `ingestEmitter` seam real ingest uses — not a mock of the route.
  it("delivers events for the subscribed project and none for another (criterion 1)", async () => {
    const clientA = await connect(app);
    const clientB = await connect(app);
    clientA.send(JSON.stringify({ type: "subscribe", project_id: "project-alpha" }));
    clientB.send(JSON.stringify({ type: "subscribe", project_id: "project-beta" }));
    await waitUntil(() => subscriberCount() === 2);

    const eventForA = fakeEvent({ projectId: "project-alpha" });
    const gotA = waitForMessage(clientA);
    const bGotNothing = expectNoMessageWithin(clientB);
    ingestEmitter.emit("event", eventForA);

    expect((await gotA).event.id).toBe(eventForA.id);
    expect(await bGotNothing).toBe(true);

    clientA.close();
    clientB.close();
  });

  // Criterion 2 — real ingest pipeline end to end (hook POST -> persist ->
  // publish -> /ws), since session_id genuinely is populated on real events.
  it("delivers only the subscribed session's events, via real ingested hook payloads (criterion 2)", async () => {
    const sessionA = randomUUID();
    const sessionB = randomUUID();
    const clientA = await connect(app);
    clientA.send(JSON.stringify({ type: "subscribe", session_id: sessionA }));
    await waitUntil(() => subscriberCount() === 1);

    const gotA = waitForMessage(clientA);
    const [storedA] = await Promise.all([
      ingestHookPayload(JSON.stringify({ hook_event_name: "WsTestSessionA", session_id: sessionA })),
      ingestHookPayload(JSON.stringify({ hook_event_name: "WsTestSessionB", session_id: sessionB })),
    ]);

    const frame = await gotA;
    expect(frame.event.id).toBe(storedA.id);
    expect(frame.event.sessionId).toBe(sessionA);
    expect(await expectNoMessageWithin(clientA)).toBe(true); // the B event never arrives

    clientA.close();
    await cleanupBySessionId(sessionA);
    await cleanupBySessionId(sessionB);
  });

  // Criterion 7. Same synthetic-project-id caveat as criterion 1.
  it("delivers one event to three same-project subscribers, exactly once each (criterion 7)", async () => {
    const clients = await Promise.all([connect(app), connect(app), connect(app)]);
    for (const client of clients) {
      client.send(JSON.stringify({ type: "subscribe", project_id: "shared-project" }));
    }
    await waitUntil(() => subscriberCount() === 3);

    const inboxes: WireEventFrame[][] = [[], [], []];
    clients.forEach((client, i) => {
      client.on("message", (raw: Buffer) => {
        inboxes[i]?.push(JSON.parse(raw.toString("utf8")) as WireEventFrame);
      });
    });

    const event = fakeEvent({ projectId: "shared-project" });
    ingestEmitter.emit("event", event);

    await waitUntil(() => inboxes.every((inbox) => inbox.length >= 1));
    await new Promise((resolve) => setTimeout(resolve, 150)); // let a duplicate show up too, if there is one

    for (const inbox of inboxes) {
      expect(inbox.map((f) => f.event.id)).toEqual([event.id]);
    }

    for (const client of clients) client.close();
  });

  // Criterion 4.
  it("returns to zero subscribers after 100 connect/disconnect cycles (criterion 4)", async () => {
    expect(subscriberCount()).toBe(0);

    for (let i = 0; i < 100; i += 1) {
      const client = await connect(app);
      client.send(JSON.stringify({ type: "subscribe", session_id: `cycle-${i}` }));
      await waitUntil(() => subscriberCount() === 1);
      const closed = waitForClose(client);
      client.close();
      await closed;
      await waitUntil(() => subscriberCount() === 0);
    }

    expect(subscriberCount()).toBe(0);
  }, 30_000);

  // Criterion 3.
  it(
    "does not replay events missed while disconnected; GET /events?since= backfills them with no gap or duplicate (criterion 3)",
    async () => {
      const sessionId = randomUUID();

      const clientA = await connect(app);
      clientA.send(JSON.stringify({ type: "subscribe", session_id: sessionId }));
      await waitUntil(() => subscriberCount() === 1);

      const gotLive = waitForMessage(clientA);
      const e1 = await ingestHookPayload(
        JSON.stringify({ hook_event_name: "WsBackfillLiveBeforeDisconnect", session_id: sessionId }),
      );
      expect((await gotLive).event.id).toBe(e1.id);

      const closed = waitForClose(clientA);
      clientA.close();
      await closed;
      await waitUntil(() => subscriberCount() === 0);

      // Nobody is connected — published, not queued for anyone.
      const e2 = await ingestHookPayload(
        JSON.stringify({ hook_event_name: "WsBackfillMissed1", session_id: sessionId }),
      );
      const e3 = await ingestHookPayload(
        JSON.stringify({ hook_event_name: "WsBackfillMissed2", session_id: sessionId }),
      );
      const e4 = await ingestHookPayload(
        JSON.stringify({ hook_event_name: "WsBackfillMissed3", session_id: sessionId }),
      );

      const clientB = await connect(app);
      clientB.send(JSON.stringify({ type: "subscribe", session_id: sessionId }));
      await waitUntil(() => subscriberCount() === 1);
      // The missed events are not replayed over /ws on reconnect.
      expect(await expectNoMessageWithin(clientB)).toBe(true);

      // Backfill through GET /events?since=<cursor of the last event seen
      // live>, paging like ingest.test.ts's own "pages forward from a
      // cursor without gaps" test. The DB is shared with tests that may run
      // concurrently, so results are scoped to this session's own ids.
      const walked: string[] = [];
      let cursor = e1.cursor;
      for (let page = 0; page < 20; page += 1) {
        const response = await app.inject({
          method: "GET",
          url: `/events?since=${encodeURIComponent(cursor)}&limit=2`,
        });
        expect(response.statusCode).toBe(200);
        const rows = JSON.parse(response.body) as Array<
          { id: string; sessionId: string | null; cursor: string }
        >;
        if (rows.length === 0) break;
        for (const row of rows) {
          if (row.sessionId === sessionId) walked.push(row.id);
        }
        const last = rows[rows.length - 1];
        if (last === undefined) break;
        cursor = last.cursor;
      }

      expect(new Set(walked).size).toBe(walked.length); // no duplicate
      expect(walked).not.toContain(e1.id); // the already-seen event isn't repeated
      expect(walked).toEqual([e2.id, e3.id, e4.id]); // no gap, correct order

      // And the reconnected client resumes receiving new live events.
      const gotAfterReconnect = waitForMessage(clientB);
      const e5 = await ingestHookPayload(
        JSON.stringify({ hook_event_name: "WsBackfillLiveAfterReconnect", session_id: sessionId }),
      );
      expect((await gotAfterReconnect).event.id).toBe(e5.id);

      clientB.close();
      await cleanupBySessionId(sessionId);
    },
  );
});

// --- Criterion 5: heartbeat ---------------------------------------------------
describe("/ws heartbeat (criterion 5)", () => {
  it(
    "closes a connection that misses two consecutive pongs, using a short configurable interval",
    async () => {
      await withEnv(
        { WS_HEARTBEAT_INTERVAL_MS: "80", WS_HEARTBEAT_MAX_MISSED_PONGS: "2" },
        async () => {
          const app = await buildApp();
          await app.listen({ port: 0, host: "127.0.0.1" });
          try {
            // A client that never answers a ping. 80ms interval, 2 misses:
            // expect a close within a handful of intervals, well under 1s —
            // this is the whole point of making the interval configurable
            // (the ticket's own 30s default would make this test glacial).
            const silentClient = await connect(app);
            const closed = waitForClose(silentClient, 3000);
            await closed;
            expect(silentClient.readyState).toBe(silentClient.CLOSED);
          } finally {
            await app.close();
          }
        },
      );
    },
    5000,
  );

  it("stays open across several heartbeats when the client answers every ping", async () => {
    await withEnv(
      { WS_HEARTBEAT_INTERVAL_MS: "60", WS_HEARTBEAT_MAX_MISSED_PONGS: "2" },
      async () => {
        const app = await buildApp();
        await app.listen({ port: 0, host: "127.0.0.1" });
        try {
          const client = await connect(app);
          client.on("message", (raw: Buffer) => {
            const frame = JSON.parse(raw.toString("utf8")) as { type: string };
            if (frame.type === "ping") {
              client.send(JSON.stringify({ type: "pong" }));
            }
          });

          // Outlive at least 6 heartbeat intervals (360ms) — several times
          // the 2-miss threshold's worth of ticks — while always answering.
          await new Promise((resolve) => setTimeout(resolve, 400));
          expect(client.readyState).toBe(client.OPEN);
          client.close();
        } finally {
          await app.close();
        }
      },
    );
  }, 5000);
});

// --- Criterion 6: slow consumer / backpressure --------------------------------
describe("/ws slow consumer (criterion 6)", () => {
  it(
    "disconnects a stuck consumer once its buffer passes the configured limit, without slowing ingest",
    async () => {
      await withEnv({ WS_BACKPRESSURE_LIMIT_BYTES: "100000" }, async () => {
        const app = await buildApp();
        await app.listen({ port: 0, host: "127.0.0.1" });
        const address = app.server.address() as AddressInfo;
        const { hookIngestTokens } = loadServerConfig();
        const token = hookIngestTokens[0];
        if (!token) throw new Error("HOOK_INGEST_TOKENS is empty in test env");

        // Declared outside the try so `finally` can always reach them, even
        // if something above throws before they'd otherwise be assigned.
        let fastClient: WebSocket | undefined;
        let slowClient: WebSocket | undefined;

        try {
          const sessionId = randomUUID();

          // A normal, reading control client on the same session — proves
          // only the stuck one gets dropped, not everyone.
          fastClient = await connect(app);
          fastClient.send(JSON.stringify({ type: "subscribe", session_id: sessionId }));
          let fastClientMessageCount = 0;
          fastClient.on("message", () => {
            fastClientMessageCount += 1;
          });

          slowClient = await connect(app);
          slowClient.send(JSON.stringify({ type: "subscribe", session_id: sessionId }));
          await waitUntil(() => subscriberCount() === 2);

          // Simulate a stuck reader: stop consuming incoming data at the
          // stream level. (Verified by hand before writing this test: with
          // the socket paused, ws's own bufferedAmount genuinely grows as
          // the server keeps sending, and this module's disconnect logic
          // does fire once it crosses the configured limit — this is not
          // merely simulated at the JS-object level.)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (slowClient as any)._socket.pause();

          function postJson(path: string, body: string): Promise<{ status: number }> {
            return new Promise((resolve, reject) => {
              const req = https.request(
                {
                  host: "127.0.0.1",
                  port: address.port,
                  path,
                  method: "POST",
                  ca: certPem,
                  headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
                },
                (res) => {
                  res.resume();
                  res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
                },
              );
              req.on("error", reject);
              req.end(body);
            });
          }

          // Sizable payloads (~20KB each once framed) so the 100KB limit is
          // crossed within the first handful of sends with plenty of
          // margin — sequential real HTTP round-trips space sends out by a
          // few ms each, unlike a tight in-process burst, giving the OS/TLS
          // stack more chances to drain a smaller buffer in between. N=200
          // stays consistent with ticket 005's own p95 methodology.
          const bigContent = "x".repeat(20_000);
          const N = 200;
          const durations: number[] = [];
          for (let i = 0; i < N; i += 1) {
            const payload = JSON.stringify({
              hook_event_name: "PostToolUse",
              session_id: sessionId,
              tool_name: "Read",
              tool_input: {},
              tool_response: { content: bigContent, i },
              tool_use_id: `toolu_bp_${i}`,
            });
            const start = performance.now();
            const response = await postJson(`/events/tool?token=${token}`, payload);
            durations.push(performance.now() - start);
            expect(response.status).toBeGreaterThanOrEqual(200);
            expect(response.status).toBeLessThan(300);
          }

          durations.sort((a, b) => a - b);
          const p95Index = Math.min(durations.length - 1, Math.ceil(0.95 * durations.length) - 1);
          const p95 = durations[p95Index] ?? 0;
          console.log(
            `ingest latency over ${N} sequential POSTs with a stuck /ws subscriber: ` +
              `min=${durations[0]?.toFixed(2)}ms p50=${durations[Math.floor(durations.length / 2)]?.toFixed(2)}ms ` +
              `p95=${p95.toFixed(2)}ms max=${durations[durations.length - 1]?.toFixed(2)}ms`,
          );
          expect(p95).toBeLessThan(50);

          // The slow one was dropped (subscriberCount fell from 2 to 1); the
          // fast one is still subscribed and has been receiving messages.
          await waitUntil(() => subscriberCount() === 1, 3000);
          expect(fastClientMessageCount).toBeGreaterThan(0);

          // Corroborate from the client's own side too: resuming the paused
          // socket lets it finally observe the abrupt close the server
          // already performed (an actually-stuck client might never
          // resume — the subscriberCount assertion above is what the
          // acceptance criterion actually depends on; this is corroboration,
          // not the primary signal).
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (slowClient as any)._socket.resume();
          await waitForClose(slowClient, 3000);

          fastClient.close();
          await cleanupBySessionId(sessionId);
        } finally {
          // Whether or not the assertions above passed, make sure neither
          // client can block `app.close()`'s graceful websocket shutdown —
          // @fastify/websocket's default preClose tries a clean close
          // handshake with every still-open client, which would hang
          // forever against a genuinely stuck (paused) peer and turn a
          // failed assertion into an opaque suite-level timeout instead of
          // a clear test failure.
          try {
            slowClient?.terminate();
          } catch {
            // already closed — fine.
          }
          try {
            fastClient?.terminate();
          } catch {
            // already closed — fine.
          }
          await app.close();
        }
      });
    },
    30_000,
  );
});
