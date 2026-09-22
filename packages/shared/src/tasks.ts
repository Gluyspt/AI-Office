// Task vocabulary: the state union, the department union, and the record
// shapes both the server and the web app read. Everything that enumerates
// task states enumerates them *here* — the SQL check constraint in
// db/migrations/0005_tasks.sql is the only other copy, and a test in
// packages/server/src/tasks/states.test.ts asserts the two agree.
//
// This module has no barrel re-export, matching packages/shared/src/ids.ts
// and events.ts (see packages/shared's package.json `exports` map): import
// it as `@office/shared/tasks`.
//
// Naming: the design writes the states with spaces ("in progress", "ready
// for QA"). Code and SQL use snake_case identifiers for the same ten states
// and keep the design's wording as display text in TASK_STATE_LABELS — one
// spelling per layer, no third vocabulary. See the note on `lead_approval`
// below for the one place the design itself uses two words for one state.

import type { ProjectId, TaskId } from "./ids.ts";

// --- States ------------------------------------------------------------------

/**
 * The ten states of the lifecycle diagram in
 * docs/ai-agent-office-design.md, "Task lifecycle / States", in lifecycle
 * order. This tuple is the single source of the set; `TaskState` is derived
 * from it so the two can never drift.
 */
export const TASK_STATES = [
  "draft",
  "pending",
  "in_progress",
  "paused",
  "ready_for_qa",
  "ci",
  "qa_review",
  "lead_approval",
  "delivered",
  "done",
] as const;

export type TaskState = (typeof TASK_STATES)[number];

/**
 * The design's own words for each state, for UI display.
 *
 * `lead_approval` is the one entry where the design uses two labels for one
 * thing: the lifecycle diagram writes "lead approval", the Tasks-page table
 * writes "awaiting lead" as the pipeline chip. Ticket 012's open question
 * assumed they are the same state under two labels, took the diagram's
 * wording as the state name and the UI table's wording as the chip text.
 * UNCONFIRMED - if they turn out to be two states, this is where the
 * assumption is written down.
 */
export const TASK_STATE_LABELS: Readonly<Record<TaskState, string>> = {
  draft: "draft",
  pending: "pending",
  in_progress: "in progress",
  paused: "paused",
  ready_for_qa: "ready for QA",
  ci: "CI",
  qa_review: "QA review",
  lead_approval: "awaiting lead",
  delivered: "delivered",
  done: "done",
};

const TASK_STATE_SET: ReadonlySet<string> = new Set(TASK_STATES);

export function isTaskState(value: unknown): value is TaskState {
  return typeof value === "string" && TASK_STATE_SET.has(value);
}

/** Narrows a value read back out of the database, throwing rather than
 * letting an unknown state leak into typed code as a lie. */
export function asTaskState(value: unknown): TaskState {
  if (!isTaskState(value)) {
    throw new TypeError(`not a task state: ${JSON.stringify(value)}`);
  }
  return value;
}

// --- Board columns -------------------------------------------------------------
//
// The Tasks page has four columns - Draft, To do, In progress, Done - with
// the pipeline states shown as chips inside In progress (design, "Web app
// pages"). The mapping lives here rather than in the board code because
// this is the module that enumerates states; tickets 013 and 023 should
// read it rather than re-listing them.

export const TASK_BOARD_COLUMNS = ["draft", "todo", "in_progress", "done"] as const;

export type TaskBoardColumn = (typeof TASK_BOARD_COLUMNS)[number];

/**
 * OPEN QUESTION (the design's, not settled here): the design names four
 * columns and six In-progress chips (in progress, paused, ready for QA, CI,
 * QA review, awaiting lead) - `delivered` appears in neither list. It is
 * placed in the In progress column below on the reading that Done means
 * *accepted* ("`main` - accepted, released state", and the Done column's
 * 7-day window is a window of finished work), so a delivered task still
 * awaiting a human's Accept / Send back is still in flight. Change this one
 * line if the delivery report is meant to move the card to Done instead.
 */
export const TASK_BOARD_COLUMN_OF: Readonly<Record<TaskState, TaskBoardColumn>> = {
  draft: "draft",
  pending: "todo",
  in_progress: "in_progress",
  paused: "in_progress",
  ready_for_qa: "in_progress",
  ci: "in_progress",
  qa_review: "in_progress",
  lead_approval: "in_progress",
  delivered: "in_progress",
  done: "done",
};

// --- Departments ---------------------------------------------------------------

