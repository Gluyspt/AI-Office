// The OfficeEvent union and per-event payload types.
//
// These shapes are modeled directly on the *actually captured* hook payloads
// in docs/spikes/001-hook-payloads.md §5 ("Captured payloads") — not on the
// design doc's sketch of them, and not on the public Claude Code hooks
// reference, which the spike found wrong in several places (field names,
// which fields block, which event reaches which hook type). Anything the
// spike explicitly says is unconfirmed or unobserved is typed loosely
// (`unknown`, or a union with a string fallback) rather than invented.
//
// This module has no barrel re-export by design (see packages/shared's
// package.json `exports` map): import it as `@office/shared/events`.

/**
 * Fields the spike found on (almost) every payload: "Every payload carried
 * session_id, transcript_path, cwd, hook_event_name, and — except on
 * SessionStart — prompt_id. Most carried scratchpad_dir; some carried
 * permission_mode and effort.level." (§5, "Common envelope").
 *
 * Kept as a loose base — not every field is required on every event, and a
 * future Claude Code version may add more. Ingest validates only the two
 * fields it actually keys on (hook_event_name, session_id); it does not
 * enforce the rest of this shape. See events/ingest.ts.
 */
export interface HookEnvelope {
  readonly session_id: string;
  readonly transcript_path: string;
  readonly cwd: string;
  readonly hook_event_name: string;
  readonly scratchpad_dir?: string;
  readonly prompt_id?: string;
  readonly permission_mode?: string;
  readonly effort?: { readonly level: string };
}

// --- SessionStart -----------------------------------------------------------
//
// Delivered to a `command` hook only — never to an `http` hook (spike §7,
// reproduced 3x). Ingest must accept this shape regardless of which hook
// type produced the POST; see events/ingest.ts and this ticket's report for
// the exact wire shape ticket 009's command script must emit (raw payload,
// unwrapped — identical to what's below).
//
// `source` is called `session_start_type` in the public reference; it is
// `source` on the captured 2.1.278 payload. There is no `permission_mode` on
// this event.
export interface SessionStartEvent extends HookEnvelope {
  readonly hook_event_name: "SessionStart";
  readonly source: "startup" | "resume" | "clear" | (string & {});
  readonly model?: string;
}

// --- SessionEnd --------------------------------------------------------------
//
// `reason` values observed: `prompt_input_exit` (/exit), `clear` (/clear,
// fires *without* the session ending), `other` (process end / tmux kill).
export interface SessionEndEvent extends HookEnvelope {
  readonly hook_event_name: "SessionEnd";
  readonly reason: "prompt_input_exit" | "clear" | "other" | (string & {});
}

// --- StopFailure ---------------------------------------------------------------
//
// Carries `last_assistant_message` too, holding the error banner rather than
// agent prose — this is why ingest must key on hook_event_name, never on the
// mere presence of last_assistant_message (Decided item on ticket 005).
// `error` is a short code (e.g. "authentication_failed"), not the
// `error_type`/`error_message` pair the public reference describes.
export interface StopFailureEvent extends HookEnvelope {
  readonly hook_event_name: "StopFailure";
  readonly error: string;
  readonly last_assistant_message?: string;
}

// --- Stop ----------------------------------------------------------------------
//
// `last_assistant_message` is the turn's last *assistant text block*,
// verbatim — never tool output. `background_tasks` / `session_crons` were
// empty arrays in every capture; their element shape is unknown (spike
// explicitly declines to model it from an empty sample).
export interface StopEvent extends HookEnvelope {
  readonly hook_event_name: "Stop";
  readonly stop_hook_active: boolean;
  readonly last_assistant_message?: string;
  readonly background_tasks?: readonly unknown[];
  readonly session_crons?: readonly unknown[];
}

// --- PreToolUse / PostToolUse ---------------------------------------------------
export interface PreToolUseEvent extends HookEnvelope {
  readonly hook_event_name: "PreToolUse";
  readonly tool_name: string;
  readonly tool_input: Record<string, unknown>;
  readonly tool_use_id: string;
}

