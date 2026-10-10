// The guard endpoints: POST /guard/check and POST /guard/flush.
//
// Ticket 020. Autoloaded from features/locks/routes/ by core/app.ts, so
// adding them needed no edit to a route registry.
//
//
// THE ONE RULE BOTH ENDPOINTS OBEY: ALWAYS ANSWER 2xx
// --------------------------------------------------
// Spike 001 §2b measured it: **blocking is carried by the body of a 2xx, not
// by the status code.** A `500` did not block, and a non-2xx is shown to the
// agent as a hook error (§6: "exactly one delivery, error shown to the agent,
// action proceeds"). So:
//
//   - A refusal is a **200** whose body carries the blocking fields.
//   - An internal failure is a **200** whose body allows — the guard fails
//     open, which is this ticket's decided behaviour, and a 500 would both
//     fail open anyway *and* print an error into the agent's turn.
//
// The one exception is the token check, and it is deliberate: a bad token is
// a security boundary rather than a data-shape problem, so `/guard/check`
// 401s exactly like `/events/*` does. The consequence is honest and worth
// stating — a misprovisioned token turns the guard off, loudly, in the
// agent's transcript, and the script's buffer records every edit that got
// through while it was wrong.
//
//
// WHY /guard/check DOES NOT INGEST THE EVENT
// ------------------------------------------
// The base hook template already registers an unmatched `PreToolUse` entry
// pointing at `/events/tool`, so every tool call is already persisted and
// already dispatched to `handlers/tool.ts`. Ingesting here as well would
// store a second copy of every mutating call — including, for a `Write`, a
// second copy of the whole file body in `tool_input.content`. This endpoint
// is a pure decision: it reads, it answers, and it records only refusals.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { loadServerConfig } from "../../../core/config.ts";
import {
  buildAllowBody,
  buildDenyBody,
  guardCheck,
  recordBlocked,
  type GuardCheckInput,
} from "../guard-check.ts";
import { ingestFlush, listUnguardedEdits, type FlushRequest } from "../unguarded-edits.ts";

/**
 * app.ts registers a raw passthrough content-type parser for every body, so
 * `request.body` is the unparsed string. Hook POSTs must be parsed here
 * rather than by Fastify, for the reason 005 documents: a malformed body has
 * to be handled as data, never as a framework-level 400 that the agent sees
 * as a hook error.
 */
function parseBody(request: FastifyRequest): Record<string, unknown> | null {
  const raw = typeof request.body === "string" ? request.body : "";
  if (raw.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function hasValidToken(request: FastifyRequest, tokens: readonly string[]): boolean {
  const query = request.query as Record<string, unknown>;
  const token = query.token;
  return typeof token === "string" && tokens.includes(token);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

export default async function guardRoutes(app: FastifyInstance): Promise<void> {
  const { hookIngestTokens } = loadServerConfig();

  // --- The decision ----------------------------------------------------------
  //
  // Called by the `http` hook entry in
  // config/hooks/fragments/pretooluse-guard.json, with the raw `PreToolUse`
  // payload as its body.
  app.post("/guard/check", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!hasValidToken(request, hookIngestTokens)) {
      return reply.code(401).send({ error: "missing or invalid token" });
    }

    const body = parseBody(request);
    if (body === null) {
      // Unreadable payload. Allow — the guard cannot refuse an edit it cannot
      // describe, and refusing on a parse failure would block every tool call
      // the moment a payload shape changed.
      return reply.code(200).send({
        office: {
          outcome: "allow",
          checked: false,
          degraded: true,
          reason: "the guard could not parse the hook payload — failing open",
          paths: [],
          skipped: [],
          elapsed_ms: 0,
        },
      });
    }

    const input: GuardCheckInput = {
      sessionId: stringOrNull(body.session_id),
      toolName: stringOrNull(body.tool_name),
      toolInput: body.tool_input,
      cwd: stringOrNull(body.cwd),
      toolUseId: stringOrNull(body.tool_use_id),
    };

    const decision = await guardCheck(input);
    if (decision.outcome === "deny") {
      // Recorded before the reply, so the event exists by the time the agent
      // has been told. `recordBlocked` is the only write on the hot path, and
      // it only happens on a refusal.
      try {
        await recordBlocked(input, decision);
      } catch (error) {
        // A failed event write must not turn a refusal into an allow: the
        // refusal is the protection, the event is the record of it.
        console.error("guard: recording GuardEditBlocked failed", error);
      }
      return reply.code(200).send(buildDenyBody(decision));
    }
    return reply.code(200).send(buildAllowBody(decision));
  });

  // --- Recovery --------------------------------------------------------------
  //
  // Called by hooks/pretooluse-guard.sh on EVERY mutating tool call, carrying
  // whatever its on-disk buffer holds — usually nothing. That is what makes it
  // a reachability probe as well as a flush: the script has no other way to
  // learn the orchestrator is unreachable than to try, and the attempt it
  // makes is the one that also drains the buffer.
  //
  // The script deletes its spool only after this answers 2xx. A lost ack
  // therefore means a repeat flush, which `ingestFlush` makes a no-op — see
  // its idempotency note.
  app.post("/guard/flush", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!hasValidToken(request, hookIngestTokens)) {
      return reply.code(401).send({ error: "missing or invalid token" });
    }
    const body = parseBody(request);
    if (body === null) {
      // 200, not 400. A 4xx here would make the script keep its buffer
      // forever and retry an unparseable spool on every tool call; worse, the
      // agent sees the hook error. The buffer is sacrificed and the fact is
      // reported.
      return reply.code(200).send({
        ok: false,
        error: "unparseable flush body; the buffer was acknowledged and discarded",
      });
    }

    const result = await ingestFlush(body as FlushRequest);
    return reply.code(200).send({
      ok: true,
      flush_id: result.flushId,
      received: result.received,
      accepted: result.accepted,
      duplicates: result.duplicates,
      unusable: result.unusable,
      conflicts: result.conflicts,
      flagged_task_ids: result.flaggedTaskIds,
      refused_overflow: result.refusedOverflow,
      // The edit ids the orchestrator now holds. The script does not need
      // them (it drops the whole spool on a 2xx), but an operator debugging a
      // recovery does, and so does ticket 029's panel.
      accepted_edit_ids: result.edits.filter((edit) => edit.accepted).map((edit) => edit.editId),
    });
  });

  // --- Read ------------------------------------------------------------------
  //
  // Not a hook endpoint: this is ticket 029's UnguardedEdits panel reading the
  // record back, so it carries no hook token — the same "unauthenticated for
  // v1, revisit at step 9" gap `GET /events` and `GET /locks` already have.
  app.get("/guard/unguarded-edits", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as Record<string, unknown>;
    const limitRaw = typeof query.limit === "string" ? Number.parseInt(query.limit, 10) : NaN;
    const edits = await listUnguardedEdits({
      projectId: stringOrNull(query.project_id),
      flushId: stringOrNull(query.flush_id),
      limit: Number.isInteger(limitRaw) ? limitRaw : undefined,
    });
    return reply.code(200).send(edits);
  });
}
