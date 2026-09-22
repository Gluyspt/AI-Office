// The task state machine: the transition table, and the one function that
// applies a transition.
//
// Two properties this file exists to hold, both of which every later
// coordination ticket (013, 014, 015, 017, 019, 028, 032) depends on:
//
//   1. **The legal edges are data, not scattered ifs.** TASK_TRANSITIONS
//      below is a list of rows, each naming its source in the design. There
//      is exactly one place to read what is legal, and a table-driven test
//      walks the whole 10x10 matrix against it.
//   2. **transition() is the only way `state` changes**, and every change
//      writes its audit row in the same transaction. Neither is a
//      convention: db/migrations/0005_tasks.sql installs triggers that
//      reject a direct UPDATE (SQLSTATE OF001), reject a birth in any state
//      but `draft` (OF003), and, at COMMIT, reject a state change with no
//      matching task_state_history row (OF002). This module is the only
//      code that opts a transaction in.
//
// What this file deliberately does NOT do: decide *who* may perform a
// transition. The design says nothing about that, and permissions are step
// 9. `actor` and `actorKind` are recorded, never checked. The guards below
// are the design's own preconditions only.
import type { PoolClient } from "pg";
import type {
  TaskActorKind,
  TaskDepartment,
  TaskRecord,
  TaskState,
  TaskStateChange,
} from "@office/shared/tasks";
import { TASK_STATES, asTaskState, isTaskActorKind, isTaskDepartment } from "@office/shared/tasks";
import { asProjectId, asTaskId, type TaskId } from "@office/shared/ids";
import { query, withTransaction } from "../../core/db/pool.ts";
import { recordSystemEvent } from "../events/ingest.ts";

// --- The transition table ------------------------------------------------------

/** Why an edge exists, so a reader can tell a lifecycle-diagram edge from
 * one the design's prose requires. */
export type TransitionSource = "lifecycle-diagram" | "pause-rule";

export interface TransitionRule {
  readonly from: TaskState;
  readonly to: TaskState;
  /** The design's own name for the edge - the label on the diagram arrow,
   * or the MCP tool that performs it. Surfaced in errors and useful to the
   * UI; not an identifier anything keys on. */
  readonly label: string;
  readonly source: TransitionSource;
  /**
   * Whether a `reason` is required. True only where the design asks for one
   * in so many words:
   *   - `reject_task(task_id, reason)` takes one (QA review -> in progress);
   *   - Send back "reopens the task with your comment" (delivered -> in progress);
   *   - a CI failure has a failure to report (CI -> in progress);
   *   - everything into `paused`, because "paused is where every
   *     interruption lands - manual pause, crash, circuit breaker, or rate
   *     limit" and one Resume recovers all of them: which one it was is the
   *     only thing that distinguishes them afterwards.
   */
  readonly requiresReason: boolean;
}

/**
 * Every state a task can be paused from.
 *
 * ASSUMPTION, stated rather than quietly picked. Ticket 012's criterion
 * says "any state can move to paused"; the lifecycle diagram draws only
 * `in progress <-> paused`; the prose says paused is where every
 * interruption lands. Taken literally, "any state" would include `draft`
 * and `done` - but a draft task has never been started (nothing runs until
 * Start working) and a done task is closed, so pausing either would put a
 * card that no agent is working on into the In progress column, empty the
 * Done column on a project-wide pause, and give a finished task a "paused /
 * 2d" chip. So: every state in which work can be in flight, which is all
 * ten minus `draft`, `done` and `paused` itself. Seven origins, well past
 * the four the criterion asks to be verified. Widening it is one line.
 */
export const PAUSABLE_STATES: readonly TaskState[] = TASK_STATES.filter(
  (state) => state !== "draft" && state !== "done" && state !== "paused",
);

/**
 * The legal edges. The first thirteen are exactly the arrows in the
 * design's lifecycle diagram (docs/ai-agent-office-design.md, "Task
 * lifecycle / States"), in diagram order; the rest are the pause rule
 * applied to PAUSABLE_STATES above.
 *
 * Note what is absent and must stay absent: there is no `in_progress ->
 * done`. "A dev calling complete_task moves the task to ready for QA, never
 * straight to done" - the three test stages are the reason the machine
 * exists at all.
 */
