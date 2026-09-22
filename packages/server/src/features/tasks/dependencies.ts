// The dependency graph: add, remove, cycle detection, claimability, and
// unblocking on delivery.
//
// "Without this, Management cannot express 'build the API before the UI
// that consumes it,' and agents start work that can't finish." It is also
// what makes Resume-everything meaningful, since the design requires
// resuming a project's paused tasks "respecting dependencies".
//
//
// WHY `delivered` AND NOT `done`
// -------------------------------
// The squash-merge into `main-dev` is the moment the code a dependent needs
// actually exists. Waiting for a human to accept the delivery report would
// stall every chain at a human gate — which, with leads claiming
// automatically, is the common case rather than the exception. `done` is
// unchanged; only the unblock point moves earlier. Recorded as a decision
// in docs/tasks/README.md, and the consequence (a send-back can strand
// dependents that already started) is carried to step 4 in this ticket.
import type { PoolClient } from "pg";
import type { ProjectId, TaskId } from "@office/shared/ids";
import { asTaskId } from "@office/shared/ids";
import type { TaskState } from "@office/shared/tasks";
import { query, withTransaction } from "../../core/db/pool.ts";
import { recordSystemEvent } from "../events/ingest.ts";

/**
 * The state a blocker must reach before its dependents may start. One
 * constant, referenced everywhere, so "unblock at delivered" is a single
 * edit if the decision is ever revisited.
 */
export const UNBLOCKING_STATE: TaskState = "delivered";

/** States at or past the unblocking point. `done` counts: a task that has
 * been accepted has certainly been delivered. */
const SATISFIED_STATES: readonly TaskState[] = [UNBLOCKING_STATE, "done"];

export class DependencyError extends Error {
  constructor(message: string, readonly detail?: Record<string, unknown>) {
    super(message);
    this.name = "DependencyError";
  }
}

export class DependencyCycleError extends DependencyError {
  constructor(readonly path: readonly TaskId[]) {
    super(
      `adding this dependency would create a cycle: ${path.join(" -> ")}`,
      { cycle: path },
    );
    this.name = "DependencyCycleError";
  }
}

// --- Reading the graph -------------------------------------------------------

export interface DependencyEdges {
  /** Tasks this one waits for. */
  readonly blockedBy: readonly TaskId[];
  /** Tasks waiting for this one. */
  readonly blocks: readonly TaskId[];
}

/**
 * Both directions, because the board needs both: "what blocks this task"
 * drives the blocked banner, "what does this task block" drives the warning
 * on a send-back.
 */
export async function dependenciesOf(
  taskId: TaskId,
  client?: PoolClient,
): Promise<DependencyEdges> {
  const sql = `select
      coalesce((select array_agg(blocked_by_task_id order by blocked_by_task_id)
                  from task_dependencies where task_id = $1), '{}') as blocked_by,
      coalesce((select array_agg(task_id order by task_id)
                  from task_dependencies where blocked_by_task_id = $1), '{}') as blocks`;
  const result = client
    ? await client.query<{ blocked_by: string[]; blocks: string[] }>(sql, [taskId])
    : await query<{ blocked_by: string[]; blocks: string[] }>(sql, [taskId]);
  const row = result.rows[0]!;
  return {
    blockedBy: row.blocked_by.map(asTaskId),
    blocks: row.blocks.map(asTaskId),
  };
}

/**
 * Every task reachable from `from` by following blocked-by edges — i.e.
 * everything it transitively waits for.
 *
 * One recursive CTE, not a walk in JavaScript issuing a query per level: a
 * 200-task chain would otherwise be 200 round trips, and the ticket asks
 * for claimability on a 200-task graph in under 100 ms.
 */
