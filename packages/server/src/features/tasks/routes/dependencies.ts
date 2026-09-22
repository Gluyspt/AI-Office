// Dependency endpoints: GET and PUT /tasks/:id/dependencies.
//
// PUT replaces the whole set rather than offering add/remove endpoints. The
// scope-ordering check has to run against the *resulting* graph, and a
// caller removing two edges one at a time would be refused on the first
// even when the pair together is legal. Declaring the end state lets the
// check run once, on what the caller actually wants.
//
// Autoloaded from features/tasks/routes/ — a sibling of tasks.ts, owned by
// a different ticket, which is the arrangement the routes/ directory
// convention exists to allow.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { TaskId } from "@office/shared/ids";
import { asTaskId } from "@office/shared/ids";
import { withTransaction } from "../../../core/db/pool.ts";
import {
  addDependency,
  DependencyCycleError,
  DependencyError,
  dependenciesOf,
  isClaimable,
  removeDependency,
} from "../dependencies.ts";
import { checkProjectScopeOrdering } from "../scope-ordering.ts";
import { getTask } from "../repo.ts";

function parseIdList(raw: unknown): TaskId[] | null {
  if (!Array.isArray(raw)) return null;
  if (!raw.every((entry) => typeof entry === "string" && entry.length > 0)) return null;
  return raw.map((entry) => asTaskId(entry as string));
}

export default async function dependencyRoutes(app: FastifyInstance): Promise<void> {
  // Both directions: what blocks this, and what this blocks. The board
  // needs both — the first for the blocked banner, the second for the
  // warning on a send-back.
  app.get("/tasks/:id/dependencies", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const task = await getTask(id as TaskId);
    if (!task) return reply.code(404).send({ error: "task not found", id });

    const edges = await dependenciesOf(id as TaskId);
    const claimability = await isClaimable(id as TaskId);
    return reply.code(200).send({
      taskId: id,
      blockedBy: edges.blockedBy,
      blocks: edges.blocks,
      claimable: claimability.claimable,
      waitingOn: claimability.blockedBy,
    });
  });

  app.put("/tasks/:id/dependencies", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(typeof request.body === "string" ? request.body : "{}") as Record<
        string,
        unknown
      >;
    } catch {
      return reply.code(400).send({ error: "body is not valid JSON" });
    }

    const requested = parseIdList(body.blockedBy);
    if (!requested) {
      return reply.code(400).send({ error: "blockedBy must be an array of task ids" });
    }

    const task = await getTask(id as TaskId);
    if (!task) return reply.code(404).send({ error: "task not found", id });

    const taskId = id as TaskId;
    const current = await dependenciesOf(taskId);
    const wanted = new Set<string>(requested);
    const removals = current.blockedBy.filter((edge) => !wanted.has(edge));

    // Removing an edge can leave an overlap that nothing orders any more.
    // Checked against the hypothetical graph *before* anything is written,
    // one removal at a time, so the refusal can name the edge responsible.
    for (const removed of removals) {
      const problems = await checkProjectScopeOrdering(task.projectId, {
        withoutEdge: { taskId, blockedByTaskId: removed },
      });
      if (problems.length > 0) {
        return reply.code(409).send({
          error: "removing this dependency would leave unordered overlapping scopes",
          removing: { taskId, blockedByTaskId: removed },
          problems,
        });
      }
    }

    try {
      await withTransaction(async (client) => {
        for (const removed of removals) {
          await removeDependency(taskId, removed, client);
        }
        for (const added of requested) {
          await addDependency(taskId, added, client);
        }
      });
    } catch (error) {
      if (error instanceof DependencyCycleError) {
        return reply.code(409).send({ error: error.message, detail: error.detail });
      }
      if (error instanceof DependencyError) {
        return reply.code(400).send({ error: error.message, detail: error.detail });
      }
      throw error;
    }

    const edges = await dependenciesOf(taskId);
    const claimability = await isClaimable(taskId);
    return reply.code(200).send({
      taskId,
      blockedBy: edges.blockedBy,
      blocks: edges.blocks,
      claimable: claimability.claimable,
      waitingOn: claimability.blockedBy,
    });
  });
}
