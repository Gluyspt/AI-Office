// Validate, persist, publish, then dispatch — the pipeline every hook POST
// (and every internally-generated system event, like a rejected TLS
// handshake) goes through on its way into the event store.
//
// Design constraints this file exists to satisfy (see
// docs/tasks/005-event-server-ingest.md and docs/spikes/001-hook-payloads.md):
//
//   - Hook delivery is fire-once, never retried, and a non-2xx is visible to
//     the agent (spike §6). A malformed payload must still be accepted
//     (dead-lettered) rather than rejected, or ingest stalls the agent that
//     sent it.
//   - Storage keys on the payload's own `hook_event_name`, never on which
//     /events/<slug> endpoint received the POST, and never on the mere
//     presence of a field like `last_assistant_message` (StopFailure carries
//     that field too, holding an error banner — see
//     packages/shared/src/events.ts).
//   - "Full payload intact" is a hard acceptance criterion even though
//     PostToolUse.tool_response can carry whole file bodies — no truncation.
import { EventEmitter } from "node:events";
import { query } from "../../core/db/pool.ts";
import { loadHandlers, type HandledEvent } from "./handler-loader.ts";

// --- Validation --------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ParsedHookEnvelope {
  readonly hookEventName: string;
  readonly sessionId: string | null;
  readonly raw: Record<string, unknown>;
}

export type ValidationResult =
  | { readonly ok: true; readonly envelope: ParsedHookEnvelope }
  | { readonly ok: false; readonly rawBody: string; readonly reason: string };

/**
 * The only validation ingest performs: the body must be a JSON object with a
 * non-empty string `hook_event_name`. Everything else — every per-event
 * field the shapes in packages/shared/src/events.ts describe — is left
 * unchecked deliberately. The spike is explicit that several event shapes
 * are still unconfirmed (background_tasks/session_crons element shape,
 * whether PreCompact's "auto" trigger looks like "manual" does, what a
 * rate-limited StopFailure carries) and a hook payload not in the captured
 * set at all (TaskCreated/TaskCompleted) must still be stored, not rejected
 * — see loader.ts and the "unknown event type" acceptance criterion.
 */
