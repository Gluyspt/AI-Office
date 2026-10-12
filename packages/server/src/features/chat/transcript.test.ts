// The transcript: ordering, paging, delivery markers, bus publication and
// orphans, against a real database.
//
// Three of these tests are about things no mock can show:
//
//   * **Ordering under concurrency.** `seq` is a bigserial because the
//     target host's wall clock was observed stepping backwards twice in one
//     session, so a transcript ordered by `created_at` would reorder itself.
//     Proving that needs a real sequence.
//   * **Paging with no gap and no duplicate.** The cursor is a sequence
//     value, which is how it sidesteps the `timestamptz` -> `Date`
//     microsecond trap that has bitten this repo five times (once on a
//     paging cursor exactly like this one). Proving it needs real rows.
//   * **One reply per turn.** Enforced by a partial unique index.
//
// EVERY ASSERTION IS SCOPED TO THIS FILE'S OWN ROWS. The suite shares one
// database; a query against a whole table is wrong even with
// `fileParallelism: false`.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { SessionRecord } from "@office/shared/sessions";
import type { ProjectId } from "@office/shared/ids";
import { pool } from "../../core/db/pool.ts";
import { subscribe } from "../events/bus.ts";
import type { StoredEventRow } from "../events/ingest.ts";
import { SESSION_COLUMNS, sessionRowToRecord } from "@office/shared/sessions";
import { conversationSubjectForSession, openOrResumeSegment, resolveConversation } from "./conversations.ts";
import {
  TranscriptCursorError,
  appendMessage,
  decodeCursor,
  encodeCursor,
  listOrphanedReplies,
  markOutboundDelivery,
  readAllMessages,
  readMessages,
  recordOrphanedReply,
} from "./transcript.ts";

const createdProjects: string[] = [];

afterAll(async () => {
  for (const id of createdProjects) {
    await pool.query("delete from projects where id = $1", [id]);
  }
});

async function makeProject(): Promise<ProjectId> {
  const slug = `t010-${randomUUID()}`;
  const { rows } = await pool.query<{ id: string }>(
    `insert into projects (name, slug, repo_url) values ($1, $2, $3) returning id`,
    [slug, slug, "https://example.invalid/repo.git"],
  );
  const id = (rows[0] as { id: string }).id;
  createdProjects.push(id);
  return id as ProjectId;
}

async function makeSession(
  projectId: ProjectId,
  overrides: { dept?: string; owner?: string; role?: string } = {},
): Promise<SessionRecord> {
  const { rows } = await pool.query(
    `insert into sessions
       (project_id, tmux_name, role, dept, owner, backend, model, model_reason,
        status, claude_session_id)
     values ($1, $2, $3, $4, $5, 'claude', 'claude-sonnet-5', 'test fixture', 'running', $6)
     returning ${SESSION_COLUMNS}`,
    [
      projectId,
      `t010-${randomUUID()}`,
      overrides.role ?? "dept_lead",
      overrides.dept ?? "dev",
      overrides.owner ?? "agent1",
      randomUUID(),
    ],
  );
  return sessionRowToRecord(rows[0] as never);
}

interface Desk {
  readonly session: SessionRecord;
  readonly conversationId: string;
  readonly segmentId: string;
}

async function makeDesk(
  overrides: { projectId?: ProjectId; dept?: string; owner?: string } = {},
): Promise<Desk> {
  const projectId = overrides.projectId ?? (await makeProject());
  const session = await makeSession(projectId, overrides);
  const { conversation, segment } = await openOrResumeSegment({
    session,
    claudeSessionId: session.claudeSessionId,
    startReason: "spawn",
  });
  return { session, conversationId: conversation.id, segmentId: segment.id };
}

function inbound(desk: Desk, body: string, turnId = randomUUID()) {
  return appendMessage({
    conversationId: desk.conversationId,
    segmentId: desk.segmentId,
    sessionId: desk.session.id,
    projectId: desk.session.projectId,
    claudeSessionId: desk.session.claudeSessionId,
    direction: "inbound" as const,
    author: "agent:dept_lead:dev",
    body,
    turnId,
  });
}

function outbound(desk: Desk, body: string, author = "gluy") {
  return appendMessage({
    conversationId: desk.conversationId,
    segmentId: desk.segmentId,
    sessionId: desk.session.id,
    projectId: desk.session.projectId,
    claudeSessionId: desk.session.claudeSessionId,
    direction: "outbound" as const,
    author,
    body,
    turnId: null,
    deliveryStatus: "pending" as const,
  });
}

// --- Cursor (no database) -------------------------------------------------------

