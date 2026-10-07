// Pause and emergency stop: the choreography, and the flag that makes it
// stick.
//
// Ticket 028. The design is explicit about why this lands in step 3 rather
// than later — "build them before agents ever run unattended" — and about
// what a pause is: "interrupt every agent, instruct each to commit WIP and
// write a handoff, wait with a deadline, then kill". Emergency stop skips
// the graceful steps. Both keep locks and move tasks to `paused`, so a
// single Resume (./resume.ts) recovers every kind of interruption: manual
// pause, crash, circuit breaker, rate limit.
//
// Five properties this file exists to hold.
//
//  1. **The pause is a ROW, not a variable.** `pause_state` in
//     db/migrations/0011_pause.sql. A pause flag held in memory is not a
//     pause: the whole point is that it holds while things are going wrong,
//     and "things are going wrong" includes the orchestrator having just
//     been restarted. Idempotence falls out of the same place — a second
//     Pause over an already-paused scope reads the row and returns it.
//
//  2. **The refusal is enforced by the database, not by this file.** "While
//     paused, start_session is refused" has four eventual callers — 008's
//     HTTP route, 018's MCP tool, 018's spawn-queue drain, 019's promotion —
//     and three of them do not exist yet. A BEFORE INSERT trigger on
//     `sessions` (SQLSTATE OF010) refuses all four at the layer every one of
//     them has to go through, the same way 0005_tasks.sql makes
//     "transition() is the only way state changes" structural. This module
//     exports `assertStartAllowed()` as the *traced* path in front of it —
//     see the note on that function for why both exist.
//
//  3. **One stuck agent must not block the pause.** Every phase runs across
//     all agents at once and the deadline is shared, so a pause takes about
//     one deadline regardless of how many desks are stuck. Each agent's
//     outcome is recorded individually, because "the missed deadline is
//     reported per agent" and a count cannot say which desk lost its work.
//
//  4. **Interrupting means NOT SENDING.** Phase 1 goes through 008's
//     `interruptSession`, which discards pending messages rather than hoping
//     tmux forgets them: on the target host a message queued before Escape
//     still ran in 17 of 19 trials and was discarded in 2. Emergency stop
//     does the same thing harder — it discards every in-scope queue in one
//     statement *before* the first kill, so the window in which a queued
//     instruction could still go out is as small as this layer can make it.
//
//  5. **Elapsed time is measured monotonically.** The target host's wall
//     clock was observed stepping backwards twice in one session on
//     2026-10-07 (-494 ms, -100 ms). `Date.now()` arithmetic would therefore
//     let a deadline fire instantly or never. `process.hrtime.bigint()` is
//     the clock here; the timestamps in the database are an audit trail, not
//     an arithmetic input, and the migration explains why it carries no
//     ordering check constraints.
//
// TWO NAMED SEAMS, which are deliverables rather than omissions. Pause
// depends on agents committing WIP (build step 4) and writing a handoff node
// (build step 5). Neither exists. The commit instruction goes out and
// nothing verifies it; `requestHandoffNode()` logs a warning and returns
// null. Both facts travel out of here as `notices` on every result and as
// strings in packages/shared/src/control.ts, because ticket 029's UI has to
// say so plainly rather than repeat the design's "Full context".
//
// WHO MAY DO THIS: nobody is checked. `initiatedBy` is recorded and never
// verified — permissions are step 9, which is how states.ts treats a task's
// actor and how sessions.ts treats `requestedBy`. Recorded here so this
// module is not mistaken for safe to expose publicly.
import type { PoolClient } from "pg";
import {
  HANDOFF_UNAVAILABLE_NOTICE,
  WIP_COMMIT_UNVERIFIED_NOTICE,
  type PauseAgentReport,
  type PauseKind,
  type PauseRecord,
  type PauseResult,
  pauseInstruction,
} from "@office/shared/control";
import { asProjectId, asSessionId, asTaskId, type ProjectId, type SessionId, type TaskId } from "@office/shared/ids";
import { asTaskState, type TaskActorKind } from "@office/shared/tasks";
import { loadPauseConfig } from "../../core/config.ts";
import { query, withTransaction } from "../../core/db/pool.ts";
import { ingestEmitter, recordSystemEvent, type StoredEventRow } from "../events/ingest.ts";
import { setLocksPaused } from "../locks/registry.ts";
import {
  PAUSABLE_STATES,
  TaskTransitionError,
  announceTransition,
  transition,
} from "../tasks/states.ts";
import {
  SessionError,
  interruptSession,
  killSession,
  listSessions,
  messageSession,
} from "./sessions.ts";

// --- Errors ---------------------------------------------------------------------
//
// Typed results for operational outcomes, exceptions only for programmer
// error — the same rule the tmux adapter and the session registry follow, so
// a caller switches on a kind instead of matching message strings.

export type ControlErrorKind =
  /** A blank actor, or a scope that names something that does not exist. */
  | "invalid_request"
  /** A pause over this scope is still running its choreography. HTTP 409. */
  | "pause_in_flight"
  /** A pause covers this project, so the thing asked for is refused. HTTP 409. */
  | "project_paused"
  | "not_found";

export class ControlError extends Error {
  readonly kind: ControlErrorKind;
  readonly detail: string | null;

  constructor(kind: ControlErrorKind, message: string, detail: string | null = null) {
    super(message);
    this.name = "ControlError";
    this.kind = kind;
    this.detail = detail;
  }
}

/**
 * SQLSTATE of the `sessions` insert trigger's refusal.
 *
 * Exported with `isPauseRefusal` so a caller that goes through ticket 008's
 * `startSession` — which knows nothing about pauses — can still turn the raw
 * Postgres error into a sentence a human wants to read, without this feature
 * having to edit another ticket's file.
 */
export const PAUSE_REFUSAL_SQLSTATE = "OF010";

export function isPauseRefusal(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === PAUSE_REFUSAL_SQLSTATE
  );
}

// --- Row mapping ----------------------------------------------------------------
//
// TIMESTAMP TRAP, the sixth sighting in this repo. `timestamptz` -> JS `Date`
// loses microseconds, so every timestamp here is read as TEXT and stays a
// string all the way to the client. The same comment appears in states.ts,
// events/ingest.ts, tasks/repo.ts and sessions.ts.

