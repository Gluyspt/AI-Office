// Session vocabulary: the status union, the role and backend unions, and
// the record shapes both the server and the web app read. Everything that
// enumerates session statuses enumerates them *here* — the SQL check
// constraint in db/migrations/0003_sessions.sql is the only other copy, and
// a test in packages/server/src/features/orchestrator/sessions.test.ts
// asserts the two agree.
//
// No barrel re-export, matching ids.ts, events.ts and tasks.ts (see
// packages/shared's package.json `exports` map): import it as
// `@office/shared/sessions`.

import type { ProjectId, SessionId } from "./ids.ts";

// --- Status ------------------------------------------------------------------

/**
 * The four states of a desk, in lifecycle order.
 *
 * `starting` is not a formality. Ticket 008's registry writes the row
 * *before* it spawns tmux, so a spawn that crashes still leaves a record —
 * and a row that reaches `failed` without ever being `running` is the most
 * informative shape in the system, because it means the desk never worked
 * and the reason is attached.
 *
 * There is no `paused`. Pause is ticket 028 and is a property of the work,
 * not of the process: a paused agent's tmux session is still alive and
 * still `running` here. Adding a fifth status would make every "is this
 * desk reachable" query wrong.
 */
export const SESSION_STATUSES = ["starting", "running", "ended", "failed"] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** Terminal statuses. A row in one of these never changes again. */
export const TERMINAL_SESSION_STATUSES: readonly SessionStatus[] = ["ended", "failed"];

export function isSessionStatus(value: unknown): value is SessionStatus {
  return typeof value === "string" && (SESSION_STATUSES as readonly string[]).includes(value);
}

export function isTerminalSessionStatus(value: SessionStatus): boolean {
  return TERMINAL_SESSION_STATUSES.includes(value);
}

// --- Roles -------------------------------------------------------------------

/**
 * The roles the design names in its org chart: a management lead above
 * department leads, and workers under each lead.
 *
 * Deliberately NOT a free string. The role selects which `--agent`
 * definition a session launches with (ticket 009), so an unknown role means
 * a session that starts with no role file and behaves like a bare agent —
 * which is exactly the "session is alive but useless" shape spike 002
 * catalogued three ways. A closed union turns that into a 400.
 */
export const SESSION_ROLES = ["management_lead", "dept_lead", "worker"] as const;

export type SessionRole = (typeof SESSION_ROLES)[number];

export function isSessionRole(value: unknown): value is SessionRole {
  return typeof value === "string" && (SESSION_ROLES as readonly string[]).includes(value);
}

// --- Backends ----------------------------------------------------------------

/**
 * Which CLI drives the desk. `claude` is the only one implemented; the
 * union exists because the design's `start_session(... backend, model)`
 * signature has the parameter, and a column with one legal value today is
 * cheaper than a migration later.
 */
export const SESSION_BACKENDS = ["claude", "codex"] as const;

export type SessionBackend = (typeof SESSION_BACKENDS)[number];

export function isSessionBackend(value: unknown): value is SessionBackend {
  return typeof value === "string" && (SESSION_BACKENDS as readonly string[]).includes(value);
}

// --- Why a session failed ----------------------------------------------------

/**
 * The failure shapes ticket 008 must tell apart, because their remedies
 * differ and a single "failed" would hide that.
 *
 * `hooks_never_arrived` vs `hooks_handshake_rejected` is the distinction the
 * ticket asks for by name. The reason it matters: the https-everywhere
 * decision means an agent launched without `NODE_EXTRA_CA_CERTS` works
 * perfectly and is **completely invisible** to the orchestrator — every
 * hook fails its TLS handshake, no event arrives, and nothing crashes. A
 * missing env var in provisioning and a certificate that needs reissuing
 * look identical from the outside, so the two are separated here where
 * ticket 005's TLS logging makes that possible.
 */
export const SESSION_FAILURE_KINDS = [
  /** tmux or sudo refused, or the pane died immediately. */
  "spawn_failed",
  /** The session started but no composer ever appeared — a dialog, onboarding, or a dead binary. */
  "not_ready",
  /** The session started, the composer came up, and no hook event ever arrived. */
  "hooks_never_arrived",
  /** Hooks reached the event server and were rejected at TLS. */
  "hooks_handshake_rejected",
  /** Something else, with the detail in the reason text. */
  "other",
] as const;

export type SessionFailureKind = (typeof SESSION_FAILURE_KINDS)[number];

export function isSessionFailureKind(value: unknown): value is SessionFailureKind {
  return (
    typeof value === "string" && (SESSION_FAILURE_KINDS as readonly string[]).includes(value)
  );
}

// --- Records -----------------------------------------------------------------

export interface SessionRecord {
  readonly id: SessionId;
  readonly projectId: ProjectId;
  readonly tmuxName: string;
  readonly role: SessionRole;
  readonly dept: string;
  /** The Linux user the agent runs as. */
  readonly owner: string;
  readonly backend: SessionBackend;
  readonly model: string;
  /**
   * Why this model was chosen. Never empty — the design's Spawn feed shows
   * it next to every spawn, and that feed is how a human notices a lead
   * picking the expensive model for everything.
   */
  readonly modelReason: string;
  readonly status: SessionStatus;
  /**
   * The CURRENT Claude session id, or null before the desk has reported.
   * Rotates on `/clear`, so this is not a stable identifier for the desk —
   * `id` is. Ticket 010 models the succession.
   */
  readonly claudeSessionId: string | null;
  readonly failureKind: SessionFailureKind | null;
  readonly failureReason: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
}

/** A message the orchestrator is holding rather than trusting tmux to queue. */
export interface QueuedMessage {
  readonly id: string;
  readonly sessionId: SessionId;
  readonly body: string;
  readonly requestedBy: string;
  readonly status: "pending" | "sent" | "discarded";
  readonly discardReason: string | null;
  readonly queuedAt: string;
  readonly sentAt: string | null;
}

// --- Event types this feature emits ------------------------------------------

/**
 * Every control action writes one of these through ticket 005's ingest, so
 * it reaches the WebSocket stream and the agent cards update without
 * polling. Named here rather than as string literals at the call sites so
 * the web app can switch on them.
 */
export const SESSION_EVENT_TYPES = [
  "SessionRegistered",
  "SessionRunning",
  "SessionFailed",
  "SessionEnded",
  "SessionMessageQueued",
  "SessionMessageSent",
  "SessionMessageRefused",
  "SessionMessageDiscarded",
  "SessionInterrupted",
] as const;

export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number];
