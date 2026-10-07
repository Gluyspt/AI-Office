// Pause, emergency stop and resume: the vocabulary, the wire shapes, and
// the two notices this build step is obliged to show rather than hide.
//
// Ticket 028. Read by the orchestrator (features/orchestrator/pause.ts,
// resume.ts, routes/control.ts) and by ticket 029's UI, which renders the
// notices below verbatim.
//
// No barrel re-export, matching ids.ts / events.ts / tasks.ts / sessions.ts
// (see packages/shared's package.json `exports` map): import it as
// `@office/shared/control`.
//
//
// WHAT A PAUSE IS, AND WHERE IT LIVES
// -----------------------------------
// Pause is a property of the *work*, not of the process. A paused agent's
// tmux session is still alive and still `running` in `sessions` — ticket
// 008's status union deliberately has no `paused` member, because a fifth
// status would make every "is this desk reachable" query wrong. The pause
// itself is a row in `pause_state` (db/migrations/0011_pause.sql), scoped to
// one project or to the whole office, and it is durable on purpose: a pause
// flag held in memory is not a pause, because the whole point is that it
// holds while things are going wrong — which includes the orchestrator
// having just been restarted.
//
//
// TIMESTAMPS ARE STRINGS HERE
// ---------------------------
// Every timestamp on these shapes is the Postgres `timestamptz` read as
// TEXT, never a JS `Date`. `timestamptz` -> `Date` silently drops
// microseconds, which has cost this repo five sightings (see the identical
// note in features/tasks/states.ts, events/ingest.ts, tasks/repo.ts and
// orchestrator/sessions.ts). Anything that has to *match* a stored value
// must not round-trip through a Date, so these never become one.

import type { ProjectId, SessionId, TaskId } from "./ids.ts";
import type { TaskState } from "./tasks.ts";

// --- Kinds -------------------------------------------------------------------

/**
 * The two stop choreographies, which differ in what they are willing to
 * wait for — not in what they end up with.
 *
 *   `graceful`  — interrupt, instruct each agent to commit WIP and write a
 *                 handoff, wait up to the deadline, then kill.
 *   `emergency` — kill everything in scope immediately. No interrupt, no
 *                 instruction, no wait. It exists because the target host
 *                 (3.2 GB, 4 threads, ~290 MB per idle agent) cannot absorb
 *                 a runaway, and because a graceful pause can itself hang.
 *
 * Both end in the same place: every affected task `paused`, every lock kept
 * and marked paused, every killed desk carrying the reason it was killed.
 * That sameness is the design's own requirement — "a single Resume recovers
 * every kind of interruption".
 */
export const PAUSE_KINDS = ["graceful", "emergency"] as const;

export type PauseKind = (typeof PAUSE_KINDS)[number];

export function isPauseKind(value: unknown): value is PauseKind {
  return typeof value === "string" && (PAUSE_KINDS as readonly string[]).includes(value);
}

// --- Why a desk was ended ----------------------------------------------------

/**
 * What `sessions.end_reason` holds for a desk this feature killed.
 *
 * Recorded so ticket 026's conversation divider can label the boundary
 * correctly. The divider sits *between* two sessions and says why the later
 * one exists, so it reads this column off the EARLIER (ended) row — that is
 * the only row that exists at the moment the pause kills a desk, and the
 * replacement may not be spawned for days.
 *
 * Deliberately narrow. A desk that died some other way is already described
 * by `status` plus `failure_reason` (008); this column means "something
 * deliberately stopped this desk", and the vocabulary is enforced by a check
 * constraint in db/migrations/0011_pause.sql. Widening it is one line there
 * and one line here.
 */
export const SESSION_END_REASONS = ["pause", "emergency_stop"] as const;

export type SessionEndReason = (typeof SESSION_END_REASONS)[number];

export function isSessionEndReason(value: unknown): value is SessionEndReason {
  return typeof value === "string" && (SESSION_END_REASONS as readonly string[]).includes(value);
}

/** What ticket 026's divider says. One phrasing, so the UI does not invent a
 * second one. */
export const SESSION_END_REASON_LABELS: Readonly<Record<SessionEndReason, string>> = {
  pause: "restarted after a pause",
  emergency_stop: "restarted after an emergency stop",
};