export async function transitiveBlockers(
  from: TaskId,
  client?: PoolClient,
): Promise<Set<string>> {
  const sql = `
    with recursive reachable(id) as (
      select blocked_by_task_id from task_dependencies where task_id = $1
      union
      select d.blocked_by_task_id
        from task_dependencies d
        join reachable r on d.task_id = r.id
    )
    select id from reachable`;
  const result = client
    ? await client.query<{ id: string }>(sql, [from])
    : await query<{ id: string }>(sql, [from]);
  return new Set(result.rows.map((row) => row.id));
}

/** True when `earlier` must finish before `later` — directly or through any
 * chain. This is what makes a scope overlap safe: two tasks ordered by a
 * dependency can never be active at the same time. */
export async function isOrderedBefore(
  earlier: TaskId,
  later: TaskId,
  client?: PoolClient,
): Promise<boolean> {
  const blockers = await transitiveBlockers(later, client);
  return blockers.has(earlier);
}

// --- Claimability --------------------------------------------------------------

export interface Claimability {
  readonly claimable: boolean;
  /** The dependencies not yet at `delivered`. Returned rather than just a
   * boolean because the refusal has to say *what* to wait for. */
  readonly blockedBy: readonly TaskId[];
}

/**
 * Whether every dependency has reached the unblocking state.
 *
 * Only direct dependencies are checked, and that is not a shortcut: a
 * transitive blocker that has not delivered necessarily leaves the direct
 * blocker undelivered too, so the direct check already covers the chain.
 */
export async function isClaimable(taskId: TaskId, client?: PoolClient): Promise<Claimability> {
  const sql = `select d.blocked_by_task_id as id
                 from task_dependencies d
                 join tasks t on t.id = d.blocked_by_task_id
                where d.task_id = $1
                  and t.state <> all($2::text[])
                order by d.blocked_by_task_id`;
  const params = [taskId, SATISFIED_STATES];
  const result = client
    ? await client.query<{ id: string }>(sql, params)
    : await query<{ id: string }>(sql, params);
  const blockedBy = result.rows.map((row) => asTaskId(row.id));
  return { claimable: blockedBy.length === 0, blockedBy };
}

/** Claimability for many tasks in one query — the board asks for every card
 * at once, and N cards must not mean N round trips. */
export async function claimabilityOf(
  taskIds: readonly TaskId[],
  client?: PoolClient,
): Promise<Map<string, Claimability>> {
  const answers = new Map<string, Claimability>();
  if (taskIds.length === 0) return answers;
  for (const id of taskIds) answers.set(id, { claimable: true, blockedBy: [] });

  const sql = `select d.task_id, d.blocked_by_task_id
                 from task_dependencies d
                 join tasks t on t.id = d.blocked_by_task_id
                where d.task_id = any($1::uuid[])
                  and t.state <> all($2::text[])
                order by d.task_id, d.blocked_by_task_id`;
  const params = [taskIds, SATISFIED_STATES];
  const result = client
    ? await client.query<{ task_id: string; blocked_by_task_id: string }>(sql, params)
    : await query<{ task_id: string; blocked_by_task_id: string }>(sql, params);

  for (const row of result.rows) {
    const current = answers.get(row.task_id) ?? { claimable: true, blockedBy: [] };
    answers.set(row.task_id, {
      claimable: false,
      blockedBy: [...current.blockedBy, asTaskId(row.blocked_by_task_id)],
    });
  }
  return answers;
}

// --- Mutating the graph ----------------------------------------------------------

interface TaskProjectRow {
  readonly id: string;
  readonly project_id: string;
  readonly state: string;
}

async function loadTasks(
  ids: readonly string[],
  db: PoolClient,
): Promise<Map<string, TaskProjectRow>> {
  const result = await db.query<TaskProjectRow>(
    "select id, project_id, state from tasks where id = any($1::uuid[])",
    [ids],
  );
  return new Map(result.rows.map((row) => [row.id, row]));
}

