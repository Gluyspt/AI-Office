// Constructing and validating a task, with no database in sight.
//
// Two reasons this is a module of its own rather than a set of SQL
// constraints or a few checks inside ticket 013's repo:
//
//   - A task is drafted before it is stored. Management's planning flow
//     (ticket 019) produces a whole batch that a human edits in the Draft
//     column before anything is promoted; a shape that can only be
//     validated by attempting an INSERT is a shape that cannot be checked
//     while it is still a proposal.
//   - Error messages. A check constraint says "violates
//     tasks_department_check"; a person editing a draft batch needs "owner
//     is required" and "model_reason was given without a model", all of
//     them at once rather than one per round trip. Same reasoning, and the
//     same ConfigError-style "report every problem together" shape, as
//     config.ts.
//
// The SQL constraints in db/migrations/0005_tasks.sql are still there, and
// deliberately so: they are the backstop for anything that reaches the
// database by another route. This module is the one that can explain
// itself.
import {
  TASK_DEPARTMENTS,
  isTaskDepartment,
  type TaskDepartment,
} from "@office/shared/tasks";
import { newTaskId, type ProjectId, type TaskId } from "@office/shared/ids";

/** Collects every problem with one proposed task, the way ConfigError does
 * for the environment: a person fixing a draft should see the whole list,
 * not the first item ten times. */
export class TaskValidationError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid task:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    this.name = "TaskValidationError";
  }
}

/**
 * Length caps. NOT from the design, which names none - picked here so a
 * pasted transcript cannot become a task title, and flagged as this
 * ticket's own choice rather than a requirement. The columns are `text`,
 * so raising either is a code change with no migration.
 */
export const TASK_TITLE_MAX_LENGTH = 200;
export const TASK_MODEL_REASON_MAX_LENGTH = 500;

/**
 * The design fixes the task branch name: `task/<id>-<slug>`, one per task,
 * branched from `main-dev`. Validated only for shape, and only when a
 * branch is present at all - nothing in steps 1-3 creates one (complete_task
 * does not push or open a PR until step 4).
 */
const TASK_BRANCH_RE = /^task\/[A-Za-z0-9][A-Za-z0-9._\-/]*$/;

/** What a caller may propose. Note what is *not* here: `state`. A task is
 * born in `draft` and moved by transition(); the caller does not get a
 * vote, and the insert trigger in 0005_tasks.sql enforces that even against
 * a hand-written INSERT. */
export interface NewTaskInput {
  readonly projectId: ProjectId;
  readonly title: string;
  /** Optional. Absent becomes "", never null - see NewTask.brief. */
  readonly brief?: string | null;
  readonly department: TaskDepartment | string;
  readonly owner: string;
  /** Optional: null or absent means "use the role default from the
   * project's model_policy". */
  readonly model?: string | null;
  /** The one-line reason the design asks for whenever a model is chosen
   * explicitly. Only meaningful alongside `model`. */
  readonly modelReason?: string | null;
  /** Normally absent - step 4 creates task branches. */
  readonly branch?: string | null;
}

/**
 * A validated, storage-ready task. Ticket 013's repo inserts these columns
 * verbatim.
 *
 * `state` is the literal type `"draft"`, not TaskState: there is no way to
 * construct this object in any other state, so no repo, route or MCP tool
 * can choose one. Together with the insert trigger, "a task starts in
 * draft" is structural in both layers.
 */
export interface NewTask {
  readonly id: TaskId;
  readonly projectId: ProjectId;
  readonly title: string;
  /** Never null. An unwritten brief is "", so every reader has something to
   * render without a null branch - the same reasoning as tokenCost. */
  readonly brief: string;
  readonly department: TaskDepartment;
  readonly owner: string;
  readonly state: "draft";
  readonly model: string | null;
  readonly modelReason: string | null;
  readonly branch: string | null;
  /** Zero, always, and never null: the step-3 card must always have a
   * number to render. Nothing feeds either until step 7. */
  readonly tokenCost: 0;
  readonly turnCount: 0;
}

