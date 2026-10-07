// The session control API: POST /sessions, POST /sessions/:id/message,
// POST /sessions/:id/interrupt, DELETE /sessions/:id, GET /sessions,
// GET /sessions/:id.
//
// Ticket 008. Autoloaded from features/orchestrator/routes/ by core/app.ts.
//
// This file is a thin HTTP skin over ../sessions.ts: it validates the
// request shape, maps a typed SessionError onto a status code, and nothing
// else. The lifecycle rules, the queue and the hook gate all live in the
// module, because ticket 018 exposes the same operations as MCP tools and
// must get identical behaviour without going through HTTP.
//
// WHO MAY DO THIS: nobody is checked. The design does not say who may kill
// a session belonging to another user, step 1 has one user, and
// permissions are step 9 — so `requested_by` is recorded and never
// verified. Recorded here so the API is not mistaken for safe to expose
// publicly; the same note is on the ticket.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  isSessionBackend,
  isSessionRole,
  isSessionStatus,
  type SessionStatus,
} from "@office/shared/sessions";
import { asProjectId, asSessionId, type ProjectId } from "@office/shared/ids";
import {
  SessionError,
  getSession,
  interruptSession,
  killSession,
  listSessions,
  messageSession,
  pendingMessages,
  startSession,
} from "../sessions.ts";

/** One place that decides how a typed failure becomes a status code. */
const STATUS_FOR: Record<string, number> = {
  not_found: 404,
  invalid_request: 400,
  illegal_transition: 409,
  session_ended: 409,
  identity_conflict: 409,
  // 409 rather than 503: a dialog is a state the caller can resolve (answer
  // it in the pane, or interrupt), not a server fault. The body names the
  // pending tool call so the UI can say which one.
  blocked_by_dialog: 409,
  spawn_failed: 502,
};

function sendSessionError(reply: FastifyReply, error: SessionError): FastifyReply {
  const code = STATUS_FOR[error.kind] ?? 500;
  return reply.code(code).send({
    error: error.message,
    kind: error.kind,
    ...(error.pendingToolCall ? { pending_tool_call: error.pendingToolCall } : {}),
  });
}

function str(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim() !== "" ? raw : undefined;
}

export default async function sessionRoutes(app: FastifyInstance): Promise<void> {
  // --- Start -----------------------------------------------------------------
  app.post("/sessions", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;

    const projectId = str(body.project_id);
    const projectSlug = str(body.project_slug);
    const role = body.role;
    const dept = str(body.dept);
    const owner = str(body.owner);
    const backend = body.backend ?? "claude";
    const model = str(body.model);
    const modelReason = str(body.model_reason);
    const cwd = str(body.cwd);
    const claudeBin = str(body.claude_bin);

    const missing: string[] = [];
    if (!projectId) missing.push("project_id");
    if (!projectSlug) missing.push("project_slug");
    if (!dept) missing.push("dept");
    if (!owner) missing.push("owner");
    if (!model) missing.push("model");
    // Called out separately below rather than lumped in with the rest,
    // because a blank reason is the one field with a *reason* to be strict.
    if (!cwd) missing.push("cwd");
    if (!claudeBin) missing.push("claude_bin");
    if (missing.length > 0) {
      return reply.code(400).send({ error: `missing or empty: ${missing.join(", ")}` });
    }
    if (!isSessionRole(role)) {
      return reply.code(400).send({ error: `role must be one of management_lead, dept_lead, worker` });
    }
    if (!isSessionBackend(backend)) {
      return reply.code(400).send({ error: `backend must be one of claude, codex` });
    }
    if (!modelReason) {
      // The design's Spawn feed shows this next to every spawn, and it is how
      // a human notices a lead choosing the expensive model for everything.
      // A blank reason would make that feed lie, so it is not optional.
      return reply
        .code(400)
        .send({ error: "model_reason is required — the Spawn feed shows it next to every spawn" });
    }

    try {
      const result = await startSession({
        projectId: asProjectId(projectId as string),
        projectSlug: projectSlug as string,
        role,
        dept: dept as string,
        owner: owner as string,
        backend,
        model: model as string,
        modelReason,
        cwd: cwd as string,
        claudeBin: claudeBin as string,
        ...(str(body.brief) ? { brief: str(body.brief) as string } : {}),
        ...(body.env && typeof body.env === "object"
          ? { env: body.env as Record<string, string> }
          : {}),
      });
      // 201 even when the session ended up `failed`: the resource was
      // created and the row is the useful thing to return. A 5xx would
      // suggest nothing was recorded, which is the opposite of what this
      // ticket guarantees — the row is written before the spawn precisely
      // so a failure leaves evidence.
      return reply.code(201).send(result.session);
    } catch (error) {
      if (error instanceof SessionError) return sendSessionError(reply, error);
      throw error;
    }
  });

  // --- Read ------------------------------------------------------------------
  app.get("/sessions", async (request: FastifyRequest, reply: FastifyReply) => {
    const q = request.query as Record<string, unknown>;
    const status = str(q.status);
    if (status !== undefined && !isSessionStatus(status)) {
      return reply.code(400).send({ error: `unknown status ${JSON.stringify(status)}` });
    }
    const projectId = str(q.project_id);
    const sessions = await listSessions({
      projectId: projectId ? (asProjectId(projectId) as ProjectId) : null,
      status: (status as SessionStatus | undefined) ?? null,
      liveOnly: str(q.all) === undefined,
    });
    return reply.code(200).send(sessions);
  });

  app.get("/sessions/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const session = await getSession(asSessionId(id));
    if (!session) return reply.code(404).send({ error: `no session ${id}` });
    const pending = await pendingMessages(session.id);
    return reply.code(200).send({ ...session, pending_messages: pending });
  });

  // --- Message ---------------------------------------------------------------
  app.post("/sessions/:id/message", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const text = typeof body.body === "string" ? body.body : undefined;
    const requestedBy = str(body.requested_by) ?? "unknown";
    if (text === undefined || text === "") {
      return reply.code(400).send({ error: "body is required and must not be empty" });
    }
    try {
      const result = await messageSession(asSessionId(id), text, requestedBy);
      return reply.code(202).send(result);
    } catch (error) {
      if (error instanceof SessionError) return sendSessionError(reply, error);
      throw error;
    }
  });

  // --- Interrupt -------------------------------------------------------------
  app.post("/sessions/:id/interrupt", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      const result = await interruptSession(asSessionId(id), str(body.requested_by) ?? "unknown");
      // `discarded` is in the response on purpose: the UI must be able to
      // say "and N queued messages were dropped", because an interrupt that
      // silently discarded someone's instruction is worse than one that
      // says so.
      return reply.code(200).send({ session: result.session, discarded: result.discarded });
    } catch (error) {
      if (error instanceof SessionError) return sendSessionError(reply, error);
      throw error;
    }
  });

  // --- Kill ------------------------------------------------------------------
  app.delete("/sessions/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      // Idempotent, and 200 on the second call rather than 404 or 409: the
      // caller's intent — "this desk should not be running" — is satisfied
      // either way, and the UI must not show an error for succeeding twice.
      const session = await killSession(asSessionId(id), str(body.requested_by) ?? "unknown");
      return reply.code(200).send(session);
    } catch (error) {
      if (error instanceof SessionError) return sendSessionError(reply, error);
      throw error;
    }
  });
}
