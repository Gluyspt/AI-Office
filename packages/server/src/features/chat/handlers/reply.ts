// Stop -> the agent's reply, into the transcript. Plus the turn-end
// watchdog, because `Stop` is not a bookend.
//
// Ticket 010. Collected automatically by features/events/handler-loader.ts
// from features/chat/handlers/ — adding this file needed no edit to ingest
// or the dispatcher.
//
// THREE THINGS THIS FILE EXISTS TO GET RIGHT
//
// 1. **Key on the event type, never on the presence of
//    `last_assistant_message`.** The loader keys this module on `"Stop"`,
//    which is the whole defence: `StopFailure` carries the same field
//    holding the *error banner* ("Failed to authenticate. API Error: 401 …")
//    and `SubagentStop` carries it holding — 6 times in 7 observed — the
//    TUI's own suggested follow-up prompt for Claude Code's internal
//    agents. Either one rendered as agent speech would put words in a team
//    member's mouth. This is named in the ticket as "the single most likely
//    way to get this ticket subtly wrong".
//
// 2. **A turn that produced no assistant text appends nothing.** A turn that
//    halts *at* a tool call fires no `Stop` at all; one that ends in a tool
//    call and then speaks puts only the final text in the field. So an
//    absent or whitespace-only field means "no reply", not "empty reply",
//    and an empty bubble in the panel would be a lie about what happened.
//
// 3. **A turn can end with no turn-end event whatsoever.** Measured twice
//    on two independent paths: an `Escape` interrupt, and a `PreToolUse`
//    answered `continue:false`. Neither fires `Stop` *or* `StopFailure` —
//    the only event for an interrupted turn is the `UserPromptSubmit` that
//    opened it. Anything treating `Stop` as guaranteed sits "thinking"
//    forever the first time a human hits Escape. Hence the watchdog below,
//    which ticket 008 names this ticket as the owner of ("this module
//    exposes no isBusy(); state comes from events, and the watchdog is
//    ticket 010's").
//
// Source for all of it: docs/spikes/001-hook-payloads.md §2b, §4b, §5, §5b.
import { performance } from "node:perf_hooks";
import {
  assistantReplyBody,
  isMachineInjectedPrompt,
  startReasonFromSource,
  turnIdOf,
} from "@office/shared/chat";
import type { SessionRecord } from "@office/shared/sessions";
import { loadChatConfig } from "../../../core/config.ts";
import { subscribe } from "../../events/bus.ts";
import { recordSystemEvent, type StoredEventRow } from "../../events/ingest.ts";
import type { EventHandler, HandledEvent } from "../../events/handler-loader.ts";
import { findSegmentByClaudeSessionId, findSessionByClaudeSessionId, openOrResumeSegment } from "../conversations.ts";
import { appendMessage, recordOrphanedReply } from "../transcript.ts";

/** How an agent is labelled in the transcript. The owner (the Linux account)
 *  is on the segment, not repeated here — it is a property of the desk, and
 *  a reassignment is a segment boundary. */
function agentAuthor(session: SessionRecord): string {
  return `agent:${session.role}:${session.dept}`;
}

/** `SessionStart.source`, when this Stop happens to be the first event of a
 *  segment. Usually absent on a Stop; present only because nothing stops a
 *  payload from carrying extra fields. */
function sourceOf(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null) return null;
  return (payload as { source?: unknown }).source ?? null;
}

// --- The handler ---------------------------------------------------------------------

const handler: EventHandler = {
  eventType: "Stop",

  async handle(event: HandledEvent): Promise<void> {
    // No session id means no correlation key at all. The spike found
    // `session_id` on *every* payload including the first `SessionStart`, so
    // this is a malformed or forged POST rather than a normal event — and
    // ingest accepts those deliberately (a non-2xx is visible to the agent
    // and there is no retry). Keep it rather than discard it.
    if (event.sessionId === null) {
      await recordOrphanedReply({
        eventId: event.id,
        claudeSessionId: null,
        payload: event.payload,
        body: assistantReplyBody(event.payload),
        reason: "Stop payload carried no usable session_id",
      });
      return;
    }

    const body = assistantReplyBody(event.payload);
    const session = await findSessionByClaudeSessionId(event.sessionId);
    if (!session) {
      // Reachable in production: a desk started outside the orchestrator, a
      // database restored from before the desk existed, or a forged POST.
      // Stored intact and logged, never dropped — the payload is the only
      // record of what the agent said.
      await recordOrphanedReply({
        eventId: event.id,
        claudeSessionId: event.sessionId,
        payload: event.payload,
        body,
        reason: "no session row matches this claude session id",
      });
      return;
    }

    // Resolve the segment even for a turn with no text: the desk is live and
    // the panel needs its segment to exist to say so. This is also where a
    // `/clear` boundary gets drawn, if this Stop is the first thing seen
    // under a rotated id.
    const { conversation, segment } = await openOrResumeSegment({
      session,
      claudeSessionId: event.sessionId,
      startReason: startReasonFromSource(sourceOf(event.payload)),
    });

    if (body === null) {
      // Criterion: "a turn that ends with no assistant text (tool call only,
      // or an interrupted turn) does not append an empty message." Nothing
      // to append, and nothing is wrong — not logged, because a tool-only
      // turn is ordinary and a warning per turn is noise.
      return;
    }

    const { inserted } = await appendMessage({
      conversationId: conversation.id,
      segmentId: segment.id,
      sessionId: session.id,
      projectId: session.projectId,
      claudeSessionId: event.sessionId,
      direction: "inbound",
      author: agentAuthor(session),
      // Verbatim. `assistantReplyBody` trims only to decide emptiness and
      // returns the original string untouched.
      body,
      turnId: turnIdOf(event.payload),
    });

    if (!inserted) {
      console.warn(
        `[chat] duplicate Stop for turn ${String(turnIdOf(event.payload))} on segment ` +
          `${segment.id}; the reply was already recorded`,
      );
    }
  },
};

