// Task persistence and the board read model.
//
// Two jobs, deliberately in one file because they share a row mapper:
//
//   - CRUD that is *not* state. Writing `state` is transition()'s alone
//     (0005_tasks.sql enforces it with a trigger), so `updateTaskFields`
//     rejects the column outright rather than letting a PATCH body reach a
//     database error whose message names a trigger.
//   - `board()`, which answers "the whole Tasks page, filtered" in ONE
//     round trip. The design's four columns, the pipeline chip, the 7-day
//     Done window and the count of everything older all come back from a
//     single statement — ticket 023 re-renders this on every WebSocket
//     event, so a board that costs five queries costs five per event.
//
// Column and state vocabulary is never re-listed here: TASK_BOARD_COLUMN_OF
// in @office/shared/tasks is the only mapping, and a test asserts it covers
// every state in TASK_STATES. A new state added there without a column
// therefore fails a test rather than silently vanishing off the board.
import type { PoolClient } from "pg";
import {
  TASK_BOARD_COLUMNS,
  TASK_BOARD_COLUMN_OF,
  TASK_DEPARTMENTS,
  isTaskDepartment,
  isTaskState,
  type TaskBoardColumn,
  type TaskDepartment,
  type TaskRecord,
  type TaskState,
  type TaskStateChange,
} from "@office/shared/tasks";
import type { ProjectId, TaskId } from "@office/shared/ids";
import { query } from "../../core/db/pool.ts";
import { recordSystemEvent } from "../events/ingest.ts";
import { TASK_COLUMNS, taskRowToRecord, taskStateHistory, type TaskRow } from "./states.ts";
import type { NewTask } from "./model.ts";

/** Days of finished work the Done column shows. A constant, not config:
 * the ticket's open question asked whether this should be per-project and
 * the answer was "not until a week proves wrong". Lifting it into config is
 * a one-line change here plus a loadTasksConfig() section. */
export const DONE_WINDOW_DAYS = 7;

/** Fields a PATCH may write. `state` is absent by construction — see
 * updateTaskFields. So are id, projectId, createdAt and the counters,
 * which nothing outside this module sets. */
export interface TaskFieldPatch {
  readonly title?: string;
  readonly brief?: string;
  readonly department?: TaskDepartment;
  readonly owner?: string;
  readonly model?: string | null;
  readonly modelReason?: string | null;
  readonly branch?: string | null;
}

export class TaskFieldError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid task update:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "TaskFieldError";
  }
}

/** Raised when a caller tries to write `state` through the field API. Its
 * own class so a route can answer 400 with the transition endpoint named,
 * rather than surfacing SQLSTATE OF001 from the trigger. */
export class StateNotPatchableError extends TaskFieldError {
  constructor() {
    super([
      "state cannot be set directly — move the task with the transition endpoint " +
        "(POST /tasks/:id/transition, ticket 017) so the change is checked against " +
        "the lifecycle and written to task_state_history",
    ]);
    this.name = "StateNotPatchableError";
  }
}

// --- Create -------------------------------------------------------------------

/**
 * Inserts a validated task and announces it.
 *
 * The event is what lets ticket 023's board update without polling. It goes
 * through recordSystemEvent (ticket 005's own seam for events this process
 * constructs) so it is stored, published on the bus and dispatched to
 * handlers exactly like a hook-sourced one.
 *
 * KNOWN GAP, flagged rather than worked around: `events.project_id` is set
 * by nothing — ingest.ts's persist() does not take one, and that file
 * belongs to ticket 005. So this event carries its project in the *payload*
 * and arrives with a null `projectId` column, which means a bus subscriber
 * filtering by project will not see it. Ticket 023 needs either a
 * project-aware persist or a payload-level filter; noted in this ticket's
 * open questions.
 */
