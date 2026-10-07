// SessionEnd -> mark the registry row `ended`, EXCEPT on `/clear`.
//
// Ticket 008. Collected automatically by features/events/handler-loader.ts.
//
// This handler is what makes the criterion "a SessionEnd marks the row
// ended even when the kill came from outside the orchestrator" true —
// someone running `tmux kill-session` by hand, or an agent exiting on its
// own, both arrive here rather than through the API.
//
// THE TRAP THIS FILE EXISTS TO AVOID. `SessionEnd` does not mean the agent
// stopped. It fires with `reason: "clear"` while the agent keeps working,
// because `/clear` ends the *claude* session and rotates its id without
// touching the tmux session. Ending the registry row on that would kill a
// live desk's record and leave an orphan tmux session nobody is tracking —
// the row would say `ended` while the agent carried on spending tokens.
// Observed reasons: `clear`, `other`, `prompt_input_exit`.
// Source: docs/spikes/001-hook-payloads.md.
//
// The exclusion list lives in ../sessions.ts next to the function that
// applies it, not here, so the rule is testable without going through the
// dispatcher.
import type { EventHandler, HandledEvent } from "../../events/handler-loader.ts";
import { onSessionEnd } from "../sessions.ts";

/** The hook payload's own field. Absent on a payload we did not shape. */
function reasonOf(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const raw = (payload as { reason?: unknown }).reason;
  return typeof raw === "string" && raw !== "" ? raw : null;
}

const handler: EventHandler = {
  eventType: "SessionEnd",

  async handle(event: HandledEvent): Promise<void> {
    if (event.sessionId === null) return;
    // A null reason is treated as "really ended". That is the conservative
    // direction: the alternative — ignoring an end we cannot classify —
    // would leave a dead desk marked `running` forever, and a stale
    // `running` row is worse than a premature `ended` one, because the UI
    // offers to message it.
    await onSessionEnd(event.sessionId, reasonOf(event.payload));
  },
};

export default handler;