export function validateHookBody(rawBody: string): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch (error) {
    return { ok: false, rawBody, reason: `invalid JSON: ${(error as Error).message}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, rawBody, reason: "payload is not a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;
  const hookEventName = obj.hook_event_name;
  if (typeof hookEventName !== "string" || hookEventName.length === 0) {
    return { ok: false, rawBody, reason: "missing or non-string hook_event_name" };
  }
  const sessionIdRaw = obj.session_id;
  const sessionId = typeof sessionIdRaw === "string" && UUID_RE.test(sessionIdRaw) ? sessionIdRaw : null;
  return { ok: true, envelope: { hookEventName, sessionId, raw: obj } };
}

// --- Storage -------------------------------------------------------------------

export interface StoredEventRow {
  readonly id: string;
  readonly projectId: string | null;
  readonly sessionId: string | null;
  readonly type: string;
  readonly payload: unknown;
  readonly receivedAt: string;
  /**
   * Opaque pagination cursor: pass the last row's `cursor` back as `since`
   * to get strictly older/newer events with no gap and no duplicate. Do not
   * parse it — the encoding is this module's business. See `parseCursor`.
   */
  readonly cursor: string;
}

interface EventRowDb {
  readonly id: string;
  readonly project_id: string | null;
  readonly session_id: string | null;
  readonly type: string;
  readonly payload: unknown;
  readonly received_at: Date;
  /**
   * `received_at::text` — full microsecond precision, straight from
   * Postgres. `received_at` arrives as a JS Date, which is millisecond-only,
   * so it cannot be used to build a cursor. See the comment on `cursor`.
   */
  readonly received_at_text: string;
}

const CURSOR_SEP = "|";

function toStoredEvent(row: EventRowDb): StoredEventRow {
  return {
    id: row.id,
    projectId: row.project_id,
    sessionId: row.session_id,
    type: row.type,
    payload: row.payload,
    receivedAt: row.received_at.toISOString(),
    cursor: `${row.received_at_text}${CURSOR_SEP}${row.id}`,
  };
}

interface Cursor {
  readonly receivedAt: string;
  readonly id: string | null;
}

/**
 * A cursor is `<received_at::text>|<id>`.
 *
 * Both halves are load-bearing, and each fixes a distinct way a naive
 * timestamp cursor loses or repeats an event:
 *
 *  - **Full precision.** Postgres stores `timestamptz` to the microsecond
 *    (`…09.568813+00`), but a JS `Date` — and therefore `toISOString()` —
 *    only carries milliseconds (`…09.568Z`). Feeding that truncated value
 *    back as `received_at > $1` re-matches the very row it came from,
 *    because 568813µs > 568000µs. Every reconnecting client would see its
 *    last event again.
 *  - **The id tiebreaker.** Two events can share a timestamp outright.
 *    That is not hypothetical here: spike 002 found hooks registered in the
 *    same group fire *concurrently*, so simultaneous inserts are the normal
 *    case under load, not a rare race. With `received_at` alone, one of a
 *    tied pair is silently skipped.
 *
 * A bare timestamp with no `|id` is still accepted, so a hand-typed
 * `?since=2026-09-21T22:39:09Z` works for debugging.
 */
function parseCursor(since: string): Cursor {
  const at = since.lastIndexOf(CURSOR_SEP);
  if (at === -1) return { receivedAt: since, id: null };
  return { receivedAt: since.slice(0, at), id: since.slice(at + 1) };
}

async function persist(
  type: string,
  sessionId: string | null,
  payload: unknown,
  projectId: string | null = null,
): Promise<StoredEventRow> {
  // project_id stays null for hook-sourced events: nothing in a hook
  // payload identifies a project (see 0002_events.sql). Events this
  // process constructs DO know theirs, and must set it — ticket 006's
  // bus filters subscriptions on this column, so an event with a null
  // project never reaches a client watching one board. That was a real
  // gap: 013's TaskCreated was invisible to exactly the subscriber it
  // existed for.
  const result = await query<EventRowDb>(
    `insert into events (session_id, type, payload, project_id)
     values ($1, $2, $3::jsonb, $4)
     returning id, project_id, session_id, type, payload, received_at,
               received_at::text as received_at_text`,
    [sessionId, type, JSON.stringify(payload), projectId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("insert into events returned no row");
  }
  return toStoredEvent(row);
}

// --- Publish -------------------------------------------------------------------
//
// A plain EventEmitter, not the real fan-out bus — ticket 006 owns
// src/events/bus.ts and the WebSocket wiring, and is explicitly not this
// ticket's file to create. This emitter is the seam it attaches to: every
// stored event, "ingested" event name, no consumers yet.
export const ingestEmitter = new EventEmitter();
ingestEmitter.setMaxListeners(0);

function publish(event: StoredEventRow): void {
  ingestEmitter.emit("event", event);
}

// --- Dispatch --------------------------------------------------------------------

function toHandledEvent(event: StoredEventRow): HandledEvent {
  return {
    id: event.id,
    type: event.type,
    sessionId: event.sessionId,
    projectId: event.projectId,
    payload: event.payload,
    receivedAt: new Date(event.receivedAt),
  };
}

async function dispatch(event: StoredEventRow): Promise<void> {
  const byType = await loadHandlers();
  const handlers = byType.get(event.type);
  if (!handlers || handlers.length === 0) {
    // "unknown types are stored and ignored, never rejected" — and equally,
    // a known type with no handler registered yet (most of them, at this
    // ticket) is exactly as fine.
    return;
  }
  const handled = toHandledEvent(event);
  for (const handler of handlers) {
    try {
      await handler.handle(handled);
    } catch (error) {
      // A handler bug must not fail the HTTP response ingest already sent
      // 2xx for (persist+publish happen first) or take down dispatch for
      // any other handler of the same event.
      console.error(`event handler for type ${event.type} threw`, error);
    }
  }
}

async function finalize(
  type: string,
  sessionId: string | null,
  payload: unknown,
  projectId: string | null = null,
): Promise<StoredEventRow> {
  const stored = await persist(type, sessionId, payload, projectId);
  publish(stored);
  await dispatch(stored);
  return stored;
}

// --- Public entry points -----------------------------------------------------

/**
 * The pipeline for a raw hook POST body: validate, persist (dead-lettering
 * on validation failure rather than rejecting), publish, dispatch. Always
 * resolves — never throws for a malformed body, since a hook client gets no
 * retry and a non-2xx is visible to the agent that sent it (spike §6).
 */
export async function ingestHookPayload(rawBody: string): Promise<StoredEventRow> {
  const validation = validateHookBody(rawBody);
  if (validation.ok) {
    return finalize(validation.envelope.hookEventName, validation.envelope.sessionId, validation.envelope.raw);
  }
  return finalize("unparsed", null, { raw: validation.rawBody, reason: validation.reason });
}

/**
 * Same pipeline, for an event this process constructs itself rather than
 * receiving over HTTP — currently only the rejected-TLS-handshake event
 * (server.ts's `tlsClientError` handler). Skips validation because the
 * caller already knows the shape is fine; still persists, publishes and
 * dispatches exactly like a hook-sourced event; so ticket 022's degraded
 * banner and ticket 008's spawn self-test can query it the same way.
 */
export async function recordSystemEvent(
  type: string,
  payload: Record<string, unknown>,
  sessionId: string | null = null,
  projectId: string | null = null,
): Promise<StoredEventRow> {
  return finalize(type, sessionId, payload, projectId);
}

// --- Query (GET /events) --------------------------------------------------------

export interface ListEventsParams {
  readonly projectId: string | null;
  readonly since: string | null;
  readonly limit: number;
}

export async function listEvents(params: ListEventsParams): Promise<StoredEventRow[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (params.projectId) {
    values.push(params.projectId);
    conditions.push(`project_id = $${values.length}`);
  }
  if (params.since) {
    // Keyset pagination on (received_at, id) — a row-value comparison, so
    // Postgres can still use the (project_id, received_at desc) index and
    // ties break deterministically. See parseCursor for why both columns
    // are needed.
    const cursor = parseCursor(params.since);
    if (cursor.id === null) {
      values.push(cursor.receivedAt);
      conditions.push(`received_at > $${values.length}::timestamptz`);
    } else {
      values.push(cursor.receivedAt);
      const tsParam = values.length;
      values.push(cursor.id);
      conditions.push(
        `(received_at, id) > ($${tsParam}::timestamptz, $${values.length}::uuid)`,
      );
    }
  }

  const where = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";
  values.push(params.limit);

  // Order depends on whether a cursor was given, and the two cases answer
  // two different questions:
  //
  //   no `since`  -> "what happened most recently?"  newest-first, the
  //                  default view a page opens on.
  //   `since`     -> "what did I miss?"  oldest-first, walking *forward*
  //                  from the cursor.
  //
  // The second must ascend. A client that was disconnected for 1000 events
  // with limit=50 would, under newest-first, get the newest 50 and have no
  // way to reach the 950 in between — advancing the cursor only skips
  // further ahead. Ascending, it pages forward until a short page tells it
  // it has caught up. Ticket 006 requires exactly this ("a reconnecting
  // client with a since cursor sees no gap and no duplicate").
  const order = params.since ? "received_at asc, id asc" : "received_at desc, id desc";

  const result = await query<EventRowDb>(
    `select id, project_id, session_id, type, payload, received_at,
            received_at::text as received_at_text
     from events
     ${where}
     order by ${order}
     limit $${values.length}`,
    values,
  );
  return result.rows.map(toStoredEvent);
}

// Re-exported so tests (and any future ticket) can point loadHandlers at a
// scratch directory without importing handler-loader.ts directly.
export { loadHandlers };
