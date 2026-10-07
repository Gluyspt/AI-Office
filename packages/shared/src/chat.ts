// Chat vocabulary and record shapes: conversations, segments, messages.
//
// Everything here is pure — no database, no Node APIs beyond types — so the
// rules that are easiest to get subtly wrong can be tested without a
// Postgres. Three of them are worth naming up front, because each is a
// measured finding rather than a preference:
//
//  1. **Key on `hook_event_name`, never on the presence of
//     `last_assistant_message`.** `StopFailure` carries that field too,
//     holding the *error banner* text ("Failed to authenticate. API Error:
//     401 …"). Treating "the field is present" as "the agent spoke" renders
//     API errors and rate-limit notices in the chat panel as if the agent
//     had said them. See `carriesAgentReply`.
//
//  2. **`UserPromptSubmit` is not proof a human said anything.** A finishing
//     subagent or background task is injected back into the session *as a
//     new user prompt*, so it fires `UserPromptSubmit` with a body that
//     opens `<agent-message …>` or `<task-notification>`. Rendered naively
//     that is a team member speaking. See `isMachineInjectedPrompt`.
//
//  3. **A turn can end with no turn-end event at all.** Two independent
//     paths were measured: an `Escape` interrupt, and a `PreToolUse`
//     answered `continue:false`. Neither fires `Stop` *or* `StopFailure`.
//     So `Stop` is not a bookend and busy/idle needs a watchdog — see
//     features/chat/handlers/reply.ts.
//
// Source for all three: docs/spikes/001-hook-payloads.md (§2b, §4b, §5b).
//
// This module has no barrel re-export, matching ids.ts / events.ts /
// sessions.ts (see packages/shared's package.json `exports` map): import it
// as `@office/shared/chat`.

import type { ProjectId, SessionId, TaskId } from "./ids.ts";
import type { SessionStatus } from "./sessions.ts";

// --- Subjects ----------------------------------------------------------------

/**
 * What a conversation belongs to.
 *
 * `role_slot` is first-class, not a fallback: Management and department
 * leads never have tasks and still need one continuous history across every
 * respawn, pause, model switch and crash.
 */
export const CONVERSATION_SUBJECT_KINDS = ["task", "role_slot"] as const;

export type ConversationSubjectKind = (typeof CONVERSATION_SUBJECT_KINDS)[number];

export function isConversationSubjectKind(value: unknown): value is ConversationSubjectKind {
  return (
    typeof value === "string" &&
    (CONVERSATION_SUBJECT_KINDS as readonly string[]).includes(value)
  );
}

/**
 * The subject a conversation is resolved by.
 *
 * Note the role slot carries `owner`, where the ticket's wording is
 * "(project, department, role)". The reason is in
 * db/migrations/0004_conversations.sql: for a lead the two keys are
 * identical, and for a worker the three-column key merges every worker in a
 * department into one conversation. The four-column key is exactly the
 * identity tuple 0003_sessions.sql enforces one live desk per.
 */
export type ConversationSubject =
  | { readonly kind: "task"; readonly projectId: ProjectId; readonly taskId: TaskId }
  | {
      readonly kind: "role_slot";
      readonly projectId: ProjectId;
      readonly dept: string;
      readonly role: string;
      readonly owner: string;
    };

// --- Direction ---------------------------------------------------------------

/**
 * `inbound` is the agent speaking to the humans; `outbound` is a human
 * speaking to the agent. Named from the orchestrator's point of view, which
 * is the same direction the hook payloads travel.
 */
export const CHAT_DIRECTIONS = ["inbound", "outbound"] as const;

export type ChatDirection = (typeof CHAT_DIRECTIONS)[number];

export function isChatDirection(value: unknown): value is ChatDirection {
  return typeof value === "string" && (CHAT_DIRECTIONS as readonly string[]).includes(value);
}

// --- Segment boundaries ------------------------------------------------------

