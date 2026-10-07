// The chat API: read a transcript, find a desk's conversation, send a
// message to an agent.
//
//   GET  /conversations/:id/messages?before=&limit=
//   GET  /sessions/:id/conversation?task_id=
//   POST /conversations/:id/messages
//
// Ticket 010. Autoloaded from features/chat/routes/ by core/app.ts.
//
// A thin HTTP skin over ../transcript.ts and ../conversations.ts, in the
// house style of features/orchestrator/routes/sessions.ts: validate the
// request shape, map a typed failure onto a status code, nothing else. The
// rules live in the modules because ticket 026 is not the only caller — the
// spine verification (011) and any later MCP tool must get identical
// behaviour without going through HTTP.
//
// WHO MAY DO THIS: nobody is checked. `author` is recorded and never
// verified, matching 008's `requested_by` and 012's task actor. There is no
// authentication until step 9, and the app must not leave a trusted network.
//
// BODY PARSING: core/app.ts registers a raw passthrough parser for every
// content type, so `request.body` is a **string** here, not a parsed object.
// Parsing it locally is the pattern features/tasks/routes/tasks.ts
// established; a route that treats `request.body` as an object sees every
// field as missing.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { asSessionId, asTaskId } from "@office/shared/ids";
import { SessionError, getSession, messageSession } from "../../orchestrator/sessions.ts";
import {
  conversationSubjectForSession,
  currentSegment,
  getConversation,
  latestSegment,
  listSegments,
  openOrResumeSegment,
  resolveConversation,
} from "../conversations.ts";
import {
  TranscriptCursorError,
  appendMessage,
  markOutboundDelivery,
  readMessages,
} from "../transcript.ts";

/** Matches features/orchestrator/routes/sessions.ts, so a chat failure and a
 *  session failure answer with the same status for the same cause. */
const STATUS_FOR: Record<string, number> = {
  not_found: 404,
  invalid_request: 400,
  illegal_transition: 409,
  session_ended: 409,
  identity_conflict: 409,
  blocked_by_dialog: 409,
  spawn_failed: 502,
};

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function str(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim() !== "" ? raw : undefined;
}

function parseBody(request: FastifyRequest): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(typeof request.body === "string" ? request.body : "{}") as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseLimit(raw: unknown): number | { error: string } {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_PAGE_SIZE;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
    return { error: `limit must be an integer between 1 and ${MAX_PAGE_SIZE}` };
  }
  return value;
}

