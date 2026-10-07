// SessionStart -> mark the registry row `running` and attach the id.
//
// Ticket 008. Collected automatically by features/events/handler-loader.ts
// from features/orchestrator/handlers/ — adding this file needed no edit to
// ingest or the dispatcher.
//
// WHY A HANDLER AND NOT JUST THE startSession PROMISE: a tmux session is not
// one claude session. Ids are single-use and `/clear` ends the claude
// session and rotates the id while the agent keeps working, so SessionStart
// arrives repeatedly over a row's life — once at spawn, and again after
// every `/clear`. The spawn path awaits the first one to prove hooks reach
// ingest; this handler catches all of them, including the ones that arrive
// when nobody is awaiting anything.
//
// Source for the mechanism: docs/spikes/001-hook-payloads.md. Note
// SessionStart arrives via a `command` hook, never an `http` one — ticket
// 009 emits it; this handler only needs it to have reached 005's ingest.
import type { EventHandler, HandledEvent } from "../../events/handler-loader.ts";
import { onSessionStart } from "../sessions.ts";

const handler: EventHandler = {
  eventType: "SessionStart",

  async handle(event: HandledEvent): Promise<void> {
    // The envelope's session_id is the correlation key — chosen by the
    // orchestrator at spawn time and passed to the CLI as `--session-id`,
    // which is what makes this direct rather than a cwd-plus-tmux-name
    // heuristic. An event with no session id cannot be correlated and is
    // not an error: system events (TlsHandshakeRejected) legitimately have
    // none.
    if (event.sessionId === null) return;
    await onSessionStart(event.sessionId);
  },
};

export default handler;