describe("the paging cursor", () => {
  it("round-trips a sequence value and nothing else", () => {
    // The point of this cursor is what it does NOT carry. A timestamp would
    // have to round-trip through a JS Date, which holds milliseconds while
    // Postgres holds microseconds — the trap that cost 013's task cursor and
    // 005's event cursor a fix each. An integer has nothing to truncate.
    expect(decodeCursor(encodeCursor(42))).toBe("42");
    expect(decodeCursor(encodeCursor("9007199254740993"))).toBe("9007199254740993");
  });

  it("rejects anything it did not mint", () => {
    expect(decodeCursor("nonsense")).toBeNull();
    expect(decodeCursor(Buffer.from("seq:abc", "utf8").toString("base64url"))).toBeNull();
    expect(decodeCursor(Buffer.from("2026-10-08T00:00:00Z|x", "utf8").toString("base64url"))).toBeNull();
    expect(decodeCursor("")).toBeNull();
  });

  it("refuses a bad `before` loudly rather than silently returning page one", async () => {
    const desk = await makeDesk();
    await expect(
      readMessages({ conversationId: desk.conversationId, before: "not-a-cursor", limit: 10 }),
    ).rejects.toBeInstanceOf(TranscriptCursorError);
  });
});

// --- Ordering -------------------------------------------------------------------

describe("ordering", () => {
  it("reads 50 interleaved inbound and outbound writes back in send order", async () => {
    const desk = await makeDesk();
    const expected: string[] = [];
    // Sequential sends, because "send order" is the order the server
    // accepted them and that is what the test is about. Concurrency is
    // covered by the next test.
    for (let i = 0; i < 50; i += 1) {
      const body = `m${i}`;
      expected.push(body);
      if (i % 2 === 0) await inbound(desk, body);
      else await outbound(desk, body);
    }

    const all = await readAllMessages(desk.conversationId);
    expect(all.map((m) => m.body)).toEqual(expected);
    // Monotonic, and strictly increasing within one conversation.
    const seqs = all.map((m) => m.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it("keeps a total order when writes land concurrently", async () => {
    const desk = await makeDesk();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        i % 2 === 0 ? inbound(desk, `c${i}`) : outbound(desk, `c${i}`),
      ),
    );
    const all = await readAllMessages(desk.conversationId);
    expect(all).toHaveLength(20);
    // No ties and no duplicates: a sequence value is unique, which is why
    // this cursor needs no tiebreaker column (unlike 005's event cursor,
    // where two hooks firing concurrently really do share a timestamp).
    expect(new Set(all.map((m) => m.seq)).size).toBe(20);
  });
});

// --- Paging ---------------------------------------------------------------------

describe("paging backwards", () => {
  it("walks a conversation in pages with no gaps and no duplicates, across segment boundaries", async () => {
    const desk = await makeDesk();
    const bodies: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      bodies.push(`seg1-${i}`);
      await inbound(desk, `seg1-${i}`);
    }

    // `/clear`: a new claude session on the same desk, so a new segment in
    // the SAME conversation. The cursor is conversation-wide, so the
    // boundary must be invisible to paging.
    const rotated = await openOrResumeSegment({
      session: desk.session,
      claudeSessionId: randomUUID(),
      startReason: "cleared",
    });
    const second: Desk = {
      session: desk.session,
      conversationId: rotated.conversation.id,
      segmentId: rotated.segment.id,
    };
    expect(rotated.conversation.id).toBe(desk.conversationId);
    for (let i = 0; i < 6; i += 1) {
      bodies.push(`seg2-${i}`);
      await inbound(second, `seg2-${i}`);
    }

    const seen: string[] = [];
    let before: string | null = null;
    let pages = 0;
    for (;;) {
      const page = await readMessages({
        conversationId: desk.conversationId,
        before,
        limit: 5,
      });
      // Each page arrives oldest-first, and pages walk backwards.
      seen.unshift(...page.messages.map((m) => m.body));
      pages += 1;
      if (page.nextBefore === null) break;
      before = page.nextBefore;
      expect(pages).toBeLessThan(10); // a cursor that fails to advance would loop
    }

    expect(seen).toEqual(bodies);
    expect(new Set(seen).size).toBe(bodies.length);
    // Two segments' worth of messages, read as one history. That is the
    // decision: the human sees continuous history even though the agent's
    // memory was wiped halfway through.
    const segmentIds = new Set(
      (await readAllMessages(desk.conversationId)).map((m) => m.segmentId),
    );
    expect(segmentIds.size).toBe(2);
  });

  it("returns a null cursor on a short page", async () => {
    const desk = await makeDesk();
    await inbound(desk, "only one");
    const page = await readMessages({ conversationId: desk.conversationId, limit: 5 });
    expect(page.messages.map((m) => m.body)).toEqual(["only one"]);
    expect(page.nextBefore).toBeNull();
  });
});

// --- Append semantics ------------------------------------------------------------