export default async function chatRoutes(app: FastifyInstance): Promise<void> {
  // --- Read a transcript ------------------------------------------------------
  //
  // Returns the segments alongside the page. The panel renders a labelled
  // divider at every segment boundary — "why it restarted, and whether a
  // handoff was restored" — so a page of messages without the segments it
  // spans cannot be drawn correctly. There is one segment per `/clear` or
  // respawn, so the list is small; fetching it per page is cheaper than
  // making the client join two endpoints and get the boundary wrong.
  app.get("/conversations/:id/messages", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const q = request.query as Record<string, unknown>;

    const limit = parseLimit(q.limit);
    if (typeof limit !== "number") return reply.code(400).send({ error: limit.error });

    const conversation = await getConversation(id);
    if (!conversation) return reply.code(404).send({ error: `no conversation ${id}` });

    try {
      const page = await readMessages({
        conversationId: conversation.id,
        before: str(q.before) ?? null,
        limit,
      });
      return reply.code(200).send({
        conversation,
        segments: await listSegments(conversation.id),
        messages: page.messages,
        // Named `next_before` rather than `next_cursor`: it is what to pass
        // as `before`, and a cursor whose name does not say which parameter
        // it feeds gets passed to the wrong one.
        next_before: page.nextBefore,
      });
    } catch (error) {
      if (error instanceof TranscriptCursorError) {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    }
  });

  // --- A desk's conversation --------------------------------------------------
  //
  // THIS GET CREATES, and that is deliberate rather than an oversight. A
  // human must be able to open a chat panel on a desk that has not said
  // anything yet and speak first, and `POST /conversations/:id/messages`
  // needs an id to post to. The write is an idempotent upsert of one row
  // with no side effects beyond its own existence (`resolveConversation`
  // leans on 0004's partial unique indexes, so two concurrent opens resolve
  // to one conversation). A segment is NOT created here — that happens when
  // there is something to put in it.
  //
  // `task_id` is accepted because nothing in the schema links a session to a
  // task: 0003 has no task_id column and `claim_task` is ticket 017. The
  // caller that knows the task is the only source there is — see the note in
  // ../conversations.ts.
  app.get("/sessions/:id/conversation", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const q = request.query as Record<string, unknown>;
    const session = await getSession(asSessionId(id));
    if (!session) return reply.code(404).send({ error: `no session ${id}` });

    const taskIdRaw = str(q.task_id);
    const conversation = await resolveConversation(
      conversationSubjectForSession(session, taskIdRaw ? asTaskId(taskIdRaw) : null),
    );
    return reply.code(200).send({
      conversation,
      segments: await listSegments(conversation.id),
      current_segment: await currentSegment(conversation.id),
    });
  });

  // --- Send a message to an agent ----------------------------------------------
  //
  // RECORDED BEFORE DELIVERY, ALWAYS. The criterion is "outbound messages
  // are recorded before delivery, with the human author attached, so a
  // message that fails to deliver is still visible in the transcript with a
  // failed marker" — so the order here is append(`pending`), attempt, mark.
  // It is also the only order that survives the server dying mid-send.
  app.post("/conversations/:id/messages", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = parseBody(request);
    if (body === null) return reply.code(400).send({ error: "body must be a JSON object" });

    const text = typeof body.body === "string" ? body.body : undefined;
    const author = str(body.author);
    if (text === undefined || text === "") {
      return reply.code(400).send({ error: "body is required and must not be empty" });
    }
    if (author === undefined) {
      // Required, unlike 008's `requested_by` which defaults to "unknown":
      // this string is rendered next to the message in a shared office
      // transcript, and "unknown said: ship it" is worse than a 400.
      return reply
        .code(400)
        .send({ error: "author is required — the transcript shows it next to the message" });
    }

    const conversation = await getConversation(id);
    if (!conversation) return reply.code(404).send({ error: `no conversation ${id}` });

    // Which desk. An explicit session_id wins, because the panel knows which
    // desk it is looking at; otherwise the conversation's newest segment,
    // which is the desk that last spoke in it.
    const explicit = str(body.session_id);
    const target = explicit
      ? await getSession(asSessionId(explicit))
      : await sessionOfLatestSegment(conversation.id);
    if (!target) {
      // Nothing recorded in this case, and that is a real limitation rather
      // than a choice: `chat_messages.session_id` is NOT NULL, so a message
      // with no desk at all has nowhere to live. Every failure mode that
      // matters — ended session, tmux refusal, open permission dialog — has
      // a desk, and those are recorded then marked failed below.
      return reply.code(409).send({
        error:
          "this conversation has no session to deliver to; pass session_id, or start a desk first",
        kind: "no_session",
      });
    }
    if (target.projectId !== conversation.projectId) {
      return reply.code(400).send({
        error: `session ${target.id} belongs to project ${target.projectId}, not ${conversation.projectId}`,
        kind: "invalid_request",
      });
    }

    const { segment } = await openOrResumeSegment({
      session: target,
      claudeSessionId: target.claudeSessionId,
    });

    const appended = await appendMessage({
      conversationId: conversation.id,
      segmentId: segment.id,
      sessionId: target.id,
      projectId: conversation.projectId,
      claudeSessionId: target.claudeSessionId,
      direction: "outbound",
      author,
      body: text,
      turnId: null,
      deliveryStatus: "pending",
    });
    const messageId = appended.message.id;
    const marker = {
      projectId: conversation.projectId,
      claudeSessionId: target.claudeSessionId,
    };

    try {
      const result = await messageSession(target.id, text, author);
      const delivered = await markOutboundDelivery(messageId, "delivered", {
        ...marker,
        queuedMessageId: result.queuedMessageId,
      });
      return reply.code(202).send({ message: delivered ?? appended.message, delivery: result });
    } catch (error) {
      if (error instanceof SessionError) {
        if (error.kind === "blocked_by_dialog") {
          // Not a failure. 008 refuses to deliver into an open permission
          // dialog because a message delivered there **approves the pending
          // tool call** — confirmed on the target 20/20, with the approved
          // command's file left on disk — and leaves the message pending in
          // its own queue. 202, with the honest marker.
          //
          // Carried gap: nothing re-drains that queue when the dialog
          // clears (008's `messageSession` is the only sender), so a
          // `queued` message needs a human to re-send. Reported, not
          // papered over.
          const queued = await markOutboundDelivery(messageId, "queued", {
            ...marker,
            detail: error.message,
          });
          return reply.code(202).send({
            message: queued ?? appended.message,
            delivery: { delivered: false, kind: error.kind },
            ...(error.pendingToolCall ? { pending_tool_call: error.pendingToolCall } : {}),
          });
        }
        const failed = await markOutboundDelivery(messageId, "failed", {
          ...marker,
          detail: error.message,
        });
        return reply.code(STATUS_FOR[error.kind] ?? 500).send({
          error: error.message,
          kind: error.kind,
          // The message id is in the body on purpose: the panel has already
          // rendered the bubble optimistically and needs to find it to put
          // the failed marker on it.
          message: failed ?? appended.message,
        });
      }
      const failed = await markOutboundDelivery(messageId, "failed", {
        ...marker,
        detail: error instanceof Error ? error.message : String(error),
      });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : String(error),
        kind: "unknown",
        message: failed ?? appended.message,
      });
    }
  });
}

async function sessionOfLatestSegment(conversationId: string) {
  const segment = await latestSegment(conversationId);
  if (!segment) return null;
  return getSession(segment.sessionId);
}