export async function insertTask(task: NewTask, client?: PoolClient): Promise<TaskRecord> {
  const sql = `insert into tasks
      (id, project_id, title, brief, department, owner, model, model_reason, branch,
       token_cost, turn_count)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     returning ${TASK_COLUMNS}`;
  const params = [
    task.id,
    task.projectId,
    task.title,
    task.brief,
    task.department,
    task.owner,
    task.model,
    task.modelReason,
    task.branch,
    task.tokenCost,
    task.turnCount,
  ];
  const result = client
    ? await client.query<TaskRow>(sql, params)
    : await query<TaskRow>(sql, params);
  const row = result.rows[0];
  if (!row) throw new Error("insert into tasks returned no row");
  const record = taskRowToRecord(row);

  // After the insert, never before: an event announcing a task that failed
  // to store is worse than a late one.
  await recordSystemEvent("TaskCreated", {
    task_id: record.id,
    project_id: record.projectId,
    title: record.title,
    department: record.department,
    owner: record.owner,
    state: record.state,
  });

  return record;
}

// --- Read ---------------------------------------------------------------------

export async function getTask(id: TaskId, client?: PoolClient): Promise<TaskRecord | null> {
  const sql = `select ${TASK_COLUMNS} from tasks where id = $1`;
  const result = client
    ? await client.query<TaskRow>(sql, [id])
    : await query<TaskRow>(sql, [id]);
  const row = result.rows[0];
  return row ? taskRowToRecord(row) : null;
}

export interface TaskWithHistory {
  readonly task: TaskRecord;
  /** Oldest first. The detail page (031) computes total age and accumulated
   * working time from this, which is why GET /tasks/:id returns it inline
   * rather than making the page fetch it separately. */
  readonly history: readonly TaskStateChange[];
}

export async function getTaskWithHistory(id: TaskId): Promise<TaskWithHistory | null> {
  const task = await getTask(id);
  if (!task) return null;
  return { task, history: await taskStateHistory(id) };
}

// --- Update -------------------------------------------------------------------

const PATCHABLE = ["title", "brief", "department", "owner", "model", "modelReason", "branch"] as const;

const COLUMN_OF: Readonly<Record<(typeof PATCHABLE)[number], string>> = {
  title: "title",
  brief: "brief",
  department: "department",
  owner: "owner",
  model: "model",
  modelReason: "model_reason",
  branch: "branch",
};

/**
 * Writes the non-state fields of a task.
 *
 * Rejects `state` before touching the database. The trigger would catch it
 * anyway (SQLSTATE OF001), but a caller deserves to be told which endpoint
 * to use instead, and a 500 carrying a trigger's hint is not that.
 */
export async function updateTaskFields(
  id: TaskId,
  patch: Record<string, unknown>,
  client?: PoolClient,
): Promise<TaskRecord | null> {
  if ("state" in patch) throw new StateNotPatchableError();

  const problems: string[] = [];
  const sets: string[] = [];
  const params: unknown[] = [];

  for (const field of PATCHABLE) {
    if (!(field in patch)) continue;
    const value = patch[field];

    if (field === "department") {
      if (!isTaskDepartment(value)) {
        problems.push(
          `department must be one of ${TASK_DEPARTMENTS.join(", ")} (got ${JSON.stringify(value)})`,
        );
        continue;
      }
    } else if (field === "title" || field === "owner") {
      if (typeof value !== "string" || value.trim() === "") {
        problems.push(`${field} must be a non-empty string`);
        continue;
      }
    } else if (field === "brief") {
      if (typeof value !== "string") {
        problems.push("brief must be a string");
        continue;
      }
    } else if (value !== null && typeof value !== "string") {
      problems.push(`${field} must be a string or null`);
      continue;
    }

    params.push(typeof value === "string" ? value.trim() : value);
    sets.push(`${COLUMN_OF[field]} = $${params.length}`);
  }

  const unknownKeys = Object.keys(patch).filter(
    (key) => !(PATCHABLE as readonly string[]).includes(key),
  );
  if (unknownKeys.length > 0) {
    problems.push(`unknown field(s): ${unknownKeys.join(", ")}`);
  }
  if (sets.length === 0 && problems.length === 0) {
    problems.push("no fields to update");
  }
  if (problems.length > 0) throw new TaskFieldError(problems);

  params.push(id);
  const sql = `update tasks set ${sets.join(", ")} where id = $${params.length}
               returning ${TASK_COLUMNS}`;
  const result = client
    ? await client.query<TaskRow>(sql, params)
    : await query<TaskRow>(sql, params);
  const row = result.rows[0];
  return row ? taskRowToRecord(row) : null;
}