export const TASK_TRANSITIONS: readonly TransitionRule[] = [
  // --- the lifecycle diagram, arrow by arrow ---
  { from: "draft", to: "pending", label: "start working", source: "lifecycle-diagram", requiresReason: false },
  { from: "pending", to: "in_progress", label: "claim_task", source: "lifecycle-diagram", requiresReason: false },
  { from: "in_progress", to: "paused", label: "pause", source: "lifecycle-diagram", requiresReason: true },
  { from: "paused", to: "in_progress", label: "resume", source: "lifecycle-diagram", requiresReason: false },
  { from: "in_progress", to: "ready_for_qa", label: "complete_task", source: "lifecycle-diagram", requiresReason: false },
  { from: "ready_for_qa", to: "ci", label: "CI starts", source: "lifecycle-diagram", requiresReason: false },
  { from: "ci", to: "in_progress", label: "CI fail", source: "lifecycle-diagram", requiresReason: true },
  { from: "ci", to: "qa_review", label: "CI pass", source: "lifecycle-diagram", requiresReason: false },
  { from: "qa_review", to: "in_progress", label: "reject_task", source: "lifecycle-diagram", requiresReason: true },
  { from: "qa_review", to: "lead_approval", label: "approve_task", source: "lifecycle-diagram", requiresReason: false },
  { from: "lead_approval", to: "delivered", label: "deliver_task", source: "lifecycle-diagram", requiresReason: false },
  { from: "delivered", to: "done", label: "accept", source: "lifecycle-diagram", requiresReason: false },
  { from: "delivered", to: "in_progress", label: "send back", source: "lifecycle-diagram", requiresReason: true },

  // --- the pause rule: any in-flight state pauses, and Resume returns it ---
  ...PAUSABLE_STATES.filter((state) => state !== "in_progress").flatMap(
    (state): TransitionRule[] => [
      { from: state, to: "paused", label: "pause", source: "pause-rule", requiresReason: true },
      { from: "paused", to: state, label: "resume", source: "pause-rule", requiresReason: false },
    ],
  ),
];

const RULES_BY_EDGE: ReadonlyMap<string, TransitionRule> = new Map(
  TASK_TRANSITIONS.map((rule) => [`${rule.from}->${rule.to}`, rule]),
);

/** Table membership only - no guards, no context. Use `checkTransition`
 * when the answer needs to account for a task's actual situation. */
export function isLegalTransition(from: TaskState, to: TaskState): boolean {
  return RULES_BY_EDGE.has(`${from}->${to}`);
}

export function transitionRule(from: TaskState, to: TaskState): TransitionRule | undefined {
  return RULES_BY_EDGE.get(`${from}->${to}`);
}

/** Every state reachable from `from` in one step. */
export function legalTargets(from: TaskState): readonly TaskState[] {
  return TASK_TRANSITIONS.filter((rule) => rule.from === from).map((rule) => rule.to);
}

// --- Errors ---------------------------------------------------------------------

/** Base class, so a caller can catch every refusal from this module at once
 * without catching unrelated database errors. */
export class TaskTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * The transition is not allowed: the edge is not in the table, or it is but
 * this task fails the edge's guard. A typed error with the edge on it -
 * never a silent no-op, never a thrown string, because a caller that cannot
 * tell "refused" from "applied" will report success to an agent that then
 * waits forever.
 */
export class IllegalTransitionError extends TaskTransitionError {
  constructor(
    readonly from: TaskState,
    readonly to: TaskState,
    readonly detail: string,
    readonly taskId?: TaskId,
  ) {
    super(
      `illegal task transition ${from} -> ${to}${taskId ? ` (task ${taskId})` : ""}: ${detail}`,
    );
  }
}

export class TaskNotFoundError extends TaskTransitionError {
  constructor(readonly taskId: TaskId) {
    super(`no task ${taskId}`);
  }
}

/** The task moved under the caller: either the row changed between read and
 * write, or the caller's `expectedFrom` was already stale. Distinct from
 * IllegalTransitionError because the retry is different - re-read, then
 * decide. */
export class ConcurrentTransitionError extends TaskTransitionError {
  constructor(
    readonly taskId: TaskId,
    readonly expected: TaskState,
    readonly actual: TaskState,
  ) {
    super(`task ${taskId} is in ${actual}, not ${expected} - it moved under this transition`);
  }
}

// --- Guards ------------------------------------------------------------------------

/** What a guard is allowed to know. Deliberately small: anything a guard
 * cannot see here, this ticket does not decide. Dependency state (014),
 * file-scope overlap (015) and the complete_task preconditions (017) are
 * those tickets' checks, layered on top of a legal transition - not
 * reimplemented here from a design this ticket would have to invent. */
