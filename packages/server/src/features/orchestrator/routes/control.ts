// The control API: pause, emergency stop, resume, and reading what is paused.
//
//   POST   /control/pause      — graceful: ask agents to stop, wait, report
//   POST   /control/stop       — emergency: do not ask, do not wait
//   POST   /control/resume     — one Resume for every kind of interruption
//   GET    /control/pauses     — what is paused right now, and why
//
// Ticket 028. Autoloaded from features/orchestrator/routes/ by core/app.ts.
//
// A thin HTTP skin over ../pause.ts and ../resume.ts: it validates the
// request shape, maps a typed `ControlError` onto a status code, and nothing
// else. The choreography lives in the modules, because ticket 029's UI calls
// this over HTTP while a crash handler and a rate-limit backoff call the
// same functions directly and must get identical behaviour.
//
// WHO MAY DO THIS: nobody is checked. `initiated_by` and `requested_by` are
// recorded and never verified — permissions are step 9, the same position
// ticket 008's API takes. Recorded here so this is not mistaken for safe to
// expose publicly. Note the asymmetry that makes it matter more than it does
// for 008: an unrestricted *emergency stop* across owners is a bigger deal
// than an unrestricted message, because one click ends everyone's desks.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { asProjectId, asTaskId } from "@office/shared/ids";
import { ControlError, activePauses, emergencyStop, pauseScope } from "../pause.ts";
import { resume } from "../resume.ts";

/** One place that decides how a typed failure becomes a status code. */
const STATUS_FOR: Record<string, number> = {
  invalid_request: 400,
  not_found: 404,
  // 409 for both: a pause mid-choreography and a project already paused are
  // states the caller can resolve, not server faults.
  pause_in_flight: 409,
  project_paused: 409,
};

function sendControlError(reply: FastifyReply, error: ControlError): FastifyReply {
  return reply.code(STATUS_FOR[error.kind] ?? 500).send({
    error: error.message,
    kind: error.kind,
    ...(error.detail ? { detail: error.detail } : {}),
  });
}

function str(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim() !== "" ? raw : undefined;
}

function actorKind(raw: unknown): "human" | "agent" | "system" | undefined {
  return raw === "human" || raw === "agent" || raw === "system" ? raw : undefined;
}

export default async function controlRoutes(app: FastifyInstance): Promise<void> {
  // --- Graceful pause ---------------------------------------------------------
  //
  // Returns 200 with the full report rather than 202, even though agents may
  // still be finishing: the pause is already in effect by the time this
  // responds — that is the point of taking the flag first — and the response
  // names which agents had not stopped by the deadline. A 202 would suggest
  // the pause itself was pending, which would be the wrong thing to show
  // someone who just pressed it because something was going wrong.
  app.post("/control/pause", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const initiatedBy = str(body.initiated_by);
    if (!initiatedBy) {
      return reply.code(400).send({
        error:
          "initiated_by is required — every pause, stop and resume records who triggered it, and an anonymous stop is the one audit record nobody can follow up on",
      });
    }
    const projectId = str(body.project_id);
    try {
      const result = await pauseScope({
        projectId: projectId ? asProjectId(projectId) : null,
        initiatedBy,
        reason: str(body.reason) ?? null,
        ...(actorKind(body.initiated_by_kind)
          ? { initiatedByKind: actorKind(body.initiated_by_kind)! }
          : {}),
      });
      return reply.code(200).send(result);
    } catch (error) {
      if (error instanceof ControlError) return sendControlError(reply, error);
      throw error;
    }
  });

  // --- Emergency stop ---------------------------------------------------------
  //
  // A separate endpoint rather than `?mode=emergency` on the one above,
  // deliberately. These are different actions with different consequences —
  // graceful asks and waits, emergency does neither — and a mode flag on a
  // destructive operation is the kind of thing that gets defaulted wrong
  // once and then kills everyone's desks. Two URLs cannot be confused.
  app.post("/control/stop", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const initiatedBy = str(body.initiated_by);
    if (!initiatedBy) {
      return reply
        .code(400)
        .send({ error: "initiated_by is required — see POST /control/pause" });
    }
    const projectId = str(body.project_id);
    try {
      const result = await emergencyStop({
        projectId: projectId ? asProjectId(projectId) : null,
        initiatedBy,
        reason: str(body.reason) ?? null,
        ...(actorKind(body.initiated_by_kind)
          ? { initiatedByKind: actorKind(body.initiated_by_kind)! }
          : {}),
      });
      return reply.code(200).send(result);
    } catch (error) {
      if (error instanceof ControlError) return sendControlError(reply, error);
      throw error;
    }
  });

  // --- Resume -----------------------------------------------------------------
  //
  // ONE endpoint for every kind of interruption — manual pause, crash,
  // circuit breaker, rate limit — because the design says one Resume
  // recovers all of them and the UI shows one button. Which of them it was
  // is recorded on the pause row; it does not change what resume does.
  app.post("/control/resume", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const requestedBy = str(body.requested_by);
    if (!requestedBy) {
      return reply
        .code(400)
        .send({ error: "requested_by is required — see POST /control/pause" });
    }
    const taskId = str(body.task_id);
    const projectId = str(body.project_id);
    try {
      const result = await resume({
        ...(taskId ? { taskId: asTaskId(taskId) } : {}),
        ...(projectId ? { projectId: asProjectId(projectId) } : {}),
        requestedBy,
        // `respawn: false` recovers task state and locks without starting
        // any agent. That matters on this host specifically: 3.2 GB total,
        // and an operator may want the board back before the desks.
        ...(body.respawn === false ? { respawn: false } : {}),
        ...(actorKind(body.requested_by_kind)
          ? { requestedByKind: actorKind(body.requested_by_kind)! }
          : {}),
      });
      return reply.code(200).send(result);
    } catch (error) {
      if (error instanceof ControlError) return sendControlError(reply, error);
      throw error;
    }
  });

  // --- What is paused ---------------------------------------------------------
  //
  // 029's banner reads this. It returns the reason and who pressed it as
  // well as the fact, because a banner that says only "paused" sends someone
  // to ask in chat what happened.
  app.get("/control/pauses", async (request: FastifyRequest, reply: FastifyReply) => {
    const q = request.query as Record<string, unknown>;
    const projectId = str(q.project_id);
    const pauses = await activePauses(projectId ? asProjectId(projectId) : null);
    return reply.code(200).send(pauses);
  });
}