/**
 * Departments a *task* can belong to.
 *
 * Management is deliberately absent. The design's org chart has Management
 * above the three departments, and the decision recorded in
 * docs/tasks/README.md ("Role slots are first-class - leads never have
 * tasks") means Management's work is planning, not task rows. If a
 * Management-owned task ever becomes real, adding it is one entry here plus
 * a one-line migration to widen the check constraint.
 */
export const TASK_DEPARTMENTS = ["dev", "research", "qa"] as const;

export type TaskDepartment = (typeof TASK_DEPARTMENTS)[number];

const TASK_DEPARTMENT_SET: ReadonlySet<string> = new Set(TASK_DEPARTMENTS);

export function isTaskDepartment(value: unknown): value is TaskDepartment {
  return typeof value === "string" && TASK_DEPARTMENT_SET.has(value);
}

// --- Actors --------------------------------------------------------------------

/**
 * Who performed a transition. Three kinds, because the design's causes of a
 * state change genuinely are three kinds: a human clicking Start working or
 * Send back, an agent calling `claim_task` / `complete_task`, and the
 * orchestrator itself moving a task to `paused` on a crash, a circuit
 * breaker trip or a rate limit.
 *
 * `actor` alongside it is an opaque identifier, not a foreign key: there is
 * no user table (there is no authentication at all until step 9 - see
 * docs/tasks/README.md, "What steps 1-3 deliberately leave inert"). This
 * ticket records *who claims to have acted*; it does not decide **who is
 * allowed to** - permissions are step 9's, and nothing here should be read
 * as an authorisation model.
 */
export const TASK_ACTOR_KINDS = ["human", "agent", "system"] as const;

export type TaskActorKind = (typeof TASK_ACTOR_KINDS)[number];

const TASK_ACTOR_KIND_SET: ReadonlySet<string> = new Set(TASK_ACTOR_KINDS);

export function isTaskActorKind(value: unknown): value is TaskActorKind {
  return typeof value === "string" && TASK_ACTOR_KIND_SET.has(value);
}

// --- Records ---------------------------------------------------------------------

/**
 * One row of `tasks`, camelCased.
 *
 * `state` is `readonly` here and there is no exported mutator anywhere: the
 * only way it changes is packages/server/src/tasks/states.ts's
 * `transition()`, which a database trigger enforces rather than merely
 * documents (see 0005_tasks.sql).
 */
export interface TaskRecord {
  readonly id: TaskId;
  readonly projectId: ProjectId;
  readonly title: string;
  /** Never null - an unwritten brief is the empty string, so every reader
   * has something to render. Same reasoning as tokenCost/turnCount. */
  readonly brief: string;
  readonly department: TaskDepartment;
  /** Opaque agent-account identifier. See ticket 012's open question: the
   * design keeps office membership and agent accounts explicitly separate,
   * and `claim_task` checks owner against the session's user, so this is
   * the agent account. The membership link is step 9. */
  readonly owner: string;
  readonly state: TaskState;
  /** null means "use the role default from the project's model_policy" -
   * the design's layer 1. A non-null value is a lead's or a human's
   * explicit per-task choice (layer 2 / 3), which is why it travels with
   * `modelReason`. Deliberately an open string, not a union: "any backend
   * can serve any role", so `sonnet`, `opus` and `qwen-uni` are all valid. */
  readonly model: string | null;
  /** The one-line reason that accompanies an explicit model choice. Null
   * whenever `model` is null. */
  readonly modelReason: string | null;
  /** `task/<id>-<slug>`, once the task branch exists. Null until then -
   * branch creation is step 4's, not step 2's. */
  readonly branch: string | null;
  /** Never null, defaults to 0, so a card always has a number to render.
   * No source feeds it yet - step 7 (design: token cost renders as "not
   * measured yet" until then). */
  readonly tokenCost: number;
  /** Never null, defaults to 0. Same reasoning as tokenCost. */
  readonly turnCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /**
   * When the task entered its current state. Set by the database on every
   * state change and by nothing else, so the card's "paused / 2d" is one
   * subtraction against this column - no history walk, per the decision in
   * docs/tasks/README.md ("Cards show time in the current state ... from
   * the last transition alone"). Distinct from `updatedAt`, which also
   * moves when a title or an owner is edited.
   */
  readonly stateEnteredAt: Date;
}

/** One row of `task_state_history`: who moved the task, from where to
 * where, why, and when. Written in the same transaction as the state
 * change it describes (enforced by a deferred constraint trigger). */
export interface TaskStateChange {
  readonly id: string;
  readonly taskId: TaskId;
  readonly fromState: TaskState;
  readonly toState: TaskState;
  readonly actor: string;
  readonly actorKind: TaskActorKind;
  readonly reason: string | null;
  readonly occurredAt: Date;
}
