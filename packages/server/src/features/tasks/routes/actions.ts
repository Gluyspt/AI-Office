// POST /tasks/:id/claim and POST /tasks/:id/complete — the same two
// operations the MCP tools expose, over HTTP.
//
// Ticket 017. Autoloaded from features/tasks/routes/, a sibling of tasks.ts
// (013), dependencies.ts (014) and mcp-tasks.ts.
//
// WHY BOTH SURFACES EXIST. The MCP server is how an *agent* claims work; this
// is how a *human* does, from the Tasks page (025) — the design's "Start
// working" and the QA gate both need an operator to be able to move a task
// that an agent cannot or will not. Both call the same `claimTask` and
// `completeTask`, which is where every rule lives, so the two surfaces cannot
// drift into disagreeing about who may claim what.
//
// WHERE THE IDENTITY COMES FROM, and the one real difference between the two
// surfaces: an MCP call proves its desk with a per-session token, and this
// endpoint cannot — a browser has no desk. So it takes `owner` from the body
// and **records it without verifying it**, exactly as 008's control API and
// 012's `actor` do, because permissions are step 9. That is a deliberate
// asymmetry and not an oversight: an agent cannot forge an owner here either,
// because an agent reaches the coordination layer through MCP, where the
// identity is a header it never sees. This endpoint is for the office's own
// UI on a loopback https listener, and the note is here so nobody mistakes it
// for something safe to expose publicly.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { SessionRecord } from "@office/shared/sessions";
import { asProjectId, asSessionId, asTaskId } from "@office/shared/ids";
import { claimTask, type ClaimRefusalKind } from "../claim.ts";
import { completeTask, type CompleteRefusalKind } from "../complete.ts";

/**
 * One place that decides how a refusal becomes a status code.
 *
 * 409 for every "the office says no" case rather than 403, and that is the
 * considered answer: these are all conflicts with the current state of the
 * work — the task moved, a dependency has not delivered, somebody holds the
 * files — not authorisation failures. A 403 would tell the Tasks page to show
 * a permissions error for a task that is simply blocked.
 */
const STATUS_FOR: Record<ClaimRefusalKind | CompleteRefusalKind, number> = {
  not_found: 404,
  owner_mismatch: 409,
  wrong_state: 409,
  blocked_by_dependency: 409,
  scope_conflict: 409,
  scope_required: 400,
  summary_required: 400,
  learning_required: 400,
};

function parseBody(request: FastifyRequest): Record<string, unknown> | null {
  // The app's content-type parsers hand every body through as a raw string
  // (core/app.ts), so parsing is the route's job.
  const raw = request.body;
  if (raw === undefined || raw === null || raw === "") return {};
  if (typeof raw !== "string") return raw as Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * The caller, as a `SessionRecord` the coordination layer can use.
 *
 * `claimTask` and `completeTask` take a session because an agent's identity IS
 * its session, and that is the shape worth keeping honest. A human operator
 * has no desk, so this builds the narrow thing those functions actually read
 * — the owner — and leaves every other field recognisably synthetic rather
 * than inventing a plausible-looking desk that could be mistaken for one in a
 * log.
 */
function operatorAsSession(owner: string): SessionRecord {
  return {
    id: asSessionId("00000000-0000-0000-0000-000000000000"),
    projectId: asProjectId("00000000-0000-0000-0000-000000000000"),
    tmuxName: `http:${owner}`,
    role: "dept_lead",
    dept: "",
    owner,
    backend: "claude",
    model: "",
    modelReason: "",
    status: "running",
    claudeSessionId: null,
    failureKind: null,
    failureReason: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
  } as SessionRecord;
}

export default async function taskActionRoutes(app: FastifyInstance): Promise<void> {
  app.post("/tasks/:id/claim", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = parseBody(request);
    if (body === null) return reply.code(400).send({ error: "body must be a JSON object" });

    const owner = str(body.owner);
    if (!owner) {
      return reply
        .code(400)
        .send({ error: "owner is required: a claim is always on behalf of an agent account" });
    }

    const rawScope = body.file_scope;
    const scope = Array.isArray(rawScope)
      ? rawScope.filter((entry): entry is string => typeof entry === "string")
      : typeof rawScope === "string"
        ? [rawScope]
        : undefined;

    const result = await claimTask({
      taskId: asTaskId(id),
      session: operatorAsSession(owner),
      ...(scope === undefined ? {} : { scope }),
    });

    if (!result.ok) {
      return reply.code(STATUS_FOR[result.kind]).send({
        error: result.message,
        kind: result.kind,
        ...(result.conflicts ? { conflicts: result.conflicts } : {}),
        ...(result.blockedBy ? { blocked_by: result.blockedBy } : {}),
      });
    }
    return reply.code(200).send({ task: result.task, scope: result.scope });
  });

  app.post("/tasks/:id/complete", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = parseBody(request);
    if (body === null) return reply.code(400).send({ error: "body must be a JSON object" });

    const owner = str(body.owner);
    if (!owner) {
      return reply.code(400).send({ error: "owner is required" });
    }

    const result = await completeTask({
      taskId: asTaskId(id),
      session: operatorAsSession(owner),
      summary: typeof body.summary === "string" ? body.summary : null,
      learning: typeof body.learning === "string" ? body.learning : null,
    });

    if (!result.ok) {
      return reply.code(STATUS_FOR[result.kind]).send({ error: result.message, kind: result.kind });
    }
    return reply.code(200).send({
      task: result.task,
      locks_released: result.locksReleased,
      // The git half's own words, so an API consumer is told what the agent
      // is told: nothing was pushed.
      delivery: result.delivery,
    });
  });
}