/**
 * `tool_response` carries the tool's *entire* output — the whole file body
 * for a Read, the whole written content for a Write (spike §5, §9). Its
 * shape varies per tool and Claude Code's own dedup ("file_unchanged") drops
 * the content field entirely on an unmodified re-read — so this is
 * deliberately `unknown`, not a per-tool union. Do not assume a `content`
 * field exists.
 */
export interface PostToolUseEvent extends HookEnvelope {
  readonly hook_event_name: "PostToolUse";
  readonly tool_name: string;
  readonly tool_input: Record<string, unknown>;
  readonly tool_response: unknown;
  readonly tool_use_id: string;
  readonly duration_ms?: number;
}

// --- PermissionRequest -----------------------------------------------------------
//
// Fires *after* PreToolUse for the same tool_use_id (spike §5). Note
// `permission_mode` reads "default" while the TUI footer says "manual mode
// on" — don't build a UI label directly off this field.
export interface PermissionRequestEvent extends HookEnvelope {
  readonly hook_event_name: "PermissionRequest";
  readonly tool_name: string;
  readonly tool_input: Record<string, unknown>;
  readonly permission_suggestions?: readonly unknown[];
}

// --- PreCompact ------------------------------------------------------------------
//
// No PostCompact exists. Compaction does NOT rotate session_id (unlike
// /clear). Only `trigger: "manual"` has been observed; "auto" is unconfirmed.
export interface PreCompactEvent extends HookEnvelope {
  readonly hook_event_name: "PreCompact";
  readonly trigger: "manual" | "auto" | (string & {});
  readonly custom_instructions: string | null;
}

// --- PreModelSwitch / PostModelSwitch ---------------------------------------------
export interface ModelSwitchFields {
  readonly from_model: string;
  readonly to_model: string;
  readonly requested_model: string;
  readonly source: string;
  readonly context_tokens: number;
  readonly prompt_cache_warm: boolean;
  readonly cache_ttl: string;
  readonly estimated_cache_write_usd: number;
  readonly pricing: string;
}

export interface PreModelSwitchEvent extends HookEnvelope, ModelSwitchFields {
  readonly hook_event_name: "PreModelSwitch";
}

export interface PostModelSwitchEvent extends HookEnvelope, ModelSwitchFields {
  readonly hook_event_name: "PostModelSwitch";
}

/** The union of every hook event shape this ticket knows about. */
export type OfficeEvent =
  | SessionStartEvent
  | SessionEndEvent
  | StopFailureEvent
  | StopEvent
  | PreToolUseEvent
  | PostToolUseEvent
  | PermissionRequestEvent
  | PreCompactEvent
  | PreModelSwitchEvent
  | PostModelSwitchEvent;

/** `hook_event_name` values this ticket has a typed shape for. */
export const KNOWN_HOOK_EVENT_NAMES = [
  "SessionStart",
  "SessionEnd",
  "StopFailure",
  "Stop",
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
  "PreCompact",
  "PreModelSwitch",
  "PostModelSwitch",
] as const satisfies readonly OfficeEvent["hook_event_name"][];

/**
 * The design's eight `/events/*` ingest endpoints, and which
 * `hook_event_name` value(s) each one carries. Two endpoints ("tool" and
 * "model") each carry a pair of events distinguished only by
 * `hook_event_name` inside the payload — the endpoint path is never the
 * source of truth for an event's type (see events/ingest.ts, and the
 * StopFailure/last_assistant_message decision above: always key on the
 * payload, never on the URL or on field presence).
 *
 * `UserPromptSubmit` is deliberately absent — it was spike instrumentation,
 * not one of the design's eight endpoints.
 */
export const EVENT_ENDPOINTS = {
  start: ["SessionStart"],
  end: ["SessionEnd"],
  failure: ["StopFailure"],
  reply: ["Stop"],
  tool: ["PreToolUse", "PostToolUse"],
  permission: ["PermissionRequest"],
  compact: ["PreCompact"],
  model: ["PreModelSwitch", "PostModelSwitch"],
} as const satisfies Record<string, readonly OfficeEvent["hook_event_name"][]>;

export type EventEndpointSlug = keyof typeof EVENT_ENDPOINTS;