/**
 * Why a segment began. Mapped from `SessionStart`'s own `source` field,
 * whose observed values are `startup`, `clear` and `resume`.
 *
 * `unknown` is reachable and is not a bug: `SessionStart` is delivered to a
 * `command` hook only — never to an `http` one, reproduced 5× — so a segment
 * can legitimately be discovered by the first `Stop` that mentions its id.
 */
export const SEGMENT_START_REASONS = ["spawn", "cleared", "resumed", "unknown"] as const;

export type SegmentStartReason = (typeof SEGMENT_START_REASONS)[number];

/**
 * Why a segment ended. This is what the panel's divider says out loud.
 *
 * `paused` and `completed` are in the vocabulary and nothing sets them in
 * steps 1-3: pause is ticket 028, task completion is ticket 017. Both have
 * `closeSegment()` to call when they exist. They are named now because a
 * vocabulary that cannot express them would have to be migrated later.
 */
export const SEGMENT_END_REASONS = [
  /** `/clear` — the claude session ended and the id rotated; the desk kept working. */
  "cleared",
  /** The desk itself went away: `/exit`, process end, `tmux kill-session`. */
  "exited",
  /** The task finished. Ticket 017 sets this. */
  "completed",
  /** Ticket 028 sets this. */
  "paused",
  /** The desk reached `failed` — the pane died, the login expired, hooks never arrived. */
  "crash",
  /** Respawned on a different model. Inferred from the model changing across desks. */
  "model_switch",
  /** A new desk took the slot while the old one still looked live. */
  "replaced",
  /** Honestly unknown. Preferred over guessing: the divider says so. */
  "unknown",
] as const;

export type SegmentEndReason = (typeof SEGMENT_END_REASONS)[number];

export function isSegmentEndReason(value: unknown): value is SegmentEndReason {
  return typeof value === "string" && (SEGMENT_END_REASONS as readonly string[]).includes(value);
}

/**
 * `SessionStart.source` -> our start-reason vocabulary.
 *
 * The field is called `source` on 2.1.278, not `session_start_type` as the
 * public reference says. Trust the capture.
 */
export function startReasonFromSource(source: unknown): SegmentStartReason {
  if (source === "startup") return "spawn";
  if (source === "clear") return "cleared";
  if (source === "resume") return "resumed";
  return "unknown";
}

/**
 * `SessionEnd.reason` -> our end-reason vocabulary. Observed values are
 * `clear`, `other` and `prompt_input_exit`.
 *
 * Note `clear` is the one that matters most and the one 008 deliberately
 * ignores: `SessionEnd` with `reason: "clear"` fires **while the agent
 * keeps working**, so it does not end the desk — but it absolutely does end
 * the *segment*, because the claude session id rotates. This ticket's
 * boundaries are exactly where 008's are not.
 */
export function endReasonFromSessionEnd(reason: unknown): SegmentEndReason {
  if (reason === "clear") return "cleared";
  if (reason === "prompt_input_exit" || reason === "other") return "exited";
  return "unknown";
}

/**
 * What ended the previous segment, when nobody told us directly.
 *
 * Pure, ordered rules over facts the orchestrator actually has. The first
 * matching rule wins, and the ordering is the content:
 *
 *  1. A reported `SessionEnd.reason` beats every inference — it came from
 *     the session itself.
 *  2. Same desk, new claude session id: on a live desk the *only* mechanism
 *     that rotates the id is `/clear` (`/compact` does not — measured). So
 *     this is `cleared`, and it is a fact rather than a guess.
 *  3. A different desk, and the old one is `failed`: `crash`. The registry
 *     already distinguishes "hooks never arrived" from "handshake
 *     rejected"; either way the desk did not end on purpose.
 *  4. A different desk that ended cleanly, on a different model: the
 *     orchestrator respawned it to switch models. Live model switching is
 *     unavailable until step 11, so a switch *is* a respawn — which is why
 *     this is inferable at all.
 *  5. A different desk that ended cleanly, same model: `exited`.
 *  6. A different desk while the old one still looked live: `replaced`.
 *     Note this is the shape an unnoticed crash also takes, which is why it
 *     is its own value rather than being folded into `crash`.
 */
