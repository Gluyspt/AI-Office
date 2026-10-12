// The chat endpoints, over the real app through Fastify's inject().
//
// THIS FILE DID NOT EXIST UNTIL THE 2026-10-10 CRITERIA AUDIT, and a comment in
// ../transcript.test.ts said it did ("proven ... again end to end in
// routes/chat.test.ts"). Nothing had ever called these three routes. The
// functions underneath them were well covered, which is what made the gap easy
// to miss and worth closing: paging, the 404s, the cursor rejection and
// "recorded before delivery" are all properties of the HTTP surface, and a
// panel talks to the surface, not to `readMessages`.
//
// What is asserted here that a unit test cannot: that the routes are autoloaded
// at all (005's convention — a file in features/*/routes/ with no registry
// edit), that `next_before` feeds back into `before` under its own name, and
// that a failed delivery still leaves the human's message in the transcript.
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProjectId } from "@office/shared/ids";
import { buildApp } from "../../../core/app.ts";
import { pool } from "../../../core/db/pool.ts";
import { SESSION_COLUMNS, sessionRowToRecord } from "@office/shared/sessions";
import { openOrResumeSegment } from "../conversations.ts";
import { appendMessage } from "../transcript.ts";

let app: FastifyInstance;
const createdProjects: string[] = [];

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
  for (const id of createdProjects) {
    await pool.query("delete from projects where id = $1", [id]);
  }
});

async function makeProject(): Promise<ProjectId> {
  const slug = `t010r-${randomUUID()}`;
  const { rows } = await pool.query<{ id: string }>(
    `insert into projects (name, slug, repo_url) values ($1, $2, $3) returning id`,
    [slug, slug, "https://example.invalid/repo.git"],
  );
  const id = rows[0]!.id;
  createdProjects.push(id);
  return id as ProjectId;
}

async function makeDesk(projectId: ProjectId) {
  const { rows } = await pool.query(
    `insert into sessions
       (project_id, tmux_name, role, dept, owner, backend, model, model_reason,
        status, claude_session_id)
     values ($1, $2, 'dept_lead', 'dev', 'gluy', 'claude', 'claude-sonnet-5',
             'test fixture', 'running', $3)
     returning ${SESSION_COLUMNS}`,
    [projectId, `t010r-${randomUUID()}`, randomUUID()],
  );
  const session = sessionRowToRecord(rows[0] as never);
  const { conversation, segment } = await openOrResumeSegment({
    session,
    claudeSessionId: session.claudeSessionId,
    startReason: "spawn",
  });
  return { session, conversationId: conversation.id, segmentId: segment.id };
}

// --- GET /conversations/:id/messages --------------------------------------------

describe("GET /conversations/:id/messages", () => {
  it("returns the conversation, its segments and its messages", async () => {
    const projectId = await makeProject();
    const desk = await makeDesk(projectId);
    await appendMessage({
      conversationId: desk.conversationId,
      segmentId: desk.segmentId,
      sessionId: desk.session.id,
      projectId,
      claudeSessionId: desk.session.claudeSessionId,
      direction: "inbound",
      author: "agent:dept_lead:dev",
      body: "on it",
      turnId: randomUUID(),
    });

    const response = await app.inject({
      method: "GET",
      url: `/conversations/${desk.conversationId}/messages`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      conversation: { id: string };
      segments: unknown[];
      messages: { body: string }[];
      next_before: string | null;
    };
    expect(body.conversation.id).toBe(desk.conversationId);
    // The segments travel WITH the page. 026's conversation divider needs to
    // know why the previous desk ended, and a page of messages without its
    // segments cannot label a boundary it can see.
    expect(body.segments.length).toBeGreaterThan(0);
    expect(body.messages.map((message) => message.body)).toEqual(["on it"]);
    expect(body.next_before).toBeNull();
  });

  it("pages backwards through `next_before` with no gaps and no duplicates", async () => {
    // Criterion: "GET /conversations/:id/messages?before= pages backwards
    // across segment boundaries without gaps or duplicates." The function is
    // asserted in ../transcript.test.ts; this asserts the round trip the panel
    // actually makes, including that `next_before` is what `before` takes.
    const projectId = await makeProject();
    const desk = await makeDesk(projectId);
    const sent: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const body = `m${i}`;
      sent.push(body);
      await appendMessage({
        conversationId: desk.conversationId,
        segmentId: desk.segmentId,
        sessionId: desk.session.id,
        projectId,
        claudeSessionId: desk.session.claudeSessionId,
        direction: "inbound",
        author: "agent:dept_lead:dev",
        body,
        turnId: randomUUID(),
      });
    }

    const seen: string[] = [];
    let before: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const url = `/conversations/${desk.conversationId}/messages?limit=3${
        before ? `&before=${encodeURIComponent(before)}` : ""
      }`;
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        messages: { body: string }[];
        next_before: string | null;
      };
      // Each page arrives in send order; walking backwards means each page
      // sits BEFORE the ones already collected.
      seen.unshift(...body.messages.map((message) => message.body));
      before = body.next_before;
      if (before === null) break;
    }

    expect(seen).toEqual(sent);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("404s an unknown conversation instead of returning an empty page", async () => {
    // An empty page and a wrong id look identical to a panel, and one of them
    // means the human is looking at a desk that does not exist.
    const response = await app.inject({
      method: "GET",
      url: `/conversations/${randomUUID()}/messages`,
    });
    expect(response.statusCode).toBe(404);
  });

  it("400s a `before` it did not mint, rather than silently serving page one", async () => {
    const projectId = await makeProject();
    const desk = await makeDesk(projectId);
    const response = await app.inject({
      method: "GET",
      url: `/conversations/${desk.conversationId}/messages?before=not-a-cursor`,
    });
    expect(response.statusCode).toBe(400);
  });

  it("400s a limit that is not a limit", async () => {
    const projectId = await makeProject();
    const desk = await makeDesk(projectId);
    const response = await app.inject({
      method: "GET",
      url: `/conversations/${desk.conversationId}/messages?limit=banana`,
    });
    expect(response.statusCode).toBe(400);
  });
});