const PAUSE_COLUMNS = `
  id,
  project_id,
  kind,
  initiated_by,
  reason,
  deadline_ms,
  started_at::text as started_at,
  completed_at::text as completed_at,
  tasks_paused,
  lifted_at::text as lifted_at,
  lifted_by,
  escalated_to
`;

interface PauseStateRow {
  id: string;
  project_id: string | null;
  kind: string;
  initiated_by: string;
  reason: string | null;
  deadline_ms: number | null;
  started_at: string;
  completed_at: string | null;
  tasks_paused: number;
  lifted_at: string | null;
  lifted_by: string | null;
  escalated_to: string | null;
}

export function pauseRowToRecord(row: PauseStateRow): PauseRecord {
  return {
    id: row.id,
    projectId: row.project_id === null ? null : asProjectId(row.project_id),
    kind: row.kind as PauseKind,
    initiatedBy: row.initiated_by,
    reason: row.reason,
    deadlineMs: row.deadline_ms,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    tasksPaused: row.tasks_paused,
    liftedAt: row.lifted_at,
    liftedBy: row.lifted_by,
    escalatedTo: row.escalated_to,
  };
}

const AGENT_REPORT_COLUMNS = `
  ps.session_id,
  s.tmux_name,
  s.project_id,
  s.handoff_ref,
  ps.interrupted_at::text as interrupted_at,
  ps.interrupt_error,
  ps.discarded_messages,
  ps.instructed_at::text as instructed_at,
  ps.instruction_error,
  ps.handoff_requested_at::text as handoff_requested_at,
  ps.settled_at::text as settled_at,
  ps.deadline_missed,
  ps.killed_at::text as killed_at,
  ps.kill_error,
  ps.note
`;

interface AgentReportRow {
  session_id: string;
  tmux_name: string;
  project_id: string;
  handoff_ref: string | null;
  interrupted_at: string | null;
  interrupt_error: string | null;
  discarded_messages: number;
  instructed_at: string | null;
  instruction_error: string | null;
  handoff_requested_at: string | null;
  settled_at: string | null;
  deadline_missed: boolean;
  killed_at: string | null;
  kill_error: string | null;
  note: string | null;
}

function agentRowToReport(row: AgentReportRow): PauseAgentReport {
  return {
    sessionId: asSessionId(row.session_id),
    tmuxName: row.tmux_name,
    projectId: asProjectId(row.project_id),
    interruptedAt: row.interrupted_at,
    interruptError: row.interrupt_error,
    discardedMessages: row.discarded_messages,
    instructedAt: row.instructed_at,
    instructionError: row.instruction_error,
    handoffRequestedAt: row.handoff_requested_at,
    handoffRef: row.handoff_ref,
    settledAt: row.settled_at,
    deadlineMissed: row.deadline_missed,
    killedAt: row.killed_at,
    killError: row.kill_error,
    note: row.note,
  };
}

// --- Injectable dependencies ----------------------------------------------------

export interface PauseDeps {
  /**
   * Resolves true when the agent's turn has ended, false on timeout.
   *
   * "Ended" is read from hook events, never from the pane. Spike 003
   * measured the `esc to interrupt` marker clearing 148-342 ms after a
   * message is submitted while the turn runs on for seconds, so anything
   * scraping the pane reports a working agent as finished almost
   * immediately — which during a pause would mean killing a desk that is
   * mid-commit and reporting that it finished.
   */
  waitForTurnEnd(claudeSessionId: string, timeoutMs: number): Promise<boolean>;
  /** Monotonic milliseconds. NOT the wall clock — see property 5. */
  monotonicMs(): number;
}

/** Hook events that mean "the turn is over". */
const TURN_END_EVENT_TYPES: ReadonlySet<string> = new Set([
  "Stop",
  "StopFailure",
  "SessionEnd",
]);

/**
 * `SessionEnd` with `reason: "clear"` does NOT mean the agent stopped — it
 * fires while the agent keeps working, because `/clear` ends the *Claude*
 * session and rotates its id without touching the tmux session. Ticket 008
 * excludes that reason from ending a registry row; the same exclusion
 * applies here for a stronger reason: treating it as "settled" would kill a
 * desk that is still mid-commit and record that it finished in time.
 */
function meansTurnEnded(event: StoredEventRow): boolean {
  if (!TURN_END_EVENT_TYPES.has(event.type)) return false;
  if (event.type !== "SessionEnd") return true;
  const payload = event.payload;
  const reason =
    typeof payload === "object" && payload !== null
      ? (payload as { reason?: unknown }).reason
      : undefined;
  return reason !== "clear";
}

function defaultWaitForTurnEnd(claudeSessionId: string, timeoutMs: number): Promise<boolean> {
  if (timeoutMs <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ingestEmitter.off("event", onEvent);
      resolve(value);
    };
    const onEvent = (event: StoredEventRow): void => {
      if (event.sessionId === claudeSessionId && meansTurnEnded(event)) finish(true);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    // Do not hold the process open waiting for an agent that will never reply.
    timer.unref?.();
    ingestEmitter.on("event", onEvent);
  });
}

function defaultMonotonicMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

let deps: PauseDeps = {
  waitForTurnEnd: defaultWaitForTurnEnd,
  monotonicMs: defaultMonotonicMs,
};

/** Test seam. Partial override; anything omitted keeps the real behaviour. */
export function __setPauseDeps(overrides: Partial<PauseDeps>): void {
  deps = { ...deps, ...overrides };
}

export function __resetPauseDeps(): void {
  deps = { waitForTurnEnd: defaultWaitForTurnEnd, monotonicMs: defaultMonotonicMs };
}

// --- Scope ----------------------------------------------------------------------

/**
 * Does one scope COVER another? `null` means global, which covers
 * everything; otherwise a scope covers only itself.
 *
 * Used in both directions and the direction is the whole meaning, so read
 * the argument names. `scopeCovers(row.projectId, request)` asks "is what is
 * being requested already true?" — a global pause covers a request to pause
 * one project, and notably a project pause does NOT cover a request to pause
 * the office, because every other project is still running.
 * `scopeCovers(request, row.projectId)` asks the opposite: "may this request
 * replace that row?" — which is what stops an emergency stop on one project
 * from lifting a global pause and restarting two others.
 */