export interface TransitionContext {
  /** The state the task was paused from, when the task is currently
   * `paused`. Read from the newest task_state_history row whose to_state is
   * `paused` - a LIMIT 1 on an index, not a walk. */
  readonly pausedFrom?: TaskState;
  /** The reason supplied with this transition, if any. */
  readonly reason?: string | null;
}

export type TransitionCheck =
  | { readonly ok: true; readonly rule: TransitionRule }
  | { readonly ok: false; readonly detail: string };

/**
 * The whole decision, pure and storage-free: is this edge in the table, and
 * does this task satisfy the edge's guards? `transition()` is this function
 * plus the two writes.
 */
export function checkTransition(
  from: TaskState,
  to: TaskState,
  context: TransitionContext = {},
): TransitionCheck {
  const rule = transitionRule(from, to);
  if (!rule) {
    if (from === to) {
      // Worth its own message: a no-op is the shape of a caller that
      // believes it moved a task and did not.
      return { ok: false, detail: `${from} is already the current state; transitions must move` };
    }
    return { ok: false, detail: `no such edge in the transition table` };
  }

  // Guard: Resume returns the task to the state it was paused from, and to
  // nothing else. Without this, `paused` would be a wormhole from any state
  // to any other - pause an in-progress task, resume it into `delivered`.
  if (from === "paused") {
    if (context.pausedFrom === undefined) {
      return {
        ok: false,
        detail:
          "the task is paused but no history row records what it was paused from; " +
          "resume has no origin to return to",
      };
    }
    if (context.pausedFrom !== to) {
      return {
        ok: false,
        detail: `resume returns a task to the state it was paused from (${context.pausedFrom})`,
      };
    }
  }

  if (rule.requiresReason && (context.reason ?? "").trim() === "") {
    return { ok: false, detail: `the "${rule.label}" transition requires a reason` };
  }

  return { ok: true, rule };
}

// --- Row mapping ---------------------------------------------------------------------

/** The `tasks` row as pg hands it back. Exported so ticket 013's repo can
 * reuse the shape and the mapper below rather than write a second one that
 * drifts. */
export interface TaskRow {
  readonly id: string;
  readonly project_id: string;
  readonly title: string;
  readonly brief: string;
  readonly department: string;
  readonly owner: string;
  readonly state: string;
  readonly model: string | null;
  readonly model_reason: string | null;
  readonly branch: string | null;
  /** int8. pg returns bigint as a *string* by default (it does not fit a JS
   * number in general), so this is typed honestly and converted below. */
  readonly token_cost: string;
  readonly turn_count: number;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly state_entered_at: Date;
}

export const TASK_COLUMNS =
  "id, project_id, title, brief, department, owner, state, model, model_reason, " +
  "branch, token_cost, turn_count, created_at, updated_at, state_entered_at";

/** Narrows a text column read back from the database, throwing rather than
 * casting a value the check constraint should have made impossible. A cast
 * would turn a schema drift into a silently wrong type at the far end of
 * the system. */
function narrow<T extends string>(
  value: string,
  guard: (candidate: unknown) => candidate is T,
  column: string,
): T {
  if (!guard(value)) {
    throw new TypeError(`tasks.${column} holds an unknown value: ${JSON.stringify(value)}`);
  }
  return value;
}

export function taskRowToRecord(row: TaskRow): TaskRecord {
  return {
    id: asTaskId(row.id),
    projectId: asProjectId(row.project_id),
    title: row.title,
    brief: row.brief,
    department: narrow(row.department, isTaskDepartment, "department"),
    owner: row.owner,
    state: asTaskState(row.state),
    model: row.model,
    modelReason: row.model_reason,
    branch: row.branch,
    tokenCost: Number(row.token_cost),
    turnCount: row.turn_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stateEnteredAt: row.state_entered_at,
  };
}

interface HistoryRow {
  readonly id: string;
  readonly task_id: string;
  readonly from_state: string;
  readonly to_state: string;
  readonly actor: string;
  readonly actor_kind: string;
  readonly reason: string | null;
  readonly occurred_at: Date;
}

function historyRowToChange(row: HistoryRow): TaskStateChange {
  return {
    id: row.id,
    taskId: asTaskId(row.task_id),
    fromState: asTaskState(row.from_state),
    toState: asTaskState(row.to_state),
    actor: row.actor,
    actorKind: row.actor_kind as TaskActorKind,
    reason: row.reason,
    occurredAt: row.occurred_at,
  };
}

