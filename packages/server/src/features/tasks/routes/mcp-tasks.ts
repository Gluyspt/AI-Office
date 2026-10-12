// The `office_tasks` MCP server: `claim_task` and `complete_task`, as the
// agents see them.
//
// Ticket 017. Autoloaded from features/tasks/routes/ like any other endpoint,
// which is the whole reason this is a route file and not a package: spike 003
// §2 settled that the office's MCP servers are **routes on the orchestrator's
// existing https listener**, not processes. Under stdio the process count is
// servers × *agents*, and against a measured ~290 MB bare agent on a 3.2 GB
// box that spends the agent cap on overhead and multiplies Postgres
// connections for tools that are thin wrappers over a database this process
// already serves.
//
// **THE SERVER NAME IS LOAD-BEARING.** `office_tasks` must match three places
// or the office breaks in a way that looks like something else:
//
//   1. the key in each role file's `mcpServers:` block (agents/*.md),
//   2. the `mcp__office_tasks__*` rule in `config/hooks/base.settings.json`,
//   3. `MCP_SERVER_NAME` below.
//
// An allow rule's server segment must be glob-free and must name a server
// that is actually configured. A mismatch — `office-tasks` against
// `office_tasks`, say — allowlists nothing, so in `manual` mode every
// `claim_task` raises a PermissionRequest and parks the desk, while the
// settings file reads as if it should not. That was a real inconsistency
// between two sections of spike 003 and is why underscores are now written
// down in three files and asserted in a test.
//
// THE TOOL DESCRIPTIONS ARE PROMPT TEXT. They are the only documentation an
// agent has, they are what it reads when deciding whether to call, and under
// spike 003's measurement they cost tokens on every turn — so they are short,
// they say what the tool refuses as well as what it does, and they do not
// repeat the role file.
import type { FastifyInstance } from "fastify";
import { asTaskId } from "@office/shared/ids";
import { mountMcpServer, toolRefusal, toolText, type McpTool } from "../../mcp/protocol.ts";
import { claimTask } from "../claim.ts";
import { completeTask } from "../complete.ts";

export const MCP_SERVER_NAME = "office_tasks";
export const MCP_TASKS_PATH = "/mcp/tasks";

/** A uuid, or null. The tools take an id the model typed, so "that is not an
 * id" has to be its own answer — passing a malformed string to Postgres
 * raises a 22P02 the agent would see as an internal failure. */
function taskIdArg(args: Record<string, unknown>): string | null {
  const raw = args.task_id;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)
    ? trimmed
    : null;
}

function stringArg(args: Record<string, unknown>, name: string): string | null {
  const raw = args[name];
  return typeof raw === "string" ? raw : null;
}

/** `file_scope: ["a", "b"]`, tolerating a single string because a model that
 * has one path to declare will sooner or later send it unwrapped. */
function scopeArg(args: Record<string, unknown>): string[] | undefined {
  const raw = args.file_scope;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string") return [raw];
  if (!Array.isArray(raw)) return undefined;
  return raw.filter((entry): entry is string => typeof entry === "string");
}

const claimTaskTool: McpTool = {
  name: "claim_task",
  description:
    "Take a task that is pending and owned by this account, and lock the files it will edit. " +
    "Refuses, with the reason, if the task belongs to another account, if a dependency has not " +
    "been delivered, or if another active task already holds part of the file scope. A refusal " +
    "is information about the office, not an error to retry: read it and act on what it names.",
  inputSchema: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "The task's id, from the board." },
      file_scope: {
        type: "array",
        items: { type: "string" },
        description:
          "The paths or path prefixes this task will edit, e.g. " +
          '["packages/server/src/features/tasks/claim.ts", "db/migrations/"]. ' +
          "Declare wider than you need rather than narrower: over-declaring serialises work, " +
          "under-declaring produces the git conflict the ownership registry exists to prevent.",
      },
    },
    required: ["task_id"],
    additionalProperties: false,
  },
  async run(args, context) {
    const taskId = taskIdArg(args);
    if (taskId === null) {
      return toolRefusal(
        "claim_task needs `task_id` as the task's uuid, copied from the board or from your task list.",
      );
    }

    // NOTE WHAT IS NOT READ HERE: nothing in `args` identifies the caller.
    // `owner`, `session_id`, `as` — an agent can pass any of them and they
    // change nothing, because the owner check compares the task's owner with
    // `context.session.owner`, which came off the transport. That is the
    // property spike 003 existed to establish, and 017's criterion asserts it
    // against a forged argument.
    const result = await claimTask({
      taskId: asTaskId(taskId),
      session: context.session,
      ...(scopeArg(args) === undefined ? {} : { scope: scopeArg(args) }),
    });

    if (!result.ok) return toolRefusal(result.message);
    return toolText(
      `Claimed task ${result.task.id} ("${result.task.title}"). It is now in progress and you hold ${
        result.scope.length === 1 ? "this path" : "these paths"
      }: ${result.scope.join(", ")}. Nobody else can edit them while you hold them, and the ownership guard will refuse your own edits outside them. Call complete_task when the work is ready for QA.`,
    );
  },
};

const completeTaskTool: McpTool = {
  name: "complete_task",
  description:
    "Hand a task you claimed to QA: records what you did, records one thing the task taught, and " +
    "releases your file locks. Moves the task to ready-for-QA, never to done. Requires a " +
    "learning entry and refuses without one. Does NOT rebase, push, or open a PR in this build " +
    "step — the result says so explicitly, so do not report the work as delivered.",
  inputSchema: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "The task you claimed." },
      summary: {
        type: "string",
        description: "What you did, for the human reviewing it at the QA gate.",
      },
      learning: {
        type: "string",
        description:
          "One thing this task taught that the next one should not have to rediscover: a trap, " +
          "a constraint, a decision and why. Required.",
      },
    },
    required: ["task_id", "summary", "learning"],
    additionalProperties: false,
  },
  async run(args, context) {
    const taskId = taskIdArg(args);
    if (taskId === null) {
      return toolRefusal("complete_task needs `task_id` as the uuid of the task you claimed.");
    }

    const result = await completeTask({
      taskId: asTaskId(taskId),
      session: context.session,
      summary: stringArg(args, "summary"),
      learning: stringArg(args, "learning"),
    });

    if (!result.ok) return toolRefusal(result.message);
    return toolText(
      [
        `Task ${result.task.id} is ready for QA. Released ${result.locksReleased} file ${
          result.locksReleased === 1 ? "lock" : "locks"
        }, so any task waiting on that scope can now claim it.`,
        // Verbatim, every time. An agent that assumes a PR exists reports
        // work as delivered that is sitting in a local branch.
        result.delivery.message,
      ].join("\n\n"),
    );
  },
};

export const OFFICE_TASKS_TOOLS: readonly McpTool[] = [claimTaskTool, completeTaskTool];

export default async function mcpTaskRoutes(app: FastifyInstance): Promise<void> {
  mountMcpServer(app, MCP_TASKS_PATH, {
    name: MCP_SERVER_NAME,
    // Not the package version: this is the tool contract's version, and a
    // client that caches a tool list has to be able to tell that it changed.
    version: "1.0.0",
    tools: OFFICE_TASKS_TOOLS,
  });
}
