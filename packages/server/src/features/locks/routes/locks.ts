// The lock endpoints: GET /locks and POST /locks/expire.
//
// Deliberately read-and-sweep only. Acquiring and releasing belong to the
// callers that know *why* — `claim_task` and `complete_task` (017) and the
// PreToolUse guard (020) — not to a general-purpose HTTP surface that would
// let anything take a lock with no task behind it.
//
// Autoloaded from features/locks/routes/ by core/app.ts.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ProjectId, TaskId } from "@office/shared/ids";
import { InvalidPatternError } from "../overlap.ts";
import { expireLocks, listActiveLocks } from "../registry.ts";

function optionalString(raw: unknown): string | null {
  return typeof raw === "string" && raw !== "" ? raw : null;
}

export default async function lockRoutes(app: FastifyInstance): Promise<void> {
  // What is held right now — the Tasks page's "owned files" and the
  // operator's answer to "why is this task refused?".
  app.get("/locks", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as Record<string, unknown>;
    try {
      const locks = await listActiveLocks({
        projectId: optionalString(query.project_id) as ProjectId | null,
        taskId: optionalString(query.task_id) as TaskId | null,
        sessionId: optionalString(query.session_id),
      });
      return reply.code(200).send(locks);
    } catch (error) {
      if (error instanceof InvalidPatternError) {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    }
  });

  // The sweeper trigger. An endpoint rather than an internal timer because
  // the TTL is a backstop whose behaviour has to be observable: an operator
  // needs to be able to run it and see what it reclaimed, and step 7's
  // scheduler needs something to call. It reports what it did in the
  // response *and* emits FileLocksSwept, since a reclaimed lock means an
  // agent lost its files without asking.
  app.post("/locks/expire", async (_request: FastifyRequest, reply: FastifyReply) => {
    const result = await expireLocks();
    return reply.code(200).send({
      expired: result.expired,
      orphaned: result.orphaned,
      expiredCount: result.expired.length,
      orphanedCount: result.orphaned.length,
    });
  });
}
