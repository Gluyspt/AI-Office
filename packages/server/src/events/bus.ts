// In-process publish/subscribe fan-out for stored events, built on top of
// the seam ticket 005 left in ingest.ts: `ingestEmitter` emits `"event"`
// with a `StoredEventRow` for every event that gets persisted, and had no
// consumers until this file. See docs/tasks/006-websocket-fanout.md.
//
// Deliberately not a queue: a subscription only ever sees events published
// *while it is subscribed*. There is no buffer, no replay, and nothing here
// touches the database — an event published while nobody is connected is
// simply not delivered to anyone (this ticket's acceptance criterion 3). A
// client that missed events backfills through `GET /events?since=`
// (ticket 005's cursor — see events/ingest.ts's `listEvents`), which is
// exactly why that endpoint exists alongside this bus rather than this bus
// growing a history of its own.
import { ingestEmitter } from "./ingest.ts";
import type { StoredEventRow } from "./ingest.ts";

export type BusListener = (event: StoredEventRow) => void;

/**
 * What a subscription matches on. Both fields are optional and, when both
 * are given, an event must satisfy both to be delivered (AND, not OR).
 *
 * KNOWN LIMITATION — read before relying on `projectId`: nothing populates
 * `project_id` on a stored event until tickets 008/010 map a session to a
 * project (see docs/tasks/006's "Critical context for criterion 3" and
 * events/ingest.ts's `persist`, which never writes the column). Every event
 * ingest.ts stores today therefore has `projectId === null`, so a
 * project-scoped subscription matches nothing against real hook traffic
 * yet — it is not silently "matching everything" or broken, it is honestly
 * comparing a column that is always null right now. This filter is
 * exercised in bus.test.ts against synthetic rows that do carry a
 * project_id (fed through this same `ingestEmitter` seam, not a mock of
 * this module), proving the matching mechanism itself is correct and ready
 * for the day something populates the column. Do not invent a
 * session-to-project mapping here to make it "work" sooner — that mapping
 * is explicitly out of this ticket's scope.
 */
export interface SubscriptionFilter {
  readonly projectId?: string;
  readonly sessionId?: string;
}

interface Subscription {
  readonly id: number;
  readonly filter: SubscriptionFilter;
  readonly listener: BusListener;
}

let nextSubscriptionId = 1;
const subscriptions = new Map<number, Subscription>();

function matchesFilter(filter: SubscriptionFilter, event: StoredEventRow): boolean {
  if (filter.projectId !== undefined && event.projectId !== filter.projectId) return false;
  if (filter.sessionId !== undefined && event.sessionId !== filter.sessionId) return false;
  return true;
}

function onIngestEvent(event: StoredEventRow): void {
  // Snapshot into an array before iterating: a listener throwing removes
  // itself from `subscriptions` mid-loop (see the catch below), and a
  // listener may also synchronously subscribe/unsubscribe (routes/ws.ts's
  // heartbeat teardown does, on the same tick a slow-consumer disconnect
  // happens) — mutating a Map while iterating its `.values()` is well
  // enough defined in JS not to crash, but copying first keeps this
  // function's behaviour independent of that guarantee.
  for (const sub of [...subscriptions.values()]) {
    if (!matchesFilter(sub.filter, event)) continue;
    try {
      sub.listener(event);
    } catch (error) {
      // A subscriber (e.g. a socket mid-close) throwing must not stop the
      // same event reaching every other subscriber, and must not throw back
      // into ingest.ts's publish() — that call sits directly in the ingest
      // HTTP request path (see ingest.ts's `finalize`), so an unhandled
      // throw here would fail a hook POST over a WebSocket problem.
      console.error("bus subscriber threw; removing it", error);
      subscriptions.delete(sub.id);
    }
  }
}

let attachedToIngest = false;
function ensureAttached(): void {
  if (attachedToIngest) return;
  ingestEmitter.on("event", onIngestEvent);
  attachedToIngest = true;
}

/**
 * Subscribe to every future event matching `filter`. `listener` runs
 * synchronously, in the same call stack as the ingest request that
 * published the event (see ingest.ts's `publish`) — it must never block or
 * await I/O, or every hook POST pays for the slowest subscriber. This is
 * why routes/ws.ts only ever does a non-blocking `socket.send()` here, and
 * disconnects (rather than waits on) a subscriber whose outbound buffer is
 * already backed up.
 *
 * Returns an unsubscribe function. There is no timeout or external reaper —
 * calling it is the only way a subscription goes away, so a caller that
 * forgets to call it on disconnect leaks a subscription forever. routes/ws.ts
 * calls it from the socket's `close` (and `error`) handling, which is what
 * makes this ticket's "100 connect/disconnect cycles -> subscriber count
 * returns to zero" criterion hold.
 */
export function subscribe(filter: SubscriptionFilter, listener: BusListener): () => void {
  ensureAttached();
  const id = nextSubscriptionId++;
  subscriptions.set(id, { id, filter, listener });
  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;
    subscriptions.delete(id);
  };
}

/** Number of live subscriptions. Used by routes/ws.ts's tests (criterion:
 * after 100 connect/disconnect cycles this returns to zero) and by
 * bus.test.ts. Not used by any production code path. */
export function subscriberCount(): number {
  return subscriptions.size;
}

/**
 * Test-only reset: detaches from `ingestEmitter` and drops every
 * subscription. Vitest gives each test *file* its own module registry but
 * shares it across every `it()` in that file (see vitest.config.ts — no
 * per-test isolation), so without this, a subscription left over from one
 * test in bus.test.ts would still be live (and still receive events) in the
 * next. Mirrors the test seams ticket 005 already established — e.g.
 * `loadHandlers(dir)`'s directory override in handlers/loader.ts — rather
 * than inventing a new pattern.
 */
export function __resetForTests(): void {
  if (attachedToIngest) {
    ingestEmitter.off("event", onIngestEvent);
    attachedToIngest = false;
  }
  subscriptions.clear();
  nextSubscriptionId = 1;
}