export default handler;

// --- The turn-end watchdog --------------------------------------------------------------
//
// WHY IT READS THE BUS INSTEAD OF BEING A SECOND HANDLER FILE. The watchdog
// is armed by `UserPromptSubmit` and disarmed by `Stop` / `StopFailure` /
// `SessionEnd`. The handler-loader contract is one module per event type, so
// four event types would mean four files — and this ticket owns exactly one
// file under handlers/. Ticket 006's in-process bus already sees every
// stored event, so the watchdog subscribes there. Its listener runs
// synchronously inside ingest's request path, which is why arming and
// disarming are nothing but a Map write and a timer; the only database work
// happens on the timer, long after the request has returned.
//
// WHAT IT DOES NOT DO: it never appends a message. A turn that vanished
// produced no assistant text, and inventing a "(no reply)" line would be the
// empty-bubble lie criterion 11 forbids. It emits `AgentTurnAbandoned` so
// the panel can stop showing a spinner, and nothing else.

interface ArmedTurn {
  readonly claudeSessionId: string;
  readonly turnId: string | null;
  /** A finished subagent or background task is injected back as a synthetic
   *  `UserPromptSubmit`. Such a turn is real and worth watching, but the UI
   *  must not tell a human "you asked and got nothing" when nobody asked. */
  readonly machineInitiated: boolean;
  /** Monotonic. `Date.now()` is not usable for a duration here: the target
   *  host's wall clock was observed stepping backwards twice in one session,
   *  which is exactly how an "impossible" negative duration gets reported as
   *  a fast path. `performance.now()` cannot go backwards. */
  readonly armedAtMono: number;
  readonly timer: NodeJS.Timeout;
}

const armedTurns = new Map<string, ArmedTurn>();

/** `undefined` = not read yet, `null` = unavailable, so the watchdog is off. */
let watchdogWindowMs: number | null | undefined;
let watchdogConfigComplained = false;

/**
 * The window, read lazily and cached.
 *
 * `CHAT_TURN_WATCHDOG_MS` is required with no default (see config.ts for
 * why), and this is reached from inside a bus listener on the ingest path —
 * so a missing value must not throw. Throwing here would propagate into
 * ticket 006's bus, which removes a throwing subscriber: the watchdog would
 * disable itself *silently*, which is the failure shape this whole system
 * keeps trying to avoid. It complains once, loudly, and stays off until
 * configured.
 */
function windowMs(): number | null {
  if (watchdogWindowMs !== undefined) return watchdogWindowMs;
  try {
    watchdogWindowMs = loadChatConfig().turnWatchdogMs;
  } catch (error) {
    watchdogWindowMs = null;
    if (!watchdogConfigComplained) {
      watchdogConfigComplained = true;
      console.error(
        "[chat] the turn-end watchdog is DISABLED because CHAT_TURN_WATCHDOG_MS is not set. " +
          "An interrupted turn fires no Stop and no StopFailure (measured twice), so without " +
          "this a desk will show as thinking forever the first time someone hits Escape.",
        error,
      );
    }
  }
  return watchdogWindowMs;
}

function disarmTurn(claudeSessionId: string): void {
  const armed = armedTurns.get(claudeSessionId);
  if (!armed) return;
  clearTimeout(armed.timer);
  armedTurns.delete(claudeSessionId);
}