export interface SegmentEndFacts {
  /** Is the replacing segment on the same registry session row? */
  readonly sameDesk: boolean;
  readonly previousSessionStatus: SessionStatus;
  readonly previousModel: string | null;
  readonly newModel: string | null;
  /** `SessionEnd.reason`, when one was delivered for the previous segment. */
  readonly reportedReason: string | null;
}

export function inferSegmentEndReason(facts: SegmentEndFacts): SegmentEndReason {
  if (facts.reportedReason !== null) return endReasonFromSessionEnd(facts.reportedReason);
  if (facts.sameDesk) return "cleared";
  if (facts.previousSessionStatus === "failed") return "crash";
  if (facts.previousSessionStatus === "ended") {
    const switched =
      facts.previousModel !== null &&
      facts.newModel !== null &&
      facts.previousModel !== facts.newModel;
    return switched ? "model_switch" : "exited";
  }
  return "replaced";
}

// --- Outbound delivery -------------------------------------------------------

/**
 * How an outbound message is getting on. Recorded **before** delivery is
 * attempted, so a message that never arrives is still in the transcript
 * with an honest marker instead of vanishing.
 *
 * `queued` is the interesting one. A message delivered while a permission
 * dialog is open **approves the pending tool call** — confirmed on the
 * target host 20/20, with the approved command's file left on disk — so
 * ticket 008 refuses to deliver into a dialog and leaves the message
 * pending in its own queue. From the transcript's point of view that is
 * neither delivered nor failed.
 */
export const OUTBOUND_DELIVERY_STATUSES = ["pending", "delivered", "queued", "failed"] as const;

export type OutboundDeliveryStatus = (typeof OUTBOUND_DELIVERY_STATUSES)[number];

export function isOutboundDeliveryStatus(value: unknown): value is OutboundDeliveryStatus {
  return (
    typeof value === "string" && (OUTBOUND_DELIVERY_STATUSES as readonly string[]).includes(value)
  );
}

// --- Reading a hook payload --------------------------------------------------

/**
 * The one hook event that means "the agent spoke".
 *
 * NOT a list, and not `hook_event_name.startsWith("Stop")`. `StopFailure`
 * carries `last_assistant_message` holding an error banner, and
 * `SubagentStop` carries it holding — 6 times out of 7 observed — the TUI's
 * own *suggested follow-up prompt* for Claude Code's internal agents.
 * Neither is the agent talking to the office.
 */
export const REPLY_EVENT_TYPE = "Stop";

export function carriesAgentReply(hookEventName: unknown): boolean {
  return hookEventName === REPLY_EVENT_TYPE;
}

/**
 * The agent's reply text from a `Stop` payload, or null when the turn
 * produced none.
 *
 * `last_assistant_message` is the turn's last *assistant text block*,
 * verbatim — never tool output. A turn that emits text, calls a tool and
 * emits more text yields only the final text; a turn that halts *at* a tool
 * call fires no `Stop` at all.
 *
 * Returns the string **unmodified** when it has content: "verbatim" is an
 * acceptance criterion, so leading and trailing whitespace are part of the
 * message. The trim is used only to decide emptiness — a whitespace-only
 * reply is not a reply, and appending it would put an empty bubble in the
 * panel.
 */
export function assistantReplyBody(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const raw = (payload as { last_assistant_message?: unknown }).last_assistant_message;
  if (typeof raw !== "string") return null;
  return raw.trim() === "" ? null : raw;
}

/** The turn a payload belongs to. `prompt_id` is on every captured payload
 *  except `SessionStart`. */
export function turnIdOf(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const raw = (payload as { prompt_id?: unknown }).prompt_id;
  return typeof raw === "string" && raw !== "" ? raw : null;
}