// --- GET /sessions/:id/conversation ---------------------------------------------

describe("GET /sessions/:id/conversation", () => {
  it("resolves the desk's conversation so a human can speak first", async () => {
    // This GET creates, deliberately: a human must be able to open a chat
    // panel on a desk that has not said anything yet, and POST needs an id to
    // post to.
    const projectId = await makeProject();
    const desk = await makeDesk(projectId);
    const response = await app.inject({
      method: "GET",
      url: `/sessions/${desk.session.id}/conversation`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      conversation: { id: string };
      segments: unknown[];
      current_segment: { id: string } | null;
    };
    expect(body.conversation.id).toBe(desk.conversationId);
    expect(body.current_segment?.id).toBe(desk.segmentId);
  });

  it("is idempotent — two opens resolve to one conversation", async () => {
    const projectId = await makeProject();
    const desk = await makeDesk(projectId);
    const once = await app.inject({
      method: "GET",
      url: `/sessions/${desk.session.id}/conversation`,
    });
    const twice = await app.inject({
      method: "GET",
      url: `/sessions/${desk.session.id}/conversation`,
    });
    expect((once.json() as { conversation: { id: string } }).conversation.id).toBe(
      (twice.json() as { conversation: { id: string } }).conversation.id,
    );
  });

  it("404s a session id no desk ever had", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/sessions/${randomUUID()}/conversation`,
    });
    expect(response.statusCode).toBe(404);
  });
});

// --- POST /conversations/:id/messages -------------------------------------------

describe("POST /conversations/:id/messages", () => {
  it("RECORDS THE MESSAGE EVEN WHEN DELIVERY FAILS", async () => {
    // The criterion: "Outbound messages are recorded before delivery, with the
    // human author attached, so a message that fails to deliver is still
    // visible." This test does not simulate the failure — there is no tmux
    // server here, so delivery genuinely cannot happen, which makes it the
    // honest form of the assertion rather than a mocked one.
    //
    // What must be true afterwards: the human's words are in the transcript,
    // attributed to them, marked not-delivered, and the response carries the
    // message id so the panel can find the optimistic bubble it already drew
    // and put a failed marker on it.
    const projectId = await makeProject();
    const desk = await makeDesk(projectId);

    const response = await app.inject({
      method: "POST",
      url: `/conversations/${desk.conversationId}/messages`,
      payload: { body: "please rebase onto master", author: "gluy" },
    });

    // Any outcome but "silently dropped" is acceptable here: 202 if it somehow
    // delivered or queued, 4xx/5xx if tmux refused. What is NOT acceptable is
    // the message being absent below.
    const payload = response.json() as { message?: { id: string; body: string } };
    expect(payload.message?.body).toBe("please rebase onto master");

    const { rows } = await pool.query<{
      body: string;
      author: string;
      direction: string;
      delivery_status: string | null;
    }>(
      `select body, author, direction, delivery_status
         from chat_messages where conversation_id = $1 and direction = 'outbound'`,
      [desk.conversationId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.body).toBe("please rebase onto master");
    expect(rows[0]?.author).toBe("gluy");
    // Recorded before delivery means the row exists whatever delivery did; it
    // must not be sitting there claiming it was delivered.
    expect(rows[0]?.delivery_status).not.toBe("delivered");
  });

  it("refuses an empty body rather than delivering a blank turn", async () => {
    const projectId = await makeProject();
    const desk = await makeDesk(projectId);
    for (const payload of [{ author: "gluy" }, { body: "   ", author: "gluy" }]) {
      const response = await app.inject({
        method: "POST",
        url: `/conversations/${desk.conversationId}/messages`,
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it("404s an unknown conversation", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/conversations/${randomUUID()}/messages`,
      payload: { body: "hello", author: "gluy" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("refuses a session belonging to another project", async () => {
    // Cross-project delivery is the shape of a transcript leak: the message
    // would be recorded against one project's conversation and typed into
    // another project's desk.
    const projectA = await makeProject();
    const projectB = await makeProject();
    const deskA = await makeDesk(projectA);
    const deskB = await makeDesk(projectB);

    const response = await app.inject({
      method: "POST",
      url: `/conversations/${deskA.conversationId}/messages`,
      payload: { body: "wrong desk", author: "gluy", session_id: deskB.session.id },
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { kind?: string }).kind).toBe("invalid_request");
  });
});