function scopeCovers(wider: string | null, narrower: string | null): boolean {
  return wider === null || wider === narrower;
}

/**
 * Do an existing pause row and a requested scope TOUCH at all?
 *
 * Wider than `covers` on purpose, and used for the in-flight rejection: two
 * choreographies that share even one project would interleave their
 * interrupts, instructions and kills, which is what the criterion "pause
 * during an in-flight pause is rejected rather than interleaved" forbids.
 */
function overlaps(rowProject: string | null, scope: string | null): boolean {
  return rowProject === null || scope === null || rowProject === scope;
}

async function activePauseRows(): Promise<PauseStateRow[]> {
  const { rows } = await query<PauseStateRow>(
    `select ${PAUSE_COLUMNS} from pause_state
      where lifted_at is null
      order by started_at desc, id`,
  );
  return rows;
}

/**
 * The pause in effect over `projectId`, or null.
 *
 * Read by `assertStartAllowed`, by resume, and by GET /control/state. One
 * query, because "is this project paused" is asked on every spawn attempt.
 */
export async function activePauseFor(projectId: ProjectId | string): Promise<PauseRecord | null> {
  const { rows } = await query<PauseStateRow>(
    `select ${PAUSE_COLUMNS} from pause_state
      where lifted_at is null and (project_id is null or project_id = $1)
      order by project_id nulls first, started_at desc, id
      limit 1`,
    [projectId],
  );
  const row = rows[0];
  return row ? pauseRowToRecord(row) : null;
}

/** Every pause still in effect, newest first. Optionally narrowed to the
 * pauses that cover one project. */
export async function activePauses(
  projectId?: ProjectId | string | null,
): Promise<readonly PauseRecord[]> {
  const rows = await activePauseRows();
  const records = rows.map(pauseRowToRecord);
  if (projectId === undefined || projectId === null) return records;
  return records.filter((pause) => scopeCovers(pause.projectId, projectId));
}

/**
 * Refuse to start work in a paused project, and leave a trace of having
 * refused.
 *
 * WHY THIS EXISTS ALONGSIDE THE TRIGGER. The trigger in 0011_pause.sql is
 * the invariant: it cannot be forgotten by a caller that does not know about
 * pauses, and it is what makes "a pause does not drain ticket 018's spawn
 * queue" true of code that has not been written yet. What it cannot do is
 * leave a record — the exception aborts the transaction, so any row it wrote
 * to `events` would roll back with it. This function is the traced path:
 * callers that *do* know about pauses (018's MCP tool and spawn-queue drain,
 * 019's promotion, ticket 029's UI preflight) call it first, get a typed
 * error and a message naming the pause, and an event lands on the project's
 * board saying a spawn was refused and by which pause.
 */
export async function assertStartAllowed(projectId: ProjectId | string): Promise<void> {
  const pause = await activePauseFor(projectId);
  if (!pause) return;
  await recordSystemEvent(
    "StartSessionRefusedWhilePaused",
    {
      project_id: projectId,
      pause_id: pause.id,
      pause_kind: pause.kind,
      pause_scope: pause.projectId === null ? "global" : "project",
      initiated_by: pause.initiatedBy,
      in_flight: pause.completedAt === null,
    },
    null,
    projectId,
  );
  throw new ControlError(
    "project_paused",
    `project ${projectId} is paused; start_session is refused while a pause is in effect`,
    `${pause.kind} pause ${pause.id}${pause.projectId === null ? " (global)" : ""} started by ${pause.initiatedBy} at ${pause.startedAt}`,
  );
}

// --- The seams ------------------------------------------------------------------

/**
 * THE HANDOFF SEAM. Named, and no-ops with a warning.
 *
 * Where build step 5 will ask the agent to write a handoff node into its
 * project's knowledge graph and return the node's reference, so Resume can
 * hand it back. There is no graph server, so there is nothing to write to
 * and nothing to return. `sessions.handoff_ref` stays NULL.
 *
 * The warning is the deliverable. The design's own table promises "Full
 * context" across a pause; that promise is false in step 3 and the UI is
 * required to say so (ticket 029) rather than repeat it.
 */
export async function requestHandoffNode(session: {
  readonly id: SessionId;
  readonly tmuxName: string;
}): Promise<string | null> {
  console.warn(
    `[ticket 028] handoff seam: no handoff node was written for ${session.tmuxName} ` +
      `(session ${session.id}). ${HANDOFF_UNAVAILABLE_NOTICE}`,
  );
  return null;
}

/** The notices every pause and stop result carries. Returned rather than
 * assumed, so a caller cannot render a pause report without them. */
export const PAUSE_NOTICES: readonly string[] = [
  WIP_COMMIT_UNVERIFIED_NOTICE,
  HANDOFF_UNAVAILABLE_NOTICE,
];

// --- Concurrency ----------------------------------------------------------------

/**
 * Bounded fan-out.
 *
 * Phases run across all agents at once — a pause of ten desks must take one
 * deadline, not ten — but not *unboundedly* at once. The database pool is
 * ten connections by default and `killSession` needs one for its
 * transaction; forty desks killed with an unbounded `Promise.all` would
 * queue forty pool waiters and starve hook ingest at the exact moment
 * everything is being torn down. Eight leaves headroom for the rest of the
 * server on a 4-thread, 3.2 GB host.
 */
const PHASE_CONCURRENCY = 8;