// --- Filters shared by list and board -------------------------------------------

export interface TaskFilters {
  readonly projectId?: ProjectId | null;
  readonly owner?: string | null;
  readonly department?: TaskDepartment | null;
  /** Joined the filter set because the Done column's "+N earlier" applies
   * it — see the decision in docs/tasks/README.md. */
  readonly state?: TaskState | null;
}

function filterParams(filters: TaskFilters): unknown[] {
  return [
    filters.projectId ?? null,
    filters.owner ?? null,
    filters.department ?? null,
    filters.state ?? null,
  ];
}

/** $1..$4, matching filterParams. Every clause is null-guarded so one
 * prepared shape serves every combination — the filters "combine" without
 * the query being assembled differently per request. */
const FILTER_SQL = `($1::uuid is null or project_id = $1)
    and ($2::text is null or owner = $2)
    and ($3::text is null or department = $3)
    and ($4::text is null or state = $4)`;

// --- List (paged) ---------------------------------------------------------------

/**
 * Keyset pagination on `(created_at, id)`.
 *
 * Not OFFSET: a concurrent insert shifts every later page under an offset,
 * which the ticket asks to be verified against. Sorting ascending by
 * creation means a new row lands at the *end* of the sequence, so a cursor
 * taken from page 1 still yields exactly the untouched remainder.
 *
 * The cursor carries `created_at` as TEXT, not as a Date. Postgres stores
 * timestamptz to the microsecond and the pg driver hands it to JavaScript
 * as a Date, which holds only milliseconds — so a timestamp that must
 * *match* a stored value cannot make the round trip through a Date. This is
 * the third place in this codebase that bug has appeared (the event cursor
 * in 005, every task transition in 012); reading the column as text is the
 * same fix both took.
 */
export interface ListTasksParams extends TaskFilters {
  readonly limit: number;
  readonly cursor?: string | null;
}

export interface ListTasksPage {
  readonly tasks: readonly TaskRecord[];
  /** Opaque; pass back as `cursor`. Null when the page is the last one. */
  readonly nextCursor: string | null;
}

interface CursorRow extends TaskRow {
  readonly created_at_text: string;
}

function encodeCursor(createdAtText: string, id: string): string {
  return Buffer.from(`${createdAtText}|${id}`, "utf8").toString("base64url");
}

function decodeCursor(raw: string): { createdAt: string; id: string } | null {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const split = decoded.lastIndexOf("|");
  if (split <= 0) return null;
  return { createdAt: decoded.slice(0, split), id: decoded.slice(split + 1) };
}

export async function listTasks(params: ListTasksParams): Promise<ListTasksPage> {
  const values = filterParams(params);
  let cursorClause = "";
  if (params.cursor) {
    const cursor = decodeCursor(params.cursor);
    if (!cursor) throw new TaskFieldError([`cursor is not valid: ${JSON.stringify(params.cursor)}`]);
    values.push(cursor.createdAt, cursor.id);
    // Row-value comparison, so ties on created_at break by id and the pair
    // is a total order.
    cursorClause = `and (created_at, id) > ($${values.length - 1}::timestamptz, $${values.length}::uuid)`;
  }
  values.push(params.limit);

  const result = await query<CursorRow>(
    `select ${TASK_COLUMNS}, created_at::text as created_at_text
       from tasks
      where ${FILTER_SQL} ${cursorClause}
      order by created_at asc, id asc
      limit $${values.length}`,
    values,
  );

  const tasks = result.rows.map(taskRowToRecord);
  const last = result.rows[result.rows.length - 1];
  const nextCursor =
    last && result.rows.length === params.limit ? encodeCursor(last.created_at_text, last.id) : null;
  return { tasks, nextCursor };
}

// --- Board ------------------------------------------------------------------------