// --- Applying a transition ----------------------------------------------------------

export interface TransitionInput {
  readonly taskId: TaskId;
  readonly to: TaskState;
  /** Who moved it. Recorded, never checked - see the module header. */
  readonly actor: string;
  readonly actorKind: TaskActorKind;
  /** Why. Required on the edges whose `requiresReason` is true. */
  readonly reason?: string | null;
  /** Optimistic check: if given and the task is in some other state, the
   * call fails with ConcurrentTransitionError instead of silently applying
   * a different edge than the caller had in mind. */
  readonly expectedFrom?: TaskState;
}

export interface TransitionResult {
  readonly task: TaskRecord;
  readonly change: TaskStateChange;
}

const SELECT_PAUSE_ORIGIN = `
  select from_state
  from task_state_history
  where task_id = $1 and to_state = 'paused'
  order by occurred_at desc, id desc
  limit 1`;

/** The pause origin for a currently-paused task: one indexed row, not a
 * history walk. Exported because ticket 028's Resume needs to show it
 * before acting, and ticket 024's chip may want to label it. Uses the
 * shared pool unless a client is supplied - pass the client when the answer
 * has to be consistent with the rest of a transaction. */
export async function pausedOriginState(
  taskId: TaskId,
  client?: PoolClient,
): Promise<TaskState | undefined> {
  const result = client
    ? await client.query<{ from_state: string }>(SELECT_PAUSE_ORIGIN, [taskId])
    : await query<{ from_state: string }>(SELECT_PAUSE_ORIGIN, [taskId]);
  const row = result.rows[0];
  return row ? asTaskState(row.from_state) : undefined;
}

async function applyTransition(
  client: PoolClient,
  input: TransitionInput,
): Promise<TransitionResult> {
  // FOR UPDATE, so two agents racing to move the same task serialise here
  // rather than both reading `pending` and both claiming.
  const current = await client.query<TaskRow>(
    `select ${TASK_COLUMNS} from tasks where id = $1 for update`,
    [input.taskId],
  );
  const currentRow = current.rows[0];
  if (!currentRow) {
    throw new TaskNotFoundError(input.taskId);
  }
  const from = asTaskState(currentRow.state);

  if (input.expectedFrom !== undefined && input.expectedFrom !== from) {
    throw new ConcurrentTransitionError(input.taskId, input.expectedFrom, from);
  }

  const context: TransitionContext = {
    reason: input.reason,
    ...(from === "paused" ? { pausedFrom: await pausedOriginState(input.taskId, client) } : {}),
  };

  const check = checkTransition(from, input.to, context);
  if (!check.ok) {
    throw new IllegalTransitionError(from, input.to, check.detail, input.taskId);
  }

  if (input.actor.trim() === "") {
    throw new IllegalTransitionError(
      from,
      input.to,
      "a transition must record an actor",
      input.taskId,
    );
  }

  // The opt-in the 0005 triggers look for. SET LOCAL is transaction-scoped,
  // so it cannot leak onto the next borrower of this pooled connection; it
  // is cleared below anyway, so a caller-supplied transaction that goes on
  // to do other writes is not left with the guard disarmed.
  await client.query(`set local office.task_transition = 'on'`);
  try {
    const updated = await client.query<TaskRow>(
      `update tasks set state = $2 where id = $1 and state = $3 returning ${TASK_COLUMNS}`,
      [input.taskId, input.to, from],
    );
    const updatedRow = updated.rows[0];
    if (!updatedRow) {
      // Unreachable while the FOR UPDATE above holds, kept as a belt on the
      // braces: a silently-skipped UPDATE is exactly the failure mode this
      // module exists to make impossible.
      throw new ConcurrentTransitionError(input.taskId, from, from);
    }

    const inserted = await client.query<HistoryRow>(
      // occurred_at is read straight out of the row in SQL rather than sent
      // as a parameter, and that is load-bearing. The trigger stamped
      // state_entered_at with clock_timestamp(), which Postgres keeps to the
      // microsecond; the pg driver hands it back as a JS Date, which carries
      // only milliseconds. Passing that truncated value back would write an
      // occurred_at a few hundred microseconds adrift of state_entered_at,
      // and the deferred constraint trigger — which matches the two exactly —
      // would fire at COMMIT on every single transition.
      //
      // Same trap as the event cursor in events/ingest.ts: any timestamp that
      // has to match a stored value must not make a round trip through a JS
      // Date.
      `insert into task_state_history
         (task_id, from_state, to_state, actor, actor_kind, reason, occurred_at)
       select $1, $2, $3, $4, $5, $6, t.state_entered_at
         from tasks t
        where t.id = $1
       returning id, task_id, from_state, to_state, actor, actor_kind, reason, occurred_at`,
      [
        input.taskId,
        from,
        input.to,
        input.actor,
        input.actorKind,
        input.reason ?? null,
      ],
    );
    const historyRow = inserted.rows[0];
    if (!historyRow) {
      throw new Error("insert into task_state_history returned no row");
    }

    return { task: taskRowToRecord(updatedRow), change: historyRowToChange(historyRow) };
  } finally {
    // Swallowed deliberately: if the body above failed, the transaction is
    // already aborted and this SET would throw "current transaction is
    // aborted", replacing the real error with a useless one. The guard is
    // re-armed by the rollback in that case anyway.
    try {
      await client.query(`set local office.task_transition = 'off'`);
    } catch {
      /* see above */
    }
  }
}