async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await run(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// --- Opening and closing a pause row --------------------------------------------

export interface PauseInput {
  /** The project to pause, or null/undefined for the whole office. */
  readonly projectId?: ProjectId | null;
  /** Who pressed it. Recorded, never checked. */
  readonly initiatedBy: string;
  readonly reason?: string | null;
  /**
   * What kind of actor `initiatedBy` is, for the task transitions this pause
   * writes. Defaults to `human`, because the UI button is the path that
   * exists; a crash handler or a rate-limit backoff passes `system`, which is
   * exactly what shared/tasks.ts reserves that value for.
   */
  readonly initiatedByKind?: TaskActorKind;
  /**
   * Overrides PAUSE_DEADLINE_MS. Present so a test can drive the whole
   * choreography without a new required environment variable — the same seam
   * `startSession` has for its hook-arrival timeout and `acquireScope` has
   * for its TTL. Production leaves it unset.
   */
  readonly deadlineMs?: number;
}

function requireActor(initiatedBy: string): string {
  const actor = initiatedBy.trim();
  if (actor === "") {
    // Refused here as well as by the column constraint: "every pause, stop
    // and resume records who triggered it and its scope" is an acceptance
    // criterion, and an anonymous stop is the one audit record nobody can
    // follow up on.
    throw new ControlError("invalid_request", "initiated_by is required and must not be blank");
  }
  return actor;
}

interface OpenedPause {
  readonly pause: PauseRecord;
  /** True when an equivalent pause was already in effect and nothing was done. */
  readonly alreadyPaused: boolean;
  /** Pauses this one superseded, for the audit. */
  readonly superseded: readonly PauseRecord[];
}

/**
 * Claims the pause row, which is the moment the pause begins.
 *
 * Everything about precedence lives here rather than being spread across the
 * two entry points:
 *
 *   * A **graceful pause** is refused while any overlapping pause is still
 *     in flight (the criterion), and is a no-op when a completed pause
 *     already covers the scope (idempotence). Pressing Pause twice does not
 *     run the choreography twice.
 *
 *   * An **emergency stop** is refused only by another emergency stop that
 *     is still in flight. Everything else it SUPERSEDES: a graceful pause
 *     that is hanging on its deadline is precisely when someone reaches for
 *     the big red button, and refusing it then would make the stuck pause
 *     unstoppable. A superseded row is lifted and points at the stop that
 *     took over (`escalated_to`), so the trail survives.
 *
 * The supersede-then-insert pair runs in ONE transaction, because
 * `pause_state_one_active_per_scope` would reject the new row while the old
 * one is still active — and because a visible gap between them is a window
 * in which the office is not paused.
 */
async function openPause(kind: PauseKind, input: PauseInput, deadlineMs: number | null): Promise<OpenedPause> {
  const actor = requireActor(input.initiatedBy);
  const scope = input.projectId ?? null;

  const existing = (await activePauseRows()).map(pauseRowToRecord);
  const touching = existing.filter((pause) => overlaps(pause.projectId, scope));
  const inFlight = touching.filter((pause) => pause.completedAt === null);

  if (kind === "graceful") {
    const blocking = inFlight[0];
    if (blocking) {
      throw new ControlError(
        "pause_in_flight",
        `a ${blocking.kind} pause over ${blocking.projectId === null ? "the whole office" : `project ${blocking.projectId}`} is still in flight; a second pause would interleave with it`,
        `pause ${blocking.id} started by ${blocking.initiatedBy} at ${blocking.startedAt}`,
      );
    }
    const covering = touching.find((pause) => scopeCovers(pause.projectId, scope));
    if (covering) {
      // Idempotent by design: the caller's intent — "nothing runs here" — is
      // already true, and re-running the choreography would interrupt and
      // kill desks that a human may have deliberately started since.
      return { pause: covering, alreadyPaused: true, superseded: [] };
    }
  } else {
    const blocking = inFlight.find((pause) => pause.kind === "emergency");
    if (blocking) {
      throw new ControlError(
        "pause_in_flight",
        "an emergency stop over this scope is already in flight; it is already killing everything in range",
        `stop ${blocking.id} started by ${blocking.initiatedBy} at ${blocking.startedAt}`,
      );
    }
  }

  // Only rows this stop's own scope COVERS may be superseded. An emergency
  // stop on one project must not lift a global pause — that would restart
  // every other project in the office as a side effect of stopping one. The
  // two rows coexist instead: different scope keys, both active.
  const supersede =
    kind === "emergency"
      ? touching.filter((victim) => scopeCovers(scope, victim.projectId))
      : [];

  const row = await withTransaction(async (client) => {
    for (const victim of supersede) {
      await client.query(
        `update pause_state set lifted_at = now(), lifted_by = $2
          where id = $1 and lifted_at is null`,
        [victim.id, actor],
      );
    }
    const inserted = await client.query<PauseStateRow>(
      `insert into pause_state (project_id, kind, initiated_by, reason, deadline_ms)
       values ($1, $2, $3, $4, $5)
       returning ${PAUSE_COLUMNS}`,
      [scope, kind, actor, input.reason?.trim() || null, deadlineMs],
    );
    const created = inserted.rows[0] as PauseStateRow;
    for (const victim of supersede) {
      await client.query(`update pause_state set escalated_to = $2 where id = $1`, [
        victim.id,
        created.id,
      ]);
    }
    return created;
  }).catch((error: unknown) => {
    // 23505 on pause_state_one_active_per_scope: two stop buttons pressed in
    // the same millisecond. The index is what makes the rejection a race-free
    // invariant rather than a check-then-act; this turns it into the same
    // typed error the sequential path produces.
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: string }).code === "23505"
    ) {
      throw new ControlError(
        "pause_in_flight",
        "another pause over this scope was opened concurrently; this one was refused rather than interleaved",
      );
    }
    throw error;
  });

  return { pause: pauseRowToRecord(row), alreadyPaused: false, superseded: supersede };
}

async function completePause(pauseId: string, tasksPaused: number): Promise<PauseRecord> {
  const { rows } = await query<PauseStateRow>(
    `update pause_state
        set completed_at = coalesce(completed_at, now()),
            tasks_paused = $2
      where id = $1
      returning ${PAUSE_COLUMNS}`,
    [pauseId, tasksPaused],
  );
  return pauseRowToRecord(rows[0] as PauseStateRow);
}

// --- Events ---------------------------------------------------------------------

/**
 * Emit AFTER the work it describes has committed, never inside a transaction.
 *
 * The trap ticket 012 shipped with: `recordSystemEvent` writes through the
 * shared pool rather than the caller's transaction, so an event emitted
 * mid-transaction survives that transaction's ROLLBACK and subscribers see
 * something that did not happen. Every call below is after a commit.
 *
 * `projectId` is a COLUMN, not just a payload field: ticket 006's bus filters
 * subscriptions on it, so an event without it reaches no board — and a board
 * that cannot see that its project was paused is the one place this feature
 * must not be invisible.
 */