/** A task as the board renders it: the record, plus which column it belongs
 * in and the pipeline chip to show inside it. The chip is simply the state
 * — six of the ten share the In progress column, and the chip is what tells
 * them apart on the card. */
export interface BoardCard {
  readonly task: TaskRecord;
  readonly column: TaskBoardColumn;
  readonly chip: TaskState;
}

export interface BoardColumnResult {
  readonly column: TaskBoardColumn;
  readonly cards: readonly BoardCard[];
  /**
   * Completed tasks outside the window. Non-zero only for `done`; the
   * Tasks page renders it as "+N earlier", which applies a state filter on
   * the existing filter bar rather than opening another view.
   */
  readonly earlierCount: number;
}

export interface BoardResult {
  /** Always four, in TASK_BOARD_COLUMNS order, even when empty — a column
   * that disappears when it has no cards makes the page jump. */
  readonly columns: readonly BoardColumnResult[];
  readonly doneWindowDays: number;
}

interface BoardRow extends TaskRow {
  readonly done_earlier_count: number;
}

/**
 * The whole board in one statement.
 *
 * `filtered` applies the caller's filters once; `visible` drops Done rows
 * older than the window; `earlier` counts exactly those dropped rows. The
 * count rides along on every row rather than being a second query, which is
 * what keeps this to a single round trip — asserted by a test that counts
 * query calls with 200 tasks present.
 */
export async function board(
  filters: TaskFilters,
  client?: PoolClient,
): Promise<BoardResult> {
  const values = [...filterParams(filters), DONE_WINDOW_DAYS];
  const sql = `
    with filtered as (
      select ${TASK_COLUMNS} from tasks where ${FILTER_SQL}
    ),
    visible as (
      select * from filtered
       where state <> 'done'
          or state_entered_at >= now() - ($5::int * interval '1 day')
    ),
    earlier as (
      select count(*)::int as n from filtered
       where state = 'done'
         and state_entered_at < now() - ($5::int * interval '1 day')
    )
    select v.*, (select n from earlier) as done_earlier_count
      from visible v
     order by v.created_at asc, v.id asc`;

  const result = client
    ? await client.query<BoardRow>(sql, values)
    : await query<BoardRow>(sql, values);

  const earlierCount = result.rows[0]?.done_earlier_count ?? 0;
  const byColumn = new Map<TaskBoardColumn, BoardCard[]>();
  for (const column of TASK_BOARD_COLUMNS) byColumn.set(column, []);

  for (const row of result.rows) {
    const task = taskRowToRecord(row);
    // Not a lookup that can miss: TASK_BOARD_COLUMN_OF is typed over every
    // TaskState, and taskRowToRecord has already refused an unknown one.
    const column = TASK_BOARD_COLUMN_OF[task.state];
    byColumn.get(column)?.push({ task, column, chip: task.state });
  }

  // Done reads newest-first ("a 7-day window under day headers"); the other
  // three keep creation order, which is the order work was planned in.
  // Sorted here rather than in SQL so the statement above stays one query
  // with one ORDER BY.
  const done = byColumn.get("done");
  if (done) {
    done.sort((a, b) => b.task.stateEnteredAt.getTime() - a.task.stateEnteredAt.getTime());
  }

  return {
    columns: TASK_BOARD_COLUMNS.map((column) => ({
      column,
      cards: byColumn.get(column) ?? [],
      earlierCount: column === "done" ? earlierCount : 0,
    })),
    doneWindowDays: DONE_WINDOW_DAYS,
  };
}

/** Parses a `state` query parameter, rejecting anything outside the union
 * rather than silently returning an empty board for a typo. */
export function parseStateFilter(raw: unknown): TaskState | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (!isTaskState(raw)) {
    throw new TaskFieldError([`state must be a task state (got ${JSON.stringify(raw)})`]);
  }
  return raw;
}

export function parseDepartmentFilter(raw: unknown): TaskDepartment | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (!isTaskDepartment(raw)) {
    throw new TaskFieldError([
      `department must be one of ${TASK_DEPARTMENTS.join(", ")} (got ${JSON.stringify(raw)})`,
    ]);
  }
  return raw;
}
