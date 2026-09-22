// The `/ws` endpoint: the WebSocket channel a browser tab (or a test) uses
// to hear about events as they happen, instead of polling `GET /events`
// (routes/events.ts, ticket 005). See docs/tasks/006-websocket-fanout.md.
//
// wss://, not ws:// — per the ticket's "Decided" section (and the
// system-wide https decision in docs/tasks/README.md), this registers
// `@fastify/websocket` on the same HTTPS Fastify instance app.ts already
// builds. There is no separate plaintext listener anywhere in this system.
//
// No authentication. That is step 9's work (see the ticket's own open
// question, and docs/tasks/README.md's "What steps 1-3 deliberately leave
// inert": "there is no authentication; the app must not leave a trusted
// network"). Do not add auth here — carry the gap forward, don't invent it
// away.
//
// Autoloaded by app.ts like every other file in this directory — this
// module owns registering the websocket plugin itself (rather than app.ts
// registering it globally) precisely so app.ts needs no edit for this
// ticket to exist, matching routes/events.ts's house style of a
// self-contained route module.
import type { FastifyInstance } from "fastify";
import websocketPlugin from "@fastify/websocket";
import type { WebSocket as WsSocket, RawData } from "ws";
import {
  isClientFrame,
  type ClientFrame,
  type EventFrame,
  type PingFrame,
} from "@office/shared/ws";
import { subscribe, type SubscriptionFilter } from "../../events/bus.ts";
import { loadWsConfig } from "../../../core/config.ts";
import type { StoredEventRow } from "../../events/ingest.ts";

// Caches the JSON encoding of an event frame per StoredEventRow, so N
// subscribers matching the same publish (this ticket's "three clients
// subscribed to the same project" criterion) cost one JSON.stringify, not
// N — the whole point being that this listener runs synchronously inside
// ingest's request path (see bus.ts's `subscribe` doc comment) and must
// stay cheap regardless of how many sockets are listening. A WeakMap keys
// on the row's own identity and needs no manual eviction: once nothing else
// references the row (the bus never retains one), the entry goes with it.
const frameCache = new WeakMap<StoredEventRow, string>();

function serializedEventFrame(event: StoredEventRow): string {
  const cached = frameCache.get(event);
  if (cached !== undefined) return cached;
  const frame: EventFrame = {
    type: "event",
    event: {
      id: event.id,
      projectId: event.projectId,
      sessionId: event.sessionId,
      type: event.type,
      payload: event.payload,
      receivedAt: event.receivedAt,
      cursor: event.cursor,
    },
  };
  const json = JSON.stringify(frame);
  frameCache.set(event, json);
  return json;
}

function sameFilter(a: SubscriptionFilter, b: SubscriptionFilter): boolean {
  return a.projectId === b.projectId && a.sessionId === b.sessionId;
}