async function announce(
  type: string,
  projectId: ProjectId | string | null,
  payload: Record<string, unknown>,
): Promise<void> {
  await recordSystemEvent(type, payload, null, projectId);
}

/**
 * Which boards need to hear about this pause.
 *
 * A global pause has no single project to announce to, and an event with a
 * null `project_id` reaches no subscriber at all — so it is announced once
 * per affected project (for the boards) plus once with a null project (the
 * office-wide audit row, which the Company overview page will read when it
 * exists). A scoped pause announces to its own project whether or not
 * anything was running there, because "this project is paused" is news even
 * when the project was idle.
 */
function announceTargets(
  scope: ProjectId | null,
  affected: readonly string[],
): readonly (ProjectId | string | null)[] {
  if (scope !== null) return [scope];
  return [...new Set(affected), null];
}

// --- The scope of a pause -------------------------------------------------------

interface ScopedSession {
  readonly id: SessionId;
  readonly projectId: ProjectId;
  readonly tmuxName: string;
  readonly claudeSessionId: string | null;
}

/**
 * Every live desk in scope.
 *
 * Reuses 008's `listSessions` rather than writing a second definition of
 * "live" — `starting` counts, and that matters: a desk mid-spawn is about to
 * start spending tokens, and leaving it out would let a pause miss exactly
 * the agent that was launched a second before the button was pressed.
 */
async function sessionsInScope(scope: ProjectId | null): Promise<ScopedSession[]> {
  const sessions = await listSessions({ projectId: scope, liveOnly: true });
  return sessions.map((session) => ({
    id: session.id,
    projectId: session.projectId,
    tmuxName: session.tmuxName,
    claudeSessionId: session.claudeSessionId,
  }));
}

async function recordAgents(pauseId: string, sessions: readonly ScopedSession[]): Promise<void> {
  if (sessions.length === 0) return;
  await query(
    `insert into pause_session (pause_id, session_id)
     select $1::uuid, unnest($2::uuid[])
     on conflict (pause_id, session_id) do nothing`,
    [pauseId, sessions.map((session) => session.id)],
  );
}

async function updateAgent(
  pauseId: string,
  sessionId: SessionId,
  set: string,
  params: readonly unknown[],
): Promise<void> {
  await query(
    `update pause_session set ${set} where pause_id = $1 and session_id = $2`,
    [pauseId, sessionId, ...params],
  );
}

async function agentReports(pauseId: string): Promise<readonly PauseAgentReport[]> {
  const { rows } = await query<AgentReportRow>(
    `select ${AGENT_REPORT_COLUMNS}
       from pause_session ps
       join sessions s on s.id = ps.session_id
      where ps.pause_id = $1
      order by s.project_id, s.tmux_name`,
    [pauseId],
  );
  return rows.map(agentRowToReport);
}

/** Reports for several pauses at once — what GET /control/state renders. */
export async function agentReportsFor(
  pauseIds: readonly string[],
): Promise<readonly PauseAgentReport[]> {
  if (pauseIds.length === 0) return [];
  const { rows } = await query<AgentReportRow>(
    `select ${AGENT_REPORT_COLUMNS}
       from pause_session ps
       join sessions s on s.id = ps.session_id
      where ps.pause_id = any($1::uuid[])
      order by s.project_id, s.tmux_name`,
    [pauseIds],
  );
  return rows.map(agentRowToReport);
}

// --- Tasks and locks ------------------------------------------------------------

export interface TaskPauseResult {
  readonly paused: readonly TaskId[];
  readonly alreadyPaused: readonly TaskId[];
  readonly projectIds: readonly string[];
}

/**
 * Move every in-flight task in scope to `paused`, and mark its locks paused
 * in the same transaction.
 *
 * WHICH TASKS: the seven states in ticket 012's `PAUSABLE_STATES` — every
 * state in which work can be in flight, which is all ten minus `draft`,
 * `done` and `paused` itself. This feature does NOT re-decide that set: 012
 * chose it deliberately and documented why `draft` and `done` are excluded,
 * and a second opinion here would mean two definitions of "pausable".
 *
 * Note the consequence for `pending`, which is the one that makes a pause
 * actually stop things: a `pending` task is one nobody has claimed, and
 * moving it to `paused` is what stops a lead claiming it a moment later.
 * Together with the `sessions` insert trigger, that is the whole of "no new
 * work starts while paused".
 *
 * WHY LOCKS AND STATE MOVE TOGETHER: "every affected task is `paused` and
 * its locks are kept and marked paused, exempt from TTL expiry". Ticket 015
 * exempts a paused lock from the sweeper, so a task that reached `paused`
 * without its locks being marked would keep its files only until the TTL ran
 * out — which is the one failure a pause exists to prevent, and it would
 * show up as a git conflict days later rather than as an error now. One
 * transaction, so there is no window where one is true and the other is not.
 *
 * Tasks that are ALREADY paused still have their locks marked, because a
 * task paused by some other route (a crash handler, a rate-limit backoff)
 * may hold unpaused locks, and the criterion is about the state of the
 * system after a pause, not about which code path put it there.
 */