describe("append", () => {
  it("stores an inbound reply verbatim, with both ids and the segment", async () => {
    const desk = await makeDesk();
    const body = "  ready\nwith padding  ";
    const { message, inserted } = await inbound(desk, body);
    expect(inserted).toBe(true);
    expect(message.body).toBe(body);
    expect(message.conversationId).toBe(desk.conversationId);
    expect(message.sessionId).toBe(desk.session.id);
    expect(message.segmentId).toBe(desk.segmentId);
    expect(message.deliveryStatus).toBeNull();
  });

  it("refuses a second reply for the same turn", async () => {
    // Nothing dedupes hook POSTs — a `command` hook is a shell script a
    // human could re-run — so "appends exactly one inbound message" needs
    // the index, and the caller needs to be told the second call was a
    // no-op so it does not announce the same message twice.
    const desk = await makeDesk();
    const turnId = randomUUID();
    const first = await inbound(desk, "ready", turnId);
    const second = await inbound(desk, "ready", turnId);
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.message.id).toBe(first.message.id);
    expect(await readAllMessages(desk.conversationId)).toHaveLength(1);
  });

  it("allows two replies in one segment when they are different turns", async () => {
    const desk = await makeDesk();
    await inbound(desk, "one");
    await inbound(desk, "two");
    expect(await readAllMessages(desk.conversationId)).toHaveLength(2);
  });

  it("records an outbound message as pending before anything is delivered", async () => {
    const desk = await makeDesk();
    const { message } = await outbound(desk, "ship it", "gluy");
    expect(message.direction).toBe("outbound");
    expect(message.author).toBe("gluy");
    expect(message.deliveryStatus).toBe("pending");
  });

  it("marks a failed delivery, leaving the message visible", async () => {
    const desk = await makeDesk();
    const { message } = await outbound(desk, "ship it");
    const failed = await markOutboundDelivery(message.id, "failed", {
      detail: "session_ended: nothing can be delivered to it",
      projectId: desk.session.projectId,
      claudeSessionId: desk.session.claudeSessionId,
    });
    expect(failed?.deliveryStatus).toBe("failed");
    expect(failed?.deliveryDetail).toContain("session_ended");
    // Still in the transcript — that is the whole point of recording before
    // delivering.
    const all = await readAllMessages(desk.conversationId);
    expect(all.map((m) => m.id)).toContain(message.id);
  });

  it("will not mark an inbound message's delivery", async () => {
    const desk = await makeDesk();
    const { message } = await inbound(desk, "ready");
    const result = await markOutboundDelivery(message.id, "delivered", {
      projectId: desk.session.projectId,
      claudeSessionId: desk.session.claudeSessionId,
    });
    expect(result).toBeNull();
  });
});

// --- Isolation ------------------------------------------------------------------

describe("isolation", () => {
  it("never mixes two desks' transcripts, with traffic from both interleaved", async () => {
    // The criterion "two sessions belonging to different users never
    // cross-contaminate transcripts, asserted with concurrent traffic from
    // both".
    //
    // Both desks sit in the SAME project and the SAME department, differing
    // only by Linux account — the hardest case, and the one a role-slot key
    // of (project, dept, role) would get wrong by merging them.
    const projectId = await makeProject();
    const one = await makeDesk({ projectId, owner: "agent1", dept: "dev" });
    const two = await makeDesk({ projectId, owner: "agent2", dept: "dev" });
    expect(one.conversationId).not.toBe(two.conversationId);

    await Promise.all(
      Array.from({ length: 10 }, (_, i) => [
        inbound(one, `one-${i}`),
        outbound(two, `two-${i}`),
      ]).flat(),
    );

    const first = await readAllMessages(one.conversationId);
    const second = await readAllMessages(two.conversationId);
    expect(first).toHaveLength(10);
    expect(second).toHaveLength(10);
    expect(first.every((m) => m.body.startsWith("one-"))).toBe(true);
    expect(second.every((m) => m.body.startsWith("two-"))).toBe(true);
    expect(first.every((m) => m.sessionId === one.session.id)).toBe(true);
    expect(second.every((m) => m.sessionId === two.session.id)).toBe(true);
  });
});

// --- Bus publication ------------------------------------------------------------