/**
 * Adds one edge, refusing self-dependency, a cross-project edge, and any
 * cycle.
 *
 * The cycle check is "can I already reach `taskId` from `blockedByTaskId`?"
 * — if so, the new edge closes a loop. That covers the indirect case
 * A→B→C→A as naturally as the direct one, because reachability is
 * transitive by construction.
 */
export async function addDependency(
  taskId: TaskId,
  blockedByTaskId: TaskId,
  client?: PoolClient,
): Promise<void> {
  const run = async (db: PoolClient): Promise<void> => {
    if (taskId === blockedByTaskId) {
      throw new DependencyError("a task cannot depend on itself", { taskId });
    }

    const tasks = await loadTasks([taskId, blockedByTaskId], db);
    const dependent = tasks.get(taskId);
    const blocker = tasks.get(blockedByTaskId);
    if (!dependent) throw new DependencyError("task not found", { taskId });
    if (!blocker) throw new DependencyError("blocking task not found", { blockedByTaskId });
    if (dependent.project_id !== blocker.project_id) {
      // Projects are separate repositories with separate boards; an edge
      // across them would order work nothing can coordinate.
      throw new DependencyError("a dependency may not cross projects", {
        taskId,
        blockedByTaskId,
        taskProject: dependent.project_id,
        blockerProject: blocker.project_id,
      });
    }

    // If the blocker already waits (directly or transitively) for the
    // dependent, this edge closes a cycle.
    const reachableFromBlocker = await transitiveBlockers(blockedByTaskId, db);
    if (reachableFromBlocker.has(taskId)) {
      throw new DependencyCycleError([taskId, blockedByTaskId, taskId]);
    }

    await db.query(
      `insert into task_dependencies (task_id, blocked_by_task_id)
       values ($1, $2)
       on conflict (task_id, blocked_by_task_id) do nothing`,
      [taskId, blockedByTaskId],
    );
  };
  return client ? run(client) : withTransaction(run);
}

export async function removeDependency(
  taskId: TaskId,
  blockedByTaskId: TaskId,
  client?: PoolClient,
): Promise<number> {
  const sql = `delete from task_dependencies
                where task_id = $1 and blocked_by_task_id = $2`;
  const result = client
    ? await client.query(sql, [taskId, blockedByTaskId])
    : await query(sql, [taskId, blockedByTaskId]);
  return result.rowCount ?? 0;
}

// --- Unblocking on delivery --------------------------------------------------------

export interface UnblockedTask {
  readonly taskId: TaskId;
  readonly owner: string;
  readonly department: string;
}

/**
 * Called when a task reaches `delivered`: finds every dependent whose
 * dependencies are now *all* satisfied and announces them.
 *
 * Idempotent by construction. It reports the dependents that are currently
 * unblocked rather than remembering which it has announced before, and
 * emits at most one event per call — with none at all when nothing changed.
 * Delivering an already-delivered task therefore produces one notification,
 * not two, because the second call finds the same set and the event
 * carries the same contents. Nothing here mutates the dependents, so
 * running it twice cannot double-apply anything.
 *
 * OPEN, and named in the ticket: the notification target is "their owners'
 * leads", but no transport exists until step 6. This emits the event;
 * nothing delivers it yet.
 */
export async function unblockDependents(
  deliveredTaskId: TaskId,
  client?: PoolClient,
): Promise<readonly UnblockedTask[]> {
  const sql = `
    select t.id, t.owner, t.department, t.project_id
      from task_dependencies d
      join tasks t on t.id = d.task_id
     where d.blocked_by_task_id = $1
       and not exists (
         select 1
           from task_dependencies d2
           join tasks b on b.id = d2.blocked_by_task_id
          where d2.task_id = t.id
            and b.state <> all($2::text[])
       )
     order by t.id`;
  const params = [deliveredTaskId, SATISFIED_STATES];
  type UnblockedRow = { id: string; owner: string; department: string; project_id: string };
  const result = client
    ? await client.query<UnblockedRow>(sql, params)
    : await query<UnblockedRow>(sql, params);

  const unblocked: UnblockedTask[] = result.rows.map((row) => ({
    taskId: asTaskId(row.id),
    owner: row.owner,
    department: row.department,
  }));

  if (unblocked.length > 0) {
    await recordSystemEvent(
      "TasksUnblocked",
      {
        delivered_task_id: deliveredTaskId,
        unblocked: unblocked.map((task) => ({
          task_id: task.taskId,
          owner: task.owner,
          department: task.department,
        })),
      },
      null,
      // Every dependent of one task is in that task's project - a
      // dependency may not cross projects - so one project id covers the
      // whole batch.
      result.rows[0]!.project_id,
    );
  }

  return unblocked;
}