async function pauseTasksInScope(
  scope: ProjectId | null,
  reason: string,
  actor: string,
  actorKind: TaskActorKind,
): Promise<TaskPauseResult> {
  const { rows } = await query<{ id: string; project_id: string; state: string }>(
    `select id, project_id, state from tasks
      where ($1::uuid is null or project_id = $1::uuid)
        and (state = any($2::text[]) or state = 'paused')
      order by id`,
    [scope, [...PAUSABLE_STATES]],
  );

  const paused: TaskId[] = [];
  const alreadyPaused: TaskId[] = [];
  const projectIds = new Set<string>();

  await mapLimited(rows, PHASE_CONCURRENCY, async (row) => {
    const taskId = asTaskId(row.id);
    projectIds.add(row.project_id);

    if (row.state === "paused") {
      await setLocksPaused(taskId, true);
      alreadyPaused.push(taskId);
      return;
    }

    try {
      const result = await withTransaction(async (client: PoolClient) => {
        const moved = await transition(
          {
            taskId,
            to: "paused",
            actor,
            actorKind,
            reason,
            // Optimistic: if the task moved between the read above and this
            // write — claimed, completed, paused by a concurrent stop — the
            // transition fails rather than applying a different edge than
            // this pause had in mind, and the catch below records it.
            expectedFrom: asTaskState(row.state),
          },
          client,
        );
        await setLocksPaused(taskId, true, client);
        return moved;
      });
      // After the commit — see `announce` above for why this is not inside it.
      await announceTransition(result);
      paused.push(taskId);
    } catch (error) {
      if (error instanceof TaskTransitionError) {
        // The task moved under us: claimed, completed, or paused by a
        // concurrent stop. Not a pause failure — one task that slipped past
        // must not abort a pause that is killing agents. Its locks are still
        // marked, because whatever state it reached, the files are still
        // spoken for.
        await setLocksPaused(taskId, true);
        alreadyPaused.push(taskId);
        return;
      }
      throw error;
    }
  });

  return { paused, alreadyPaused, projectIds: [...projectIds] };
}

function pauseReasonText(kind: PauseKind, actor: string, pauseId: string, reason?: string | null): string {
  const label = kind === "emergency" ? "emergency stop" : "pause";
  const detail = reason?.trim() ? `: ${reason.trim()}` : "";
  // Non-blank by construction: every route into `paused` requires a reason
  // (states.ts), because "paused is where every interruption lands — manual
  // pause, crash, circuit breaker, or rate limit" and which one it was is
  // the only thing that distinguishes them afterwards.
  return `${label} by ${actor}${detail} (pause ${pauseId})`;
}

// --- Graceful pause -------------------------------------------------------------

/**
 * Interrupt, instruct, wait, kill — in that order, across every agent in
 * scope at once.
 *
 * The order is the acceptance criterion and it is asserted from the event
 * log, so each phase completes for EVERY agent before the next one starts.
 * That is not only for the test: a per-agent pipeline would have one desk
 * being killed while another had not yet been interrupted, so an operator
 * reading the feed could not tell a pause that is working from one that is
 * stuck.
 *
 * The deadline is SHARED, not per agent. Ten stuck desks must cost one
 * deadline, not ten — "one stuck agent must not block the whole pause" is
 * about wall-clock time as much as about outcome.
 */