export default async function wsRoutes(app: FastifyInstance): Promise<void> {
  const wsConfig = loadWsConfig();

  await app.register(websocketPlugin);

  app.get("/ws", { websocket: true }, (socket: WsSocket) => {
    // One connection's worth of state. A fresh closure per connection, not
    // a class — nothing else in this package needs to reach into it, and
    // this mirrors routes/events.ts's plain-function house style.
    const activeSubscriptions: Array<{ filter: SubscriptionFilter; unsubscribe: () => void }> = [];
    let awaitingPong = false;
    let missedPongs = 0;
    let closed = false;

    function cleanup(): void {
      if (closed) return;
      closed = true;
      clearInterval(heartbeatTimer);
      for (const sub of activeSubscriptions) sub.unsubscribe();
      activeSubscriptions.length = 0;
    }

    // A slow-consumer disconnect and a missed-heartbeat disconnect are the
    // same operation: stop listening for more events, stop the heartbeat
    // timer, and tear down the socket without waiting for a clean close
    // handshake a stuck peer may never complete. `terminate()` (not
    // `close()`) is `ws`'s hard, immediate teardown — appropriate for a
    // connection this module has already decided is not coming back.
    function disconnect(): void {
      cleanup();
      socket.terminate();
    }

    function addSubscription(filter: SubscriptionFilter): void {
      const unsubscribe = subscribe(filter, (event) => {
        if (socket.readyState !== socket.OPEN) return;
        socket.send(serializedEventFrame(event));
        // Checked *after* sending: `send()` never blocks (it queues into
        // the socket's own buffer regardless of whether the peer is
        // reading), so this only ever adds an O(1) property read to
        // ingest's request path — see bus.ts's `subscribe` doc comment for
        // why that matters. Once the buffer is over the limit the
        // connection is already unrecoverable for this ticket's purposes;
        // dropping it here bounds how much further it can grow rather than
        // waiting for some future publish to notice.
        if (socket.bufferedAmount > wsConfig.backpressureLimitBytes) {
          disconnect();
        }
      });
      activeSubscriptions.push({ filter, unsubscribe });
    }

    function removeSubscriptions(filter: SubscriptionFilter): void {
      for (let i = activeSubscriptions.length - 1; i >= 0; i -= 1) {
        const sub = activeSubscriptions[i];
        if (sub !== undefined && sameFilter(sub.filter, filter)) {
          sub.unsubscribe();
          activeSubscriptions.splice(i, 1);
        }
      }
    }

    function sendPing(): void {
      if (socket.readyState !== socket.OPEN) return;
      const frame: PingFrame = { type: "ping" };
      socket.send(JSON.stringify(frame));
    }

    // Heartbeat: ping every `heartbeatIntervalMs` (30s by default — see
    // config.ts's loadWsConfig; tests use a short override so this
    // criterion doesn't cost real wall-clock minutes). Two consecutive
    // ticks with no pong in between close the connection. Concretely, with
    // ticks at t, 2t, 3t...: a tick sends a ping only after first checking
    // whether the *previous* ping is still unanswered. One unanswered ping
    // is a miss (count 1) and gets a fresh ping anyway; a second consecutive
    // miss (count 2) closes the connection instead of sending a third ping.
    // So a fully unresponsive client is caught within 2-3 intervals of
    // going quiet, never fewer than 2.
    const heartbeatTimer = setInterval(() => {
      if (awaitingPong) {
        missedPongs += 1;
        if (missedPongs >= wsConfig.heartbeatMaxMissedPongs) {
          disconnect();
          return;
        }
      } else {
        missedPongs = 0;
      }
      awaitingPong = true;
      sendPing();
    }, wsConfig.heartbeatIntervalMs);

    function handleClientFrame(frame: ClientFrame): void {
      if (frame.type === "pong") {
        awaitingPong = false;
        missedPongs = 0;
        return;
      }
      const filter: SubscriptionFilter = {
        projectId: frame.project_id,
        sessionId: frame.session_id,
      };
      if (filter.projectId === undefined && filter.sessionId === undefined) {
        // A subscribe/unsubscribe naming neither dimension is not a
        // firehose request — see SubscribeFrame's doc comment in
        // packages/shared/src/ws.ts. Ignored, not errored: a malformed
        // frame must not be fatal to an otherwise-fine connection (compare
        // ingest.ts's dead-lettering of a malformed hook body, the same
        // "don't punish the caller for one bad message" instinct).
        return;
      }
      if (frame.type === "subscribe") {
        addSubscription(filter);
      } else {
        removeSubscriptions(filter);
      }
    }

    socket.on("message", (raw: RawData) => {
      // Frames are always JSON text in this protocol, but `ws` hands a
      // text frame to this listener as a Buffer (or, rarely, an array of
      // Buffer fragments) regardless — only `isBinary` (unused here)
      // distinguishes a text frame from a binary one on the wire.
      const text = Array.isArray(raw)
        ? Buffer.concat(raw).toString("utf8")
        : Buffer.isBuffer(raw)
          ? raw.toString("utf8")
          : Buffer.from(raw).toString("utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return; // Malformed frame: ignored, connection stays open.
      }
      if (!isClientFrame(parsed)) return;
      handleClientFrame(parsed);
    });

    socket.on("close", cleanup);
    socket.on("error", cleanup);
  });
}
