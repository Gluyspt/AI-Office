// Frame types for the office UI's `/ws` WebSocket channel (ticket 006). See
// packages/server/src/routes/ws.ts for the server side and
// packages/server/src/events/bus.ts for the fan-out these frames ride on.
//
// This module has no barrel re-export, matching packages/shared/src/events.ts
// (see that file's header and packages/shared's package.json `exports`
// map): import it as `@office/shared/ws`.
//
// Heartbeat is a JSON frame pair (`ping`/`pong`), not the WebSocket
// protocol's own ping/pong control frames. That's deliberate: a browser's
// `WebSocket` API cannot send a protocol-level ping or observe a
// protocol-level pong at all (only Node's `ws` library exposes those, on
// the server side this connects to) — so an application-level heartbeat is
// the only kind a browser client can actually participate in. See
// routes/ws.ts for the server-side timer and miss-counting.

/** Client -> server: watch events for a project and/or a session.
 *
 * At least one of `project_id` / `session_id` must be present — a
 * subscribe frame with neither is ignored by the server (see routes/ws.ts).
 * When both are given, an event must match both to be delivered.
 *
 * Known limitation (see docs/tasks/006-websocket-fanout.md, "Critical
 * context"): nothing populates `project_id` on a stored event until
 * tickets 008/010 map a session to a project, so a `project_id` filter
 * matches nothing against real traffic yet. This is a server-side
 * limitation of what's in the events table, not a shape problem with this
 * frame — see events/bus.ts's SubscriptionFilter for the fuller comment.
 */
export interface SubscribeFrame {
  readonly type: "subscribe";
  readonly project_id?: string;
  readonly session_id?: string;
}

/** Client -> server: stop watching a project and/or a session. Matches a
 * prior `subscribe` by exact (project_id, session_id) pair — see
 * routes/ws.ts. */
export interface UnsubscribeFrame {
  readonly type: "unsubscribe";
  readonly project_id?: string;
  readonly session_id?: string;
}

/** Server -> client: heartbeat probe, sent every `WS_HEARTBEAT_INTERVAL_MS`
 * (default 30s — see config.ts's loadWsConfig). A client that wants to stay
 * connected should reply with a `PongFrame` as soon as it sees one. */
export interface PingFrame {
  readonly type: "ping";
}

/** Client -> server: heartbeat reply. Missing two consecutive pings' worth
 * of pongs closes the connection (routes/ws.ts). */
export interface PongFrame {
  readonly type: "pong";
}

/**
 * Server -> client: one stored event. Mirrors `StoredEventRow`
 * (packages/server/src/events/ingest.ts) field-for-field, including the
 * opaque `cursor` — so a client backfilling gaps through
 * `GET /events?since=` after a reconnect and a client watching them arrive
 * live over `/ws` see exactly the same shape, and a client can keep
 * advancing its own `since` cursor from live events too. Typed out here
 * rather than importing StoredEventRow because packages/shared does not
 * depend on packages/server (see this file's header).
 */
export interface EventFrame {
  readonly type: "event";
  readonly event: {
    readonly id: string;
    readonly projectId: string | null;
    readonly sessionId: string | null;
    readonly type: string;
    readonly payload: unknown;
    readonly receivedAt: string;
    readonly cursor: string;
  };
}

/** Frames a client may send. */
export type ClientFrame = SubscribeFrame | UnsubscribeFrame | PongFrame;

/** Frames the server may send. */
export type ServerFrame = EventFrame | PingFrame;

/** Every frame type this protocol defines, either direction. */
export type WsFrame = ClientFrame | ServerFrame;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

/**
 * Runtime guard for a frame the server just JSON.parse'd off the wire — the
 * only thing routes/ws.ts trusts about client input. An unrecognized
 * `type`, or a `project_id`/`session_id` that isn't a string, makes the
 * whole frame invalid (returns false) rather than partially accepted.
 */
export function isClientFrame(value: unknown): value is ClientFrame {
  if (!isPlainObject(value)) return false;
  if (value.type === "pong") return true;
  if (value.type === "subscribe" || value.type === "unsubscribe") {
    return isOptionalString(value.project_id) && isOptionalString(value.session_id);
  }
  return false;
}