export async function pauseScope(input: PauseInput): Promise<PauseResult> {
  const scope = input.projectId ?? null;
  const deadlineMs = input.deadlineMs ?? loadPauseConfig().deadlineMs;
  const opened = await openPause("graceful", input, deadlineMs);
  if (opened.alreadyPaused) {
    return {
      pause: opened.pause,
      agents: await agentReports(opened.pause.id),
      tasksPaused: [],
      tasksAlreadyPaused: [],
      alreadyPaused: true,
      notices: PAUSE_NOTICES,
    };
  }

  const pauseId = opened.pause.id;
  const actor = opened.pause.initiatedBy;
  const sessions = await sessionsInScope(scope);
  await recordAgents(pauseId, sessions);

  for (const target of announceTargets(scope, sessions.map((session) => session.projectId))) {
    await announce("PauseStarted", target, {
      pause_id: pauseId,
      kind: "graceful",
      scope: scope === null ? "global" : "project",
      project_id: scope,
      initiated_by: actor,
      reason: opened.pause.reason,
      deadline_ms: deadlineMs,
      sessions: sessions.length,
      notices: PAUSE_NOTICES,
    });
  }

  // --- Phase 1: interrupt. Escape, and discard anything still queued. -------
  await mapLimited(sessions, PHASE_CONCURRENCY, async (session) => {
    try {
      const result = await interruptSession(session.id, `pause:${actor}`);
      await updateAgent(
        pauseId,
        session.id,
        "interrupted_at = now(), discarded_messages = $3",
        [result.discarded],
      );
      await announce("PauseAgentInterrupted", session.projectId, {
        pause_id: pauseId,
        session_id: session.id,
        tmux_name: session.tmuxName,
        discarded_messages: result.discarded,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await updateAgent(pauseId, session.id, "interrupt_error = $3", [message]);
      await announce("PauseAgentInterrupted", session.projectId, {
        pause_id: pauseId,
        session_id: session.id,
        tmux_name: session.tmuxName,
        error: message,
      });
    }
  });

  // --- Phase 2: instruct. Commit WIP, write a handoff. ----------------------
  //
  // Both halves of that instruction are seams. The commit has no git
  // workflow behind it (step 4) and nothing verifies it; the handoff node has
  // no knowledge graph behind it (step 5) and `requestHandoffNode` returns
  // null with a warning. The message still goes out, because an agent that is
  // about to be killed is better off being told than not, and because the
  // step that fills these in should find the call already here.
  const instruction = pauseInstruction(deadlineMs);
  await mapLimited(sessions, PHASE_CONCURRENCY, async (session) => {
    let instructionError: string | null = null;
    try {
      await messageSession(session.id, instruction, `pause:${actor}`);
    } catch (error) {
      // Expected sometimes, and not a bug: ticket 008 refuses to deliver
      // while a permission dialog is open, because a message delivered into
      // a dialog APPROVES the pending tool call (measured on the target,
      // 20/20, with the approved command's file left on disk). A pause must
      // not answer a permission prompt on its way past — so the refusal is
      // recorded and the desk is killed at the end of the deadline like any
      // other.
      instructionError =
        error instanceof SessionError
          ? `${error.kind}: ${error.message}`
          : error instanceof Error
            ? error.message
            : String(error);
    }
    const handoffRef = await requestHandoffNode(session);
    await query(
      `update pause_session
          set instructed_at = case when $3::text is null then now() else instructed_at end,
              instruction_error = $3,
              handoff_requested_at = now()
        where pause_id = $1 and session_id = $2`,
      [pauseId, session.id, instructionError],
    );
    if (handoffRef !== null) {
      // Unreachable until build step 5; written this way so the step that
      // fills the seam only has to change requestHandoffNode.
      await query(`update sessions set handoff_ref = $2 where id = $1`, [session.id, handoffRef]);
    }
    await announce("PauseAgentInstructed", session.projectId, {
      pause_id: pauseId,
      session_id: session.id,
      tmux_name: session.tmuxName,
      ...(instructionError === null ? {} : { error: instructionError }),
      handoff_ref: handoffRef,
      handoff_notice: HANDOFF_UNAVAILABLE_NOTICE,
      commit_notice: WIP_COMMIT_UNVERIFIED_NOTICE,
    });
  });

  // --- Phase 3: wait, once, for everyone. -----------------------------------
  //
  // Monotonic, because this host's wall clock steps backwards. `remaining` is
  // recomputed per agent so a slow phase 2 eats into the deadline rather than
  // extending it: the deadline is "how long the office waits", not "how long
  // each desk gets".
  const deadlineAt = deps.monotonicMs() + deadlineMs;
  await mapLimited(sessions, PHASE_CONCURRENCY, async (session) => {
    if (session.claudeSessionId === null) {
      // Nothing to watch: a desk that has never reported a Claude session id
      // has no event stream. Recording that as a missed deadline would be a
      // lie about the agent rather than a fact about the orchestrator.
      const note =
        "no Claude session id had been reported, so the turn end could not be observed; killed without waiting";
      await updateAgent(pauseId, session.id, "note = $3", [note]);
      await announce("PauseAgentDeadlineMissed", session.projectId, {
        pause_id: pauseId,
        session_id: session.id,
        tmux_name: session.tmuxName,
        observed: false,
        note,
      });
      return;
    }
    const remaining = Math.max(0, deadlineAt - deps.monotonicMs());
    const settled = await deps.waitForTurnEnd(session.claudeSessionId, remaining);
    if (settled) {
      await updateAgent(pauseId, session.id, "settled_at = now()", []);
      await announce("PauseAgentSettled", session.projectId, {
        pause_id: pauseId,
        session_id: session.id,
        tmux_name: session.tmuxName,
      });
      return;
    }
    await updateAgent(pauseId, session.id, "deadline_missed = true", []);
    await announce("PauseAgentDeadlineMissed", session.projectId, {
      pause_id: pauseId,
      session_id: session.id,
      tmux_name: session.tmuxName,
      observed: true,
      deadline_ms: deadlineMs,
    });
  });

  // --- Phase 4: kill. Everyone, including whoever missed the deadline. ------
  await killAgents(pauseId, sessions, actor, "pause");

  const tasks = await pauseTasksInScope(
    scope,
    pauseReasonText("graceful", actor, pauseId, opened.pause.reason),
    actor,
    input.initiatedByKind ?? "human",
  );
  const pause = await completePause(pauseId, tasks.paused.length);
  const agents = await agentReports(pauseId);

  for (const target of announceTargets(scope, [
    ...sessions.map((session) => session.projectId),
    ...tasks.projectIds,
  ])) {
    await announce("PauseCompleted", target, {
      pause_id: pauseId,
      kind: "graceful",
      scope: scope === null ? "global" : "project",
      project_id: scope,
      initiated_by: actor,
      sessions_killed: agents.filter((agent) => agent.killedAt !== null).length,
      deadline_missed: agents.filter((agent) => agent.deadlineMissed).map((agent) => agent.tmuxName),
      tasks_paused: tasks.paused.length,
      tasks_already_paused: tasks.alreadyPaused.length,
      notices: PAUSE_NOTICES,
    });
  }

  return {
    pause,
    agents,
    tasksPaused: tasks.paused,
    tasksAlreadyPaused: tasks.alreadyPaused,
    alreadyPaused: false,
    notices: PAUSE_NOTICES,
  };
}

async function killAgents(
  pauseId: string,
  sessions: readonly ScopedSession[],
  actor: string,
  endReason: "pause" | "emergency_stop",
): Promise<void> {
  await mapLimited(sessions, PHASE_CONCURRENCY, async (session) => {
    let killError: string | null = null;
    try {
      // `kill-session` fires SessionEnd — measured on the target 5/5 idle and
      // 5/5 mid-turn — so 008's handler will also see the desk end. That is
      // harmless: `killSession` is idempotent and the handler finds the row
      // already terminal.
      await killSession(session.id, `${endReason}:${actor}`);
    } catch (error) {
      killError = error instanceof Error ? error.message : String(error);
    }
    // The restart reason, on the row that exists at this moment. Ticket 026's
    // conversation divider reads it off the ENDED session, because the
    // replacement desk may not be spawned for days.
    await query(`update sessions set end_reason = $2 where id = $1`, [session.id, endReason]);
    await updateAgent(
      pauseId,
      session.id,
      "killed_at = case when $3::text is null then now() else killed_at end, kill_error = $3",
      [killError],
    );
    await announce("PauseAgentKilled", session.projectId, {
      pause_id: pauseId,
      session_id: session.id,
      tmux_name: session.tmuxName,
      end_reason: endReason,
      ...(killError === null ? {} : { error: killError }),
    });
  });
}

// --- Emergency stop -------------------------------------------------------------

/**
 * Kill everything in scope now. No interrupt, no instruction, no wait.
 *
 * WHAT IT DOES ABOUT THE QUEUE, and why it is not just "the same kills
 * without the waiting". Ticket 008 owns a durable mid-turn message queue
 * because of a measurement: a message queued before Escape still RAN in 17
 * of 19 trials on the target host and was discarded in 2 — same host, same
 * command, two behaviours. So tmux cannot be assumed to forget anything, and
 * an emergency stop that killed the panes while leaving pending rows behind
 * would be a stop whose last act might be to deliver an instruction.
 *
 * Every pending message for every in-scope session is therefore discarded in
 * ONE statement BEFORE the first kill. `killSession` discards again per
 * desk; the bulk statement first is what shrinks the window rather than
 * relying on each desk's turn coming round.
 *
 * SPEED: the criterion is ten sessions in under five seconds. The kills are
 * issued concurrently (bounded — see PHASE_CONCURRENCY) and nothing waits on
 * an agent, so the cost is one bounded fan-out of `tmux kill-session`, which
 * the target host answers in milliseconds. No deadline is read, and that is
 * deliberate: PAUSE_DEADLINE_MS is required config with no default, and the
 * big red button must not be the thing that discovers it is unset.
 */
export async function emergencyStop(input: PauseInput): Promise<PauseResult> {
  const scope = input.projectId ?? null;
  const opened = await openPause("emergency", input, null);
  const pauseId = opened.pause.id;
  const actor = opened.pause.initiatedBy;
  const sessions = await sessionsInScope(scope);
  await recordAgents(pauseId, sessions);

  for (const target of announceTargets(scope, sessions.map((session) => session.projectId))) {
    await announce("EmergencyStopStarted", target, {
      pause_id: pauseId,
      kind: "emergency",
      scope: scope === null ? "global" : "project",
      project_id: scope,
      initiated_by: actor,
      reason: opened.pause.reason,
      sessions: sessions.length,
      superseded: opened.superseded.map((pause) => pause.id),
      notices: PAUSE_NOTICES,
    });
  }

  for (const superseded of opened.superseded) {
    await announce("PauseEscalated", superseded.projectId, {
      pause_id: superseded.id,
      escalated_to: pauseId,
      kind: superseded.kind,
      initiated_by: actor,
    });
  }

  // The queue, before the kills. See the doc comment.
  if (sessions.length > 0) {
    const { rows: discarded } = await query<{ id: string; session_id: string }>(
      `update session_message_queue
          set status = 'discarded', discard_reason = $2
        where session_id = any($1::uuid[]) and status = 'pending'
        returning id, session_id`,
      [sessions.map((session) => session.id), `emergency stop by ${actor}`],
    );
    const perSession = new Map<string, number>();
    for (const row of discarded) {
      perSession.set(row.session_id, (perSession.get(row.session_id) ?? 0) + 1);
    }
    for (const [sessionId, count] of perSession) {
      await updateAgent(pauseId, asSessionId(sessionId), "discarded_messages = $3", [count]);
    }
    for (const target of announceTargets(scope, sessions.map((session) => session.projectId))) {
      await announce("PauseQueueDiscarded", target, {
        pause_id: pauseId,
        discarded_messages: discarded.length,
        sessions: sessions.length,
      });
    }
  }

  await killAgents(pauseId, sessions, actor, "emergency_stop");

  const tasks = await pauseTasksInScope(
    scope,
    pauseReasonText("emergency", actor, pauseId, opened.pause.reason),
    actor,
    input.initiatedByKind ?? "human",
  );
  const pause = await completePause(pauseId, tasks.paused.length);
  const agents = await agentReports(pauseId);

  for (const target of announceTargets(scope, [
    ...sessions.map((session) => session.projectId),
    ...tasks.projectIds,
  ])) {
    await announce("EmergencyStopCompleted", target, {
      pause_id: pauseId,
      kind: "emergency",
      scope: scope === null ? "global" : "project",
      project_id: scope,
      initiated_by: actor,
      sessions_killed: agents.filter((agent) => agent.killedAt !== null).length,
      kill_errors: agents.filter((agent) => agent.killError !== null).map((agent) => agent.tmuxName),
      tasks_paused: tasks.paused.length,
      tasks_already_paused: tasks.alreadyPaused.length,
      notices: PAUSE_NOTICES,
    });
  }

  return {
    pause,
    agents,
    tasksPaused: tasks.paused,
    tasksAlreadyPaused: tasks.alreadyPaused,
    alreadyPaused: false,
    notices: PAUSE_NOTICES,
  };
}

// --- Lifting, for ./resume.ts ---------------------------------------------------

/**
 * Lift the pauses covering a scope. Returns the one that was lifted, or null
 * when nothing was in effect.
 *
 * Lives here rather than in resume.ts because `pause_state` is this module's
 * table and a second place that writes `lifted_at` is a second place that
 * can get the scope rule wrong.
 *
 * REFUSES WHILE A CHOREOGRAPHY IS IN FLIGHT. Lifting a pause whose kills are
 * still being issued would race: resume would un-pause tasks that the pause
 * is about to pause again, and the office would end up half-stopped with no
 * record of which half. The remedy for a hanging pause is an emergency stop,
 * not a resume.
 */
export async function liftPausesFor(
  scope: ProjectId | null,
  liftedBy: string,
): Promise<PauseRecord | null> {
  const actor = requireActor(liftedBy);
  const active = (await activePauseRows()).map(pauseRowToRecord);
  const touching = active.filter((pause) => overlaps(pause.projectId, scope));
  const inFlight = touching.find((pause) => pause.completedAt === null);
  if (inFlight) {
    throw new ControlError(
      "pause_in_flight",
      `the ${inFlight.kind} pause over ${inFlight.projectId === null ? "the whole office" : `project ${inFlight.projectId}`} is still in flight; wait for it to finish, or press emergency stop`,
      `pause ${inFlight.id} started by ${inFlight.initiatedBy} at ${inFlight.startedAt}`,
    );
  }

  // A GLOBAL pause is not lifted by resuming one project. Doing so would
  // silently restart every other project in the office, which nobody asked
  // for and which the person who pressed the office-wide Pause would have no
  // way to notice. Refused with the reason, rather than partially honoured.
  const globalPause = touching.find((pause) => pause.projectId === null);
  if (scope !== null && globalPause) {
    throw new ControlError(
      "project_paused",
      `a global pause is in effect, so nothing in project ${scope} can be resumed on its own`,
      `global ${globalPause.kind} pause ${globalPause.id} started by ${globalPause.initiatedBy} at ${globalPause.startedAt}. Resume the whole office to lift it.`,
    );
  }

  // A global resume lifts every active pause — it is a statement about the
  // whole office, project pauses inside it included.
  const toLift = scope === null ? touching : touching.filter((pause) => pause.projectId === scope);
  if (toLift.length === 0) return null;

  const { rows } = await query<PauseStateRow>(
    `update pause_state set lifted_at = now(), lifted_by = $2
      where id = any($1::uuid[]) and lifted_at is null
      returning ${PAUSE_COLUMNS}`,
    [toLift.map((pause) => pause.id), actor],
  );
  const lifted = rows.map(pauseRowToRecord);
  // The one that matches the scope exactly is the most specific answer to
  // "what was lifted here"; a global resume reports the global row.
  return lifted.find((pause) => pause.projectId === scope) ?? lifted[0] ?? null;
}