/**
 * Move a task to `to`, recording who and why. **The only way `tasks.state`
 * changes** - see the module header for how the database enforces that
 * rather than trusting it.
 *
 * Runs in its own transaction unless a `client` is supplied, so a caller
 * that is already mid-transaction (ticket 017's claim_task, taking a file
 * lock in the same breath) can compose rather than open a second one. The
 * state change and its task_state_history row always commit together.
 *
 * Throws IllegalTransitionError, TaskNotFoundError or
 * ConcurrentTransitionError; never returns a "didn't work" value, and never
 * no-ops.
 */
/**
 * Announces a transition that has actually committed.
 *
 * Separate from `transition()` because of *when* it is safe to call. An
 * event is a claim to the rest of the system that something happened; if it
 * is emitted inside a transaction that later rolls back, the claim is false
 * and nothing takes it back. `recordSystemEvent` writes through the shared
 * pool rather than the caller's transaction, so emitting mid-transaction
 * would survive a rollback.
 *
 * `transition()` calls this itself on the path where it owns the
 * transaction. A caller that supplies its own client owns the commit, and
 * therefore owns the announcement: call this once the transaction has
 * committed.
 */
export async function announceTransition(result: TransitionResult): Promise<void> {
  await recordSystemEvent(
    "TaskTransitioned",
    {
      task_id: result.task.id,
      project_id: result.task.projectId,
      from_state: result.change.fromState,
      to_state: result.change.toState,
      actor: result.change.actor,
      actor_kind: result.change.actorKind,
      reason: result.change.reason,
      occurred_at: result.change.occurredAt.toISOString(),
    },
    null,
    // The column, not just the payload: ticket 006's bus filters
    // subscriptions on it, and a board watching one project is exactly who
    // needs to hear that a card moved.
    result.task.projectId,
  );
}

/**
 * Applies a transition, and announces it when it owns the commit.
 *
 * The announcement is what makes a card move on the board. Before this
 * existed, nothing in the system emitted on a state change — 013 emitted
 * TaskCreated, 014 TasksUnblocked, 015 FileLocksSwept, and that was the
 * whole list — so ticket 023's board reconciled correctly against a
 * synthetic event and would never have seen a real one.
 */
export async function transition(
  input: TransitionInput,
  client?: PoolClient,
): Promise<TransitionResult> {
  if (client) {
    // The caller owns the transaction, so the caller owns the
    // announcement: see announceTransition. Emitting here could announce a
    // change the caller's ROLLBACK then discards.
    return applyTransition(client, input);
  }
  const result = await withTransaction((owned) => applyTransition(owned, input));
  await announceTransition(result);
  return result;
}

/**
 * A task's state changes, oldest first. The full path a task took is this
 * list's first `fromState` followed by every `toState` - there is no
 * creation row, because a task is born in `draft` and history records
 * changes.
 */
export async function taskStateHistory(
  taskId: TaskId,
  client?: PoolClient,
): Promise<TaskStateChange[]> {
  const sql = `select id, task_id, from_state, to_state, actor, actor_kind, reason, occurred_at
     from task_state_history
     where task_id = $1
     order by occurred_at asc, id asc`;
  const result = client
    ? await client.query<HistoryRow>(sql, [taskId])
    : await query<HistoryRow>(sql, [taskId]);
  return result.rows.map(historyRowToChange);
}