// --- The two notices this build step owes the user ---------------------------

/**
 * THE HANDOFF SEAM. Shown wherever a pause or a resume is described.
 *
 * The design's own table promises "Full context" across a pause. That is not
 * true in step 3 and will not be true until step 5: the knowledge graph —
 * where a handoff node would live — does not exist, so `requestHandoffNode`
 * in features/orchestrator/pause.ts is a named seam that logs a warning and
 * returns null, and `sessions.handoff_ref` stays NULL.
 *
 * This string is the deliverable, not a comment about one. Ticket 029 must
 * render it rather than repeating the design's promise, and resume puts it
 * in the respawned agent's brief so the agent is not left inferring that it
 * ought to remember something.
 */
export const HANDOFF_UNAVAILABLE_NOTICE =
  "No handoff was written or restored. The knowledge graph that would hold one is build " +
  "step 5 and does not exist yet, so a pause preserves task state and file locks — not " +
  "in-flight work, and not the agent's context. Treat a resumed task as a fresh start on " +
  "a task that is partly done.";

/**
 * THE COMMIT SEAM, for the same reason.
 *
 * A graceful pause *asks* each agent to commit and push its work in
 * progress, and nothing verifies that it did: the git workflow is build step
 * 4. So the instruction goes out, the outcome is unknown, and saying so is
 * the honest version.
 */
export const WIP_COMMIT_UNVERIFIED_NOTICE =
  "Agents were asked to commit work in progress, and nothing checked whether they did. " +
  "The git workflow is build step 4, so there is no branch, no push and no verification " +
  "behind that request yet. Uncommitted work in a killed pane is gone.";

/**
 * What a graceful pause actually sends each agent, verbatim.
 *
 * Lives here rather than at the call site because ticket 029 shows the
 * operator what the agents were told — a stop control that will not say what
 * it does to the people it does it to is the kind of control nobody trusts
 * enough to press.
 *
 * It names the deadline and says the session will be killed either way,
 * because an agent told only "please wrap up" has no reason to prioritise.
 */
export function pauseInstruction(deadlineMs: number): string {
  const seconds = Math.max(1, Math.round(deadlineMs / 1000));
  return [
    "The office is pausing. Stop what you are doing now.",
    "",
    `You have about ${seconds} seconds, then this session is killed whether you are ready or not.`,
    "",
    "In that time: commit any work in progress with a WIP message so it is not lost, and",
    "write down anywhere durable what you were in the middle of.",
    "",
    "Do not start anything new. Do not try to finish the task.",
  ].join("\n");
}

// --- Events ------------------------------------------------------------------

/**
 * The per-agent choreography, in the order a graceful pause performs it.
 *
 * The acceptance criterion is "in that order, asserted by an ordered event
 * log", so the order is data here and the test reads it from this constant
 * rather than hard-coding a second copy. Each phase completes for every
 * agent before the next begins — that is what makes the global event order,
 * not just each agent's own, assertable.
 */
export const PAUSE_AGENT_PHASES = [
  ["PauseAgentInterrupted"],
  ["PauseAgentInstructed"],
  // Exactly one of these two per agent: it finished in time, or it did not.
  ["PauseAgentSettled", "PauseAgentDeadlineMissed"],
  ["PauseAgentKilled"],
] as const satisfies readonly (readonly string[])[];

/** Every event type this feature emits. Named so ticket 029 can switch on
 * them and ticket 006's stream consumers can filter. */
export const CONTROL_EVENT_TYPES = [
  "PauseStarted",
  "PauseAgentInterrupted",
  "PauseAgentInstructed",
  "PauseAgentSettled",
  "PauseAgentDeadlineMissed",
  "PauseAgentKilled",
  "PauseQueueDiscarded",
  "PauseCompleted",
  "EmergencyStopStarted",
  "EmergencyStopCompleted",
  "PauseEscalated",
  "ResumeStarted",
  "ResumeTaskResumed",
  "ResumeTaskSkipped",
  "ResumeAgentRespawned",
  "ResumeAgentRespawnSkipped",
  "ResumeCompleted",
  "StartSessionRefusedWhilePaused",
] as const;

export type ControlEventType = (typeof CONTROL_EVENT_TYPES)[number];

