// The /events/* endpoints: the design's eight hook-ingest endpoints, plus
// GET /events for querying the store. One file because they share the same
// token check and the same ingest pipeline — autoloaded by app.ts, so a
// later ticket adding an unrelated endpoint (e.g. ticket 008's
// routes/sessions.ts) does this by adding its own file, never by editing
// this one.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { EVENT_ENDPOINTS } from "@office/shared/events";
import { loadServerConfig } from "../../../core/config.ts";
import { ingestHookPayload, listEvents } from "../ingest.ts";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

function parseLimit(raw: unknown): number {
  if (typeof raw !== "string" || raw.length === 0) return DEFAULT_LIMIT;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) return DEFAULT_LIMIT;
  return Math.min(value, MAX_LIMIT);
}

function hasValidToken(request: FastifyRequest, tokens: readonly string[]): boolean {
  const query = request.query as Record<string, unknown>;
  const token = query.token;
  return typeof token === "string" && tokens.includes(token);
}

function rawBodyOf(request: FastifyRequest): string {
  // app.ts's catch-all content-type parser hands every body through as a
  // string untouched — see its comment for why JSON parsing must not
  // happen before ingest.ts's dead-letter path gets a chance to run.
  return typeof request.body === "string" ? request.body : "";
}

export default async function eventsRoutes(app: FastifyInstance): Promise<void> {
  const { hookIngestTokens } = loadServerConfig();

  // The design's eight hook-ingest endpoints. Registered from
  // EVENT_ENDPOINTS (packages/shared/src/events.ts) rather than eight
  // hand-written handlers — that table is the single source of truth for
  // "which endpoint" exists, shared with anything that documents or
  // provisions them (ticket 009's hook config template).
  for (const slug of Object.keys(EVENT_ENDPOINTS)) {
    app.post(`/events/${slug}`, async (request: FastifyRequest, reply: FastifyReply) => {
      // A hook POST carries no authentication of its own (spike §5,
      // "Transport facts") — anything reaching this port can forge any
      // event for any session_id. This token, plus binding loopback in
      // server.ts, is the mitigation the ticket's "Decided" section
      // requires. Rejected outright (not dead-lettered): an invalid token
      // is a security boundary, not a data-shape problem, and every
      // legitimately-provisioned hook always carries the right one
      // (ticket 009 puts it in the hook URL).
      if (!hasValidToken(request, hookIngestTokens)) {
        return reply.code(401).send({ error: "missing or invalid token" });
      }
      const stored = await ingestHookPayload(rawBodyOf(request));
      return reply.code(200).send({ ok: true, id: stored.id, type: stored.type });
    });
  }

  // Not a hook-ingest endpoint — this is the office UI reading the store
  // back, so it doesn't carry a hook token. Per this ticket's carried-open
  // question, the event server has no authentication for v1 beyond the
  // hook-forgery mitigation above; this is the same "assumed unauthenticated
  // for v1, revisit at step 9" gap the ticket names.
  app.get("/events", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as Record<string, unknown>;
    const projectId = typeof query.project_id === "string" && query.project_id.length > 0
      ? query.project_id
      : null;
    const since = typeof query.since === "string" && query.since.length > 0 ? query.since : null;
    const events = await listEvents({ projectId, since, limit: parseLimit(query.limit) });
    return reply.code(200).send(events);
  });
}
