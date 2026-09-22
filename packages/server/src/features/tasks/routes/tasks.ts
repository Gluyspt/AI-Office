// The task endpoints: POST /tasks, GET /tasks, GET /tasks/:id,
// PATCH /tasks/:id, GET /board.
//
// Autoloaded from features/tasks/routes/ by core/app.ts — tickets 014, 017
// and 032 add their own files beside this one rather than editing it, which
// is what keeps four tickets off one file.
//
// No authentication: there is none anywhere in the system until step 9
// (docs/tasks/README.md, "left inert"). The hook-ingest token on
// features/events/routes/events.ts guards *forged hook events*
// specifically; it is not a general auth scheme and is deliberately not
// copied here.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ProjectId, TaskId } from "@office/shared/ids";
import { createTask, TaskValidationError } from "../model.ts";
import {
  board,
  getTaskWithHistory,
  insertTask,
  listTasks,
  parseDepartmentFilter,
  parseStateFilter,
  StateNotPatchableError,
  TaskFieldError,
  updateTaskFields,
  type TaskFilters,
} from "../repo.ts";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function parseLimit(raw: unknown): number {
  if (typeof raw !== "string" || raw === "") return DEFAULT_LIMIT;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) return DEFAULT_LIMIT;
  return Math.min(value, MAX_LIMIT);
}

function optionalString(raw: unknown): string | null {
  return typeof raw === "string" && raw !== "" ? raw : null;
}

/** Reads the four filters a board or list accepts. Throws TaskFieldError
 * for a bad department or state, so a typo is a 400 naming the valid
 * values rather than a silently empty board. */
function readFilters(query: Record<string, unknown>): TaskFilters {
  return {
    projectId: optionalString(query.project_id) as ProjectId | null,
    owner: optionalString(query.owner),
    department: parseDepartmentFilter(query.department),
    state: parseStateFilter(query.state),
  };
}

/** One place that turns this feature's error types into responses, so no
 * handler below repeats the mapping and none of them can answer 500 for
 * what is a caller mistake. */
function fail(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof StateNotPatchableError) {
    return reply.code(400).send({ error: "state is not patchable", problems: error.problems });
  }
  if (error instanceof TaskValidationError || error instanceof TaskFieldError) {
    return reply.code(400).send({ error: "invalid task", problems: error.problems });
  }
  throw error;
}

export default async function taskRoutes(app: FastifyInstance): Promise<void> {
  app.post("/tasks", async (request: FastifyRequest, reply: FastifyReply) => {
    // app.ts registers a raw passthrough parser for every content type, so
    // a JSON body arrives here as a string and is parsed once, here.
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(typeof request.body === "string" ? request.body : "{}") as Record<
        string,
        unknown
      >;
    } catch {
      return reply.code(400).send({ error: "body is not valid JSON" });
    }
    try {
      // createTask validates and mints the id; it also refuses a department
      // outside dev/research/qa, naming the valid set in the message.
      const task = createTask(body as never);
      const record = await insertTask(task);
      return reply.code(201).send(record);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get("/tasks", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as Record<string, unknown>;
    try {
      const page = await listTasks({
        ...readFilters(query),
        limit: parseLimit(query.limit),
        cursor: optionalString(query.cursor),
      });
      return reply.code(200).send(page);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get("/tasks/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const found = await getTaskWithHistory(id as TaskId);
    if (!found) return reply.code(404).send({ error: "task not found", id });
    return reply.code(200).send(found);
  });

  app.patch("/tasks/:id", async (request: FastifyRequest, reply: FastifyReply) => {
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
    try {
      const updated = await updateTaskFields(id as TaskId, body);
      if (!updated) return reply.code(404).send({ error: "task not found", id });
      return reply.code(200).send(updated);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get("/board", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as Record<string, unknown>;
    try {
      return reply.code(200).send(await board(readFilters(query)));
    } catch (error) {
      return fail(reply, error);
    }
  });
}