// --- Records -----------------------------------------------------------------

/** One row of `pause_state`, camelCased. */
export interface PauseRecord {
  readonly id: string;
  /** NULL means global — every project. */
  readonly projectId: ProjectId | null;
  readonly kind: PauseKind;
  readonly initiatedBy: string;
  readonly reason: string | null;
  /** The deadline in force for this pause, in milliseconds. Null for an
   * emergency stop, which has none by definition. Recorded on the row rather
   * than read back from config, so an audit can answer "was 20s too short?"
   * after the number has been changed. */
  readonly deadlineMs: number | null;
  readonly startedAt: string;
  /** Null while the choreography is still running. A pause is in effect from
   * `startedAt`, NOT from here: start_session has to be refused the instant
   * someone presses the button, not when the last agent has been killed. */
  readonly completedAt: string | null;
  readonly tasksPaused: number;
  /** Null while the pause is still in effect. This — not `completedAt` — is
   * the "is this pause over" flag. */
  readonly liftedAt: string | null;
  readonly liftedBy: string | null;
  /** Set when an emergency stop was pressed while this pause was still
   * waiting out its deadline, and took over from it. */
  readonly escalatedTo: string | null;
}

/**
 * True when `pause` applies to `projectId`.
 *
 * A global pause (projectId null) covers every project; a project pause
 * covers only its own. One function rather than the same two-line condition
 * at six call sites, because getting it backwards means either a pause that
 * silently does not hold or a stop control that freezes the whole office
 * when someone asked for one project.
 */
export function pauseCoversProject(pause: PauseRecord, projectId: ProjectId | string): boolean {
  return pause.projectId === null || pause.projectId === projectId;
}

/** Whether a pause is still in effect — in flight or completed, but not yet
 * resumed. */
export function pauseIsActive(pause: PauseRecord): boolean {
  return pause.liftedAt === null;
}

/** Whether the choreography is still running. A second pause over the same
 * scope is refused while this is true rather than interleaved. */
export function pauseIsInFlight(pause: PauseRecord): boolean {
  return pause.liftedAt === null && pause.completedAt === null;
}

/**
 * What a pause did to one desk, one row of `pause_session`.
 *
 * Per agent, and that is a requirement rather than a nicety: "an agent that
 * misses the deadline is killed anyway, and the pause completes; the missed
 * deadline is reported per agent". A single pause-level "2 agents missed the
 * deadline" count cannot tell an operator *which* desk lost its work.
 */
export interface PauseAgentReport {
  readonly sessionId: SessionId;
  readonly tmuxName: string;
  readonly projectId: ProjectId;
  readonly interruptedAt: string | null;
  readonly interruptError: string | null;
  /** Messages dropped so the interrupt actually stopped something. See
   * ticket 008: a message queued before Escape still ran in 17 of 19 trials
   * on the target host, so interrupting has to mean *not sending*. */
  readonly discardedMessages: number;
  readonly instructedAt: string | null;
  readonly instructionError: string | null;
  readonly handoffRequestedAt: string | null;
  /** The handoff reference, if one were ever written. Always null until
   * build step 5 — see HANDOFF_UNAVAILABLE_NOTICE. */
  readonly handoffRef: string | null;
  readonly settledAt: string | null;
  readonly deadlineMissed: boolean;
  readonly killedAt: string | null;
  readonly killError: string | null;
  /** Why this desk's settle could not be observed, when it could not. */
  readonly note: string | null;
}

export interface PauseResult {
  readonly pause: PauseRecord;
  readonly agents: readonly PauseAgentReport[];
  readonly tasksPaused: readonly TaskId[];
  /** Tasks that were already `paused` when the pause ran. Reported rather
   * than counted in, so a second pause over the same scope is visibly a
   * no-op instead of looking like it paused everything twice. */
  readonly tasksAlreadyPaused: readonly TaskId[];
  /** True when an identical pause was already in effect and this call did
   * nothing. Pause is idempotent; a repeat is not an error. */
  readonly alreadyPaused: boolean;
  /** The seam notices that apply to what just happened. Returned rather than
   * assumed, so a caller cannot show a pause report without them. */
  readonly notices: readonly string[];
}