/**
 * Is this `UserPromptSubmit` body machine injection rather than a person?
 *
 * A finished subagent or background task is handed back to the session as a
 * *new user prompt*, wrapping the result in `<agent-message …>` or
 * `<task-notification>`. Keying on structure, never on the event's mere
 * arrival, is the same discipline `carriesAgentReply` applies to
 * `last_assistant_message`.
 *
 * Used here to label a turn as machine-initiated, so a watchdog that gives
 * up on it does not report "you asked and got nothing" to a human who asked
 * nothing.
 */
export function isMachineInjectedPrompt(prompt: unknown): boolean {
  if (typeof prompt !== "string") return false;
  const head = prompt.trimStart();
  return head.startsWith("<agent-message") || head.startsWith("<task-notification>");
}

// --- Records -----------------------------------------------------------------

export interface ConversationRecord {
  readonly id: string;
  readonly projectId: ProjectId;
  readonly subjectKind: ConversationSubjectKind;
  readonly taskId: TaskId | null;
  readonly dept: string | null;
  readonly role: string | null;
  readonly owner: string | null;
  /** Read as text, never as a Date — see the timestamp note in chat_messages. */
  readonly createdAt: string;
}

export interface ConversationSegmentRecord {
  readonly id: string;
  readonly conversationId: string;
  /** The desk (ticket 008's registry row). */
  readonly sessionId: SessionId;
  /** The claude session this segment *is*. Null only before the desk reported one. */
  readonly claudeSessionId: string | null;
  readonly ordinal: number;
  readonly owner: string;
  readonly model: string | null;
  readonly startReason: SegmentStartReason;
  readonly endReason: SegmentEndReason | null;
  /**
   * Why the segment BEFORE this one ended — the text the divider shows.
   * Derived by reading the predecessor rather than stored twice, so the two
   * copies cannot disagree. Null on the first segment of a conversation.
   */
  readonly previousEndReason: SegmentEndReason | null;
  /** Always false in steps 1-3. Handoffs are steps 4 and 5. */
  readonly restoredFromHandoff: boolean;
  readonly startedAt: string;
  readonly endedAt: string | null;
}

export interface ChatMessageRecord {
  readonly id: string;
  readonly conversationId: string;
  readonly sessionId: SessionId;
  readonly segmentId: string;
  readonly direction: ChatDirection;
  readonly author: string;
  readonly body: string;
  readonly turnId: string | null;
  readonly deliveryStatus: OutboundDeliveryStatus | null;
  readonly deliveryDetail: string | null;
  readonly queuedMessageId: string | null;
  /** Monotonic send order. Ordering key; the clock is display only. */
  readonly seq: number;
  readonly createdAt: string;
}

export interface TranscriptPage {
  /** Oldest first within the page, however the page was reached. */
  readonly messages: readonly ChatMessageRecord[];
  /**
   * Opaque. Pass back as `before` to read the page before this one. Null
   * when the conversation has nothing older.
   */
  readonly nextBefore: string | null;
}

// --- Event types this feature emits -------------------------------------------

/**
 * Every transcript write announces itself through ticket 005's ingest, so it
 * reaches the WebSocket stream and the chat panel updates without polling.
 * Named here rather than as string literals at the call sites so the web app
 * can switch on them — and so the watchdog can ignore this feature's own
 * events without matching on prefixes.
 */
export const CHAT_EVENT_TYPES = [
  "ChatMessageAppended",
  "ChatMessageDelivery",
  "ChatReplyOrphaned",
  "ConversationSegmentOpened",
  "ConversationSegmentClosed",
  /** The watchdog gave up: a turn started and no turn-end event ever came. */
  "AgentTurnAbandoned",
] as const;

export type ChatEventType = (typeof CHAT_EVENT_TYPES)[number];

export function isChatEventType(value: unknown): value is ChatEventType {
  return typeof value === "string" && (CHAT_EVENT_TYPES as readonly string[]).includes(value);
}