/**
 * Re-evaluates what a task was blocking, for the delete path.
 *
 * The edges themselves go with `on delete cascade`; what does not happen
 * automatically is noticing that a dependent is now free. Call this
 * *before* deleting, so the dependents are still reachable through the
 * edges about to disappear.
 */
export async function dependentsOf(
  taskId: TaskId,
  client?: PoolClient,
): Promise<readonly TaskId[]> {
  const sql = `select task_id from task_dependencies where blocked_by_task_id = $1 order by task_id`;
  const result = client
    ? await client.query<{ task_id: string }>(sql, [taskId])
    : await query<{ task_id: string }>(sql, [taskId]);
  return result.rows.map((row) => asTaskId(row.task_id));
}

/**
 * Deletes a task and announces every dependent that its disappearance
 * frees. A blocker that no longer exists cannot block anything, so its
 * dependents may become claimable without any task having been delivered.
 */
export async function deleteTaskAndReevaluate(
  taskId: TaskId,
  client?: PoolClient,
): Promise<readonly UnblockedTask[]> {
  const run = async (db: PoolClient): Promise<readonly TaskId[]> => {
    const affected = await dependentsOf(taskId, db);
    await db.query("delete from tasks where id = $1", [taskId]);
    return affected;
  };
  const affected = client ? await run(client) : await withTransaction(run);
  if (affected.length === 0) return [];

  const freed: UnblockedTask[] = [];
  let projectId: string | null = null;
  for (const dependent of affected) {
    const status = await isClaimable(dependent, client);
    if (!status.claimable) continue;
    const sql = "select owner, department, project_id from tasks where id = $1";
    type OwnerRow = { owner: string; department: string; project_id: string };
    const row = client
      ? await client.query<OwnerRow>(sql, [dependent])
      : await query<OwnerRow>(sql, [dependent]);
    const task = row.rows[0];
    if (task) {
      projectId ??= task.project_id;
      freed.push({ taskId: dependent, owner: task.owner, department: task.department });
    }
  }

  if (freed.length > 0) {
    await recordSystemEvent(
      "TasksUnblocked",
      {
        deleted_task_id: taskId,
        unblocked: freed.map((task) => ({
          task_id: task.taskId,
          owner: task.owner,
          department: task.department,
        })),
      },
      null,
      projectId,
    );
  }
  return freed;
}

/** Every task in a project, with its edges — the input scope-ordering needs
 * to reason about the whole board at once. */
export async function projectDependencyEdges(
  projectId: ProjectId,
  client?: PoolClient,
): Promise<ReadonlyArray<{ taskId: TaskId; blockedByTaskId: TaskId }>> {
  const sql = `select d.task_id, d.blocked_by_task_id
                 from task_dependencies d
                 join tasks t on t.id = d.task_id
                where t.project_id = $1`;
  const result = client
    ? await client.query<{ task_id: string; blocked_by_task_id: string }>(sql, [projectId])
    : await query<{ task_id: string; blocked_by_task_id: string }>(sql, [projectId]);
  return result.rows.map((row) => ({
    taskId: asTaskId(row.task_id),
    blockedByTaskId: asTaskId(row.blocked_by_task_id),
  }));
}