function armTurn(event: StoredEventRow): void {
  const claudeSessionId = event.sessionId;
  if (claudeSessionId === null) return;
  const ms = windowMs();
  if (ms === null) return;

  // A second prompt submitted while a turn is still running (the mid-turn
  // message case ticket 008's queue exists for) re-arms rather than stacking.
  // The desk is still busy, so the window should start again.
  disarmTurn(claudeSessionId);

  const payload = event.payload as { prompt?: unknown } | null;
  const timer = setTimeout(() => {
    void fireWatchdog(claudeSessionId);
  }, ms);
  // Never hold the process open waiting for a turn that may never end.
  timer.unref?.();

  armedTurns.set(claudeSessionId, {
    claudeSessionId,
    turnId: turnIdOf(event.payload),
    machineInitiated: isMachineInjectedPrompt(payload?.prompt),
    armedAtMono: performance.now(),
    timer,
  });
}

async function fireWatchdog(claudeSessionId: string): Promise<void> {
  const armed = armedTurns.get(claudeSessionId);
  if (!armed) return;
  armedTurns.delete(claudeSessionId);

  const waitedMs = Math.round(performance.now() - armed.armedAtMono);
  try {
    const session = await findSessionByClaudeSessionId(claudeSessionId);
    const segment = await findSegmentByClaudeSessionId(claudeSessionId);
    console.warn(
      `[chat] turn watchdog fired for claude session ${claudeSessionId} after ${waitedMs}ms ` +
        `with no Stop or StopFailure. An interrupted turn and a PreToolUse answered ` +
        `continue:false both end a turn silently; this is how the desk stops looking busy.`,
    );
    await recordSystemEvent(
      "AgentTurnAbandoned",
      {
        claude_session_id: claudeSessionId,
        session_id: session?.id ?? null,
        conversation_id: segment?.conversationId ?? null,
        segment_id: segment?.id ?? null,
        turn_id: armed.turnId,
        machine_initiated: armed.machineInitiated,
        waited_ms: waitedMs,
      },
      claudeSessionId,
      // Null only when the desk cannot be found at all. Ticket 006's bus
      // filters on this column, so a null one reaches no project-scoped
      // subscriber — which is why the lookup above happens even though the
      // event would be valid without it.
      session?.projectId ?? null,
    );
  } catch (error) {
    console.error("[chat] turn watchdog failed to report an abandoned turn", error);
  }
}

/**
 * Arming signals, read off ticket 006's bus.
 *
 * `SessionEnd` disarms regardless of its reason. 008 deliberately does *not*
 * end a desk's row on `reason: "clear"` because the agent keeps working —
 * but the *turn* is over either way, because `/clear` rotates the claude
 * session id and nothing further will ever arrive under the old one.
 */
function onBusEvent(event: StoredEventRow): void {
  if (event.sessionId === null) return;
  switch (event.type) {
    case "UserPromptSubmit":
      armTurn(event);
      return;
    case "Stop":
    case "StopFailure":
    case "SessionEnd":
      disarmTurn(event.sessionId);
      return;
    default:
      // Everything else, this feature's own events included, is ignored.
      // That is also what stops `AgentTurnAbandoned` — which goes through
      // ingest and therefore back through this listener — from looping.
      return;
  }
}

let unsubscribe: (() => void) | null = null;

/**
 * Subscribed at module load, which is the only hook available: `app.ts` and
 * `server.ts` belong to ticket 005 and cannot be edited, and arming from
 * inside `handle()` would start the watchdog only after the first `Stop` —
 * i.e. after the first turn it was supposed to be watching. The
 * handler-loader imports every handler module on the first dispatched event,
 * so the watchdog is live from the first event the server ingests.
 */
function ensureSubscribed(): void {
  if (unsubscribe !== null) return;
  unsubscribe = subscribe({}, onBusEvent);
}

ensureSubscribed();

// --- Test seams -----------------------------------------------------------------------

export function armedTurnCount(): number {
  return armedTurns.size;
}

/** Overrides the configured window, so a test does not wait a real one.
 *  `null` disables the watchdog. */
export function __setWatchdogWindowForTests(ms: number | null): void {
  watchdogWindowMs = ms;
}

/** Clears every armed turn and forgets the cached config, keeping the
 *  subscription. Vitest shares a module registry across every `it()` in a
 *  file, so an armed turn would otherwise leak into the next test. */
export function __resetWatchdogForTests(): void {
  for (const armed of armedTurns.values()) clearTimeout(armed.timer);
  armedTurns.clear();
  watchdogWindowMs = undefined;
  watchdogConfigComplained = false;
  // Re-subscribe rather than assume the subscription survived: ticket 006's
  // `bus.__resetForTests()` drops every subscription, and a test file that
  // calls it would otherwise leave this listener detached while
  // `unsubscribe` still looked set.
  if (unsubscribe !== null) {
    unsubscribe();
    unsubscribe = null;
  }
  ensureSubscribed();
}