describe("bus publication", () => {
  it("publishes every appended message to a subscriber watching that session", async () => {
    // Subscribed through ticket 006's real bus with a session filter — the
    // same path routes/ws.ts uses. The socket half of the journey is proven
    // in realtime/routes/ws.integration.test.ts and again end to end in
    // routes/chat.test.ts; what this asserts is that the event carries the
    // claude session id and the project id, WITHOUT which it reaches no
    // subscriber at all. That was a real gap once: 013's TaskCreated was
    // invisible to exactly the subscriber it existed for.
    const desk = await makeDesk();
    const received: StoredEventRow[] = [];
    const unsubscribe = subscribe(
      { sessionId: desk.session.claudeSessionId as string },
      (event) => {
        if (event.type === "ChatMessageAppended") received.push(event);
      },
    );
    try {
      await inbound(desk, "ready");
      await outbound(desk, "thanks");
    } finally {
      unsubscribe();
    }

    expect(received).toHaveLength(2);
    expect(received.every((e) => e.projectId === desk.session.projectId)).toBe(true);
    const bodies = received.map((e) => (e.payload as { body: string }).body);
    expect(bodies).toEqual(["ready", "thanks"]);
  });

  it("does not publish a duplicate reply", async () => {
    const desk = await makeDesk();
    const turnId = randomUUID();
    const received: StoredEventRow[] = [];
    const unsubscribe = subscribe(
      { sessionId: desk.session.claudeSessionId as string },
      (event) => {
        if (event.type === "ChatMessageAppended") received.push(event);
      },
    );
    try {
      await inbound(desk, "ready", turnId);
      await inbound(desk, "ready", turnId);
    } finally {
      unsubscribe();
    }
    expect(received).toHaveLength(1);
  });
});

// --- Orphans -------------------------------------------------------------------

describe("orphaned replies", () => {
  it("stores a reply that matches no desk, payload intact", async () => {
    // "Never dropped, never crashed on." The event row already holds the
    // payload; this table is what makes the question "what has the
    // orchestrator failed to attribute" answerable.
    const projectId = await makeProject();
    const claudeSessionId = randomUUID();
    const payload = {
      session_id: claudeSessionId,
      hook_event_name: "Stop",
      last_assistant_message: "nobody owns me",
      stop_hook_active: false,
    };
    const { rows } = await pool.query<{ id: string }>(
      `insert into events (session_id, type, payload, project_id)
       values ($1, 'Stop', $2::jsonb, $3) returning id`,
      [claudeSessionId, JSON.stringify(payload), projectId],
    );
    const eventId = (rows[0] as { id: string }).id;

    const stored = await recordOrphanedReply({
      eventId,
      claudeSessionId,
      payload,
      body: "nobody owns me",
      reason: "no session row matches this claude session id",
    });
    expect(stored?.body).toBe("nobody owns me");

    const mine = (await listOrphanedReplies(500)).filter(
      (row) => row.claudeSessionId === claudeSessionId,
    );
    expect(mine).toHaveLength(1);

    const check = await pool.query<{ payload: { last_assistant_message: string } }>(
      `select payload from orphaned_replies where id = $1`,
      [stored?.id],
    );
    expect(check.rows[0]?.payload.last_assistant_message).toBe("nobody owns me");
  });

  it("does not throw when the event it refers to is gone", async () => {
    // The orphan path is the last line of defence; it must not be the thing
    // that throws. The payload survives in `events` regardless.
    const result = await recordOrphanedReply({
      eventId: randomUUID(),
      claudeSessionId: randomUUID(),
      payload: { hook_event_name: "Stop" },
      body: null,
      reason: "deliberately dangling event id",
    });
    expect(result).toBeNull();
  });
});

// --- The transcript FILE is never read ------------------------------------------

describe("nothing in this feature reads a Claude transcript file", () => {
  // The design is explicit: the transcript file is written asynchronously and
  // may lag, so `last_assistant_message` from the Stop payload is the source.
  // The temptation is real and sits right there — every Stop payload carries a
  // `transcript_path`, and reading it would look like the richer option while
  // producing a chat panel that is intermittently a turn behind for reasons
  // nobody could reproduce.
  //
  // Asserted structurally because there is no behaviour to assert: the
  // criterion is about what the code does NOT do, and the only way that stays
  // true is a test that fails when someone adds the import.
  it("imports no filesystem module, and never touches payload.transcript_path", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const nodePath = await import("node:path");
    const root = nodePath.join(
      nodePath.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, "")),
    );

    const sources: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = nodePath.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
          sources.push(full);
        }
      }
    };
    await walk(root);

    // Sanity: the walk found the feature, so a passing assertion is not an
    // empty loop. transcript.ts, conversations.ts, handlers/reply.ts and
    // routes/chat.ts are the four this ticket ships.
    expect(sources.length).toBeGreaterThanOrEqual(4);

    for (const file of sources) {
      const text = await readFile(file, "utf8");
      const name = nodePath.basename(file);
      expect(text, `${name} must not import a filesystem module`).not.toMatch(
        /from "node:fs(\/promises)?"/,
      );
      expect(text, `${name} must not read the transcript file`).not.toMatch(/transcript_path/);
      expect(text, `${name} must not read a .jsonl transcript`).not.toMatch(/\.jsonl/);
    }
  });
});