// --- Resume ------------------------------------------------------------------

/** Why a paused task was left paused. */
export const RESUME_SKIP_REASONS = [
  /** It was not paused to begin with. The ordinary idempotent case. */
  "not_paused",
  /** A dependency has not reached `delivered`, so resuming it would start
   * work the dependency graph says cannot start. Ticket 014's rule, not a
   * second copy of it. */
  "blocked_by_dependency",
  /** The task is `paused` but no history row records what it was paused
   * from, so resume has no origin to return it to. Ticket 012's guard. */
  "no_pause_origin",
] as const;

export type ResumeSkipReason = (typeof RESUME_SKIP_REASONS)[number];

/** Why no agent was respawned for a resumed task. */
export const RESPAWN_SKIP_REASONS = [
  /** The task was not paused from a state in which an agent was working on
   * it. Nothing was running; nothing needs restarting. */
  "not_a_work_state",
  /** Nothing records which desk was working this task, so there is no
   * identity to recreate. Resume does not invent one. */
  "no_prior_session",
  /** A live desk already holds that identity — the half-resumed-then-retried
   * case. This is what "no duplicate sessions" looks like from inside. */
  "already_running",
  /** Where an agent's working directory and Claude binary come from is not
   * settled (see resume.ts). Nothing was spawned, and that is said out loud
   * rather than logged. */
  "no_spawn_target",
  /** The spawn was attempted and failed. Ticket 008's row carries why. */
  "spawn_failed",
  /** A pause still covers the project, so the spawn was refused. */
  "project_paused",
  /** The caller asked for no respawn. */
  "not_requested",
] as const;

export type RespawnSkipReason = (typeof RESPAWN_SKIP_REASONS)[number];

export interface RespawnOutcome {
  readonly spawned: boolean;
  readonly sessionId: SessionId | null;
  readonly reason: RespawnSkipReason | null;
  readonly detail: string | null;
}

export interface ResumeTaskOutcome {
  readonly taskId: TaskId;
  readonly resumed: boolean;
  /** Whatever the skip or the failure needs to say in words. Null when there
   * is nothing to add. */
  readonly detail: string | null;
  /** The state the task was returned to — the state it was paused from, and
   * nothing else (ticket 012's guard). Null when it was not resumed. */
  readonly resumedTo: TaskState | null;
  readonly skipReason: ResumeSkipReason | null;
  /** The dependencies still not delivered, when that is why it stayed
   * paused. The refusal has to say what to wait for. */
  readonly blockedBy: readonly TaskId[];
  /** Locks whose paused flag was cleared, and whose TTL was restarted in the
   * same transaction. See resume.ts for why both have to happen at once. */
  readonly locksUnpaused: number;
  readonly respawn: RespawnOutcome;
}

export interface ResumeResult {
  readonly scope: { readonly projectId: ProjectId | null; readonly taskId: TaskId | null };
  readonly requestedBy: string;
  /** The pause this resume lifted, if there was one. Null when resuming a
   * task that was paused on its own — a crash, a rate limit, a circuit
   * breaker — with no office-wide pause behind it. */
  readonly liftedPause: PauseRecord | null;
  readonly tasks: readonly ResumeTaskOutcome[];
  readonly notices: readonly string[];
}

// --- GET /control/state ------------------------------------------------------

/**
 * What the stop-controls page reads.
 *
 * `startSessionRefused` is stated rather than left to be inferred from the
 * presence of a pause row, because that is the single behavioural fact an
 * operator needs: while it is true, nothing new starts, including a lead's
 * own `start_session` and ticket 018's queued spawns.
 */
export interface ControlState {
  /** The global pause, if one is in effect. */
  readonly global: PauseRecord | null;
  /** Active project-scoped pauses, newest first. Filtered to one project
   * when the caller asked for one. */
  readonly projects: readonly PauseRecord[];
  readonly paused: boolean;
  readonly startSessionRefused: boolean;
  /** Per-agent reports for the pauses above, so a stuck or killed desk is
   * visible after a restart and not only in the response to the original
   * request. */
  readonly agents: readonly PauseAgentReport[];
  readonly pausedTaskCount: number;
  /** Always present, always rendered. See the two constants above. */
  readonly notices: readonly string[];
}
