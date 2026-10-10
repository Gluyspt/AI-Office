// PreToolUse -> refresh the lock heartbeat for whatever this session holds.
//
// Ticket 020. Collected automatically by
// features/events/handler-loader.ts, so registering it needed no edit to the
// dispatcher.
//
//
// THE OPEN QUESTION THIS CLOSES
// -----------------------------
// Ticket 015 left it explicitly: "OPEN, and not this ticket's to settle: what
// *triggers* a heartbeat. The design implies `PostToolUse`, which spike 002
// never observed firing and which is absent from the design's own hook block.
// The endpoint exists here; ticket 020 decides what calls it."
//
// This ticket's own open question proposed registering `PostToolUse` in its
// fragment. It does not, and the reasons are in
// `guard-check.ts#heartbeatForSession` — in short: `PostToolUse.tool_response`
// carries the tool's entire output (for a `Write`, everything written), so
// registering it would push a copy of every file an agent touches into the
// event store; `PreToolUse` is strictly more frequent and is already delivered
// to `/events/tool` by the base template with no matcher; and a heartbeat
// hanging off `PostToolUse` goes silent for a task whose calls the guard is
// refusing, expiring the locks of an agent that is demonstrably still working.
//
// So the heartbeat source is the hook entry the design already had, and this
// ticket's fragment adds no `PostToolUse` entry at all. If that turns out to
// be wrong the fix is one fragment file, not a change here.
//
//
// WHAT "RECORDS TOOL EVENTS" MEANS, GIVEN INGEST ALREADY DID
// ---------------------------------------------------------
// The ticket describes this file as recording tool events and refreshing the
// heartbeat. The recording half is already done by the time a handler runs:
// `features/events/ingest.ts` persists the row, publishes it to the bus and
// *then* dispatches to handlers. Re-recording it here would duplicate the row
// (and the file body inside it). So this handler does the half that was
// missing, and the event row is the record.
//
//
// WHY A FAILURE HERE IS SWALLOWED BY THE DISPATCHER, NOT CAUGHT HERE
// ------------------------------------------------------------------
// ingest.ts wraps every handler in a try/catch and logs: "A handler bug must
// not fail the HTTP response ingest already sent 2xx for". This handler
// therefore lets its errors propagate rather than hiding them — a heartbeat
// that stops working should appear in the log, and the alternative (a silent
// catch here) would make the TTL quietly become the primary release path
// again.
import type { EventHandler, HandledEvent } from "../../events/handler-loader.ts";
import { heartbeatForSession } from "../guard-check.ts";

const handler: EventHandler = {
  eventType: "PreToolUse",

  async handle(event: HandledEvent): Promise<void> {
    // A subagent's PreToolUse carries the PARENT's session_id (spike 001
    // §5b: "a subagent is not a separate session"), which is the right
    // answer here — the parent desk holds the locks, and a subagent working
    // inside it is evidence that desk is alive.
    if (event.sessionId === null) return;
    await heartbeatForSession(event.sessionId);
  },
};

export default handler;