function requireText(
  problems: string[],
  value: unknown,
  field: string,
  maxLength?: number,
): string {
  if (typeof value !== "string" || value.trim() === "") {
    problems.push(`${field} is required`);
    return "";
  }
  const trimmed = value.trim();
  if (maxLength !== undefined && trimmed.length > maxLength) {
    problems.push(`${field} must be at most ${maxLength} characters (got ${trimmed.length})`);
  }
  return trimmed;
}

function optionalText(
  problems: string[],
  value: unknown,
  field: string,
  maxLength?: number,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    problems.push(`${field} must be a string when given`);
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    // An empty optional is an absent optional. Storing "" alongside NULL
    // would give two spellings of "not set" and every reader two cases.
    return null;
  }
  if (maxLength !== undefined && trimmed.length > maxLength) {
    problems.push(`${field} must be at most ${maxLength} characters (got ${trimmed.length})`);
  }
  return trimmed;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates a proposed task and mints its id. Throws TaskValidationError
 * listing every problem at once; never returns a half-valid object.
 *
 * Deliberately not checked here, because this ticket does not own the
 * answer: dependencies (014), file scope (015), whether the owner exists or
 * may be assigned work (step 9's membership model - the design keeps office
 * membership and agent accounts explicitly separate, and this column holds
 * the agent account).
 */
export function createTask(input: NewTaskInput): NewTask {
  const problems: string[] = [];

  if (typeof input.projectId !== "string" || !UUID_RE.test(input.projectId)) {
    problems.push("projectId must be a uuid");
  }

  const title = requireText(problems, input.title, "title", TASK_TITLE_MAX_LENGTH);
  const owner = requireText(problems, input.owner, "owner");

  // Not requireText: "" is a legitimate brief (not written yet), unlike a
  // missing title or owner.
  const briefRaw = input.brief;
  let brief = "";
  if (briefRaw !== undefined && briefRaw !== null) {
    if (typeof briefRaw !== "string") {
      problems.push("brief must be a string when given");
    } else {
      brief = briefRaw.trim();
    }
  }

  if (!isTaskDepartment(input.department)) {
    problems.push(
      `department must be one of ${TASK_DEPARTMENTS.join(", ")} (got ${JSON.stringify(input.department)})`,
    );
  }

  const model = optionalText(problems, input.model, "model");
  const modelReason = optionalText(
    problems,
    input.modelReason,
    "modelReason",
    TASK_MODEL_REASON_MAX_LENGTH,
  );
  if (modelReason !== null && model === null) {
    // The design pairs the two: a lead's per-task choice "takes a model and
    // a one-line reason". A reason with nothing to explain is a sign the
    // model was dropped somewhere upstream, not a harmless extra.
    problems.push("modelReason was given without a model to explain");
  }

  const branch = optionalText(problems, input.branch, "branch");
  if (branch !== null && !TASK_BRANCH_RE.test(branch)) {
    problems.push(`branch must look like task/<id>-<slug> (got ${JSON.stringify(branch)})`);
  }

  if (problems.length > 0) {
    throw new TaskValidationError(problems);
  }

  return {
    id: newTaskId(),
    projectId: input.projectId,
    title,
    brief,
    department: input.department as TaskDepartment,
    owner,
    state: "draft",
    model,
    modelReason,
    branch,
    tokenCost: 0,
    turnCount: 0,
  };
}

/**
 * The same validation without minting an id or throwing - for a UI or a
 * planning flow that wants to show what is wrong with a draft while it is
 * still being edited. Returns the problems in the order createTask would
 * report them; an empty array means createTask will succeed.
 */
export function validateTask(input: NewTaskInput): string[] {
  try {
    createTask(input);
    return [];
  } catch (error) {
    if (error instanceof TaskValidationError) {
      return [...error.problems];
    }
    throw error;
  }
}
