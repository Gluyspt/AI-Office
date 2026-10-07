// The Stop handler and the turn-end watchdog, driven through ingest.
//
// Payloads go in through `ingestHookPayload` rather than by calling
// `handle()` directly, on purpose: that exercises the whole path a real hook
// takes — validate, persist, publish, dispatch — and therefore also proves
// the convention this ticket relies on, that adding a file under
// features/chat/handlers/ needs no edit to ingest or the dispatcher.
//
// The payload shapes below are copied from the captured ones in
// docs/spikes/001-hook-payloads.md §5. Nothing here is invented: `Stop`
// carries `stop_hook_active` and `last_assistant_message`; `StopFailure`
// carries a short `error` code and `last_assistant_message` holding the
// ERROR BANNER, which is the trap this handler exists to avoid.
//
// EVERY ASSERTION IS SCOPED TO THIS FILE'S OWN ROWS, by conversation id or
// by claude session id. A `count(*)` over `events` is the bug ticket 008
// shipped and its own test caught.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionRecord } from "@office/shared/sessions";
import type { ProjectId } from "@office/shared/ids";
import { pool } from "../../../core/db/pool.ts";
import { ingestHookPayload } from "../../events/ingest.ts";
import { SESSION_COLUMNS, sessionRowToRecord } from "../../orchestrator/sessions.ts";
import {
  conversationSubjectForSession,
  findConversationBySubject,
  listSegments,
} from "../conversations.ts";
import { listOrphanedReplies, readAllMessages } from "../transcript.ts";
import {
  __resetWatchdogForTests,
  __setWatchdogWindowForTests,
  armedTurnCount,
} from "./reply.ts";

const createdProjects: string[] = [];

beforeEach(() => {
  __resetWatchdogForTests();
  // Off by default, so an ingested UserPromptSubmit in a test that is not
  // about the watchdog cannot leave a timer running into the next one.
  __setWatchdogWindowForTests(null);
});

afterEach(() => {
  __resetWatchdogForTests();
});

afterAll(async () => {
  __resetWatchdogForTests();
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

/** The captured Stop envelope, with the fields a test varies. */
function stopPayload(
  claudeSessionId: string,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    session_id: claudeSessionId,
    transcript_path: `/home/agent1/.claude/projects/x/${claudeSessionId}.jsonl`,
    cwd: "/home/agent1/project",
    scratchpad_dir: "/tmp/claude-1000/x/scratchpad",
    prompt_id: randomUUID(),
    permission_mode: "auto",
    effort: { level: "high" },
    hook_event_name: "Stop",
    stop_hook_active: false,
    last_assistant_message: "ready",
    background_tasks: [],
    session_crons: [],
    ...overrides,
  });
}

async function conversationOf(session: SessionRecord): Promise<string> {
  const conversation = await findConversationBySubject(conversationSubjectForSession(session));
  if (!conversation) throw new Error("the handler did not create a conversation");
  return conversation.id;
}

describe("Stop -> the transcript", () => {
  it("appends exactly one inbound message carrying the reply verbatim", async () => {
    const projectId = await makeProject();
    const session = await makeSession(projectId);
    const reply = "  ready\n\nand here is the detail  ";

    await ingestHookPayload(
      stopPayload(session.claudeSessionId as string, { last_assistant_message: reply }),
    );

    const conversationId = await conversationOf(session);
    const messages = await readAllMessages(conversationId);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.direction).toBe("inbound");
    // Verbatim is an acceptance criterion: no trimming, no decoration.
    expect(messages[0]?.body).toBe(reply);
    expect(messages[0]?.author).toBe("agent:dept_lead:dev");
    expect(messages[0]?.sessionId).toBe(session.id);

    // Attributed to the right segment, and the segment was opened by this
    // Stop because nothing else had spoken for the desk yet.
    const segments = await listSegments(conversationId);
    expect(segments).toHaveLength(1);
    expect(messages[0]?.segmentId).toBe(segments[0]?.id);
  });

  it("ignores StopFailure, whose last_assistant_message is an error banner", async () => {
    // THE single most likely way to get this ticket subtly wrong. The
    // handler is keyed on the event type by the loader, so a StopFailure
    // never reaches it — and this asserts that from the outside, through
    // ingest, rather than trusting the registration.
    const projectId = await makeProject();
    const session = await makeSession(projectId);

    await ingestHookPayload(
      JSON.stringify({
        session_id: session.claudeSessionId,
        transcript_path: "/home/agent1/.claude/projects/x/y.jsonl",
        cwd: "/home/agent1/project",
        prompt_id: randomUUID(),
        effort: { level: "high" },
        hook_event_name: "StopFailure",
        error: "authentication_failed",
        last_assistant_message:
          "Failed to authenticate. API Error: 401 OAuth access token is invalid.",
      }),
    );

    // No conversation, no segment, no message: nothing about a failed turn
    // belongs in the transcript as agent speech.
    const conversation = await findConversationBySubject(
      conversationSubjectForSession(session),
    );
    expect(conversation).toBeNull();
  });

  it("appends nothing when the turn produced no assistant text", async () => {
    // A turn that halts AT a tool call fires no Stop at all; the reachable
    // shapes are an absent field and a blank one. Either way an empty bubble
    // would be a lie about what happened.
    const projectId = await makeProject();
    const session = await makeSession(projectId);

    await ingestHookPayload(
      stopPayload(session.claudeSessionId as string, { last_assistant_message: undefined }),
    );
    await ingestHookPayload(
      stopPayload(session.claudeSessionId as string, { last_assistant_message: "   \n " }),
    );

    const conversationId = await conversationOf(session);
    expect(await readAllMessages(conversationId)).toHaveLength(0);
    // The segment IS opened, though: the desk is live and the panel needs to
    // be able to say so.
    expect(await listSegments(conversationId)).toHaveLength(1);
  });

  it("appends one message, not two, for a replayed Stop", async () => {
    const projectId = await makeProject();
    const session = await makeSession(projectId);
    const payload = stopPayload(session.claudeSessionId as string);

    await ingestHookPayload(payload);
    await ingestHookPayload(payload);

    expect(await readAllMessages(await conversationOf(session))).toHaveLength(1);
  });

  it("opens a second segment when the id rotated, keeping one conversation", async () => {
    const projectId = await makeProject();
    const session = await makeSession(projectId);
    await ingestHookPayload(stopPayload(session.claudeSessionId as string));

    // `/clear`: the claude session ends and the id rotates while the agent
    // keeps working. 008 moves the registry row's current id; this asserts
    // the transcript treats it as a boundary, not a new conversation.
    const rotated = randomUUID();
    await pool.query(`update sessions set claude_session_id = $2 where id = $1`, [
      session.id,
      rotated,
    ]);
    await ingestHookPayload(
      stopPayload(rotated, { last_assistant_message: "after the clear", source: "clear" }),
    );

    const conversationId = await conversationOf(session);
    const segments = await listSegments(conversationId);
    expect(segments.map((s) => s.ordinal)).toEqual([1, 2]);
    expect(segments[0]?.endReason).toBe("cleared");
    expect(segments[1]?.startReason).toBe("cleared");

    const messages = await readAllMessages(conversationId);
    expect(messages.map((m) => m.body)).toEqual(["ready", "after the clear"]);
    // One continuous history for the human; two contexts for the agent.
    expect(messages[0]?.segmentId).not.toBe(messages[1]?.segmentId);
  });
});

describe("Stop that cannot be correlated", () => {
  it("stores an unknown session's reply as orphaned, with its payload", async () => {
    const stranger = randomUUID();
    await ingestHookPayload(
      stopPayload(stranger, { last_assistant_message: "nobody owns me" }),
    );

    const mine = (await listOrphanedReplies(500)).filter(
      (row) => row.claudeSessionId === stranger,
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]?.body).toBe("nobody owns me");
    expect(mine[0]?.reason).toContain("no session row");

    const stored = await pool.query<{ payload: { last_assistant_message: string } }>(
      `select payload from orphaned_replies where id = $1`,
      [mine[0]?.id],
    );
    expect(stored.rows[0]?.payload.last_assistant_message).toBe("nobody owns me");
  });

  it("stores a Stop with no usable session_id rather than crashing", async () => {
    // Ingest stores a payload whose session_id is not a UUID with
    // session_id NULL (see validateHookBody). The handler must keep it.
    const marker = `t010-no-session-${randomUUID()}`;
    await ingestHookPayload(
      JSON.stringify({
        hook_event_name: "Stop",
        session_id: "not-a-uuid",
        stop_hook_active: false,
        last_assistant_message: marker,
      }),
    );
    const mine = (await listOrphanedReplies(500)).filter((row) => row.body === marker);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.claudeSessionId).toBeNull();
  });
});

describe("the turn-end watchdog", () => {
  function promptPayload(claudeSessionId: string, prompt: string): string {
    return JSON.stringify({
      session_id: claudeSessionId,
      transcript_path: "/home/agent1/.claude/projects/x/y.jsonl",
      cwd: "/home/agent1/project",
      prompt_id: randomUUID(),
      permission_mode: "default",
      hook_event_name: "UserPromptSubmit",
      prompt,
    });
  }

  async function abandonedEventsFor(claudeSessionId: string): Promise<
    readonly { payload: Record<string, unknown> }[]
  > {
    const { rows } = await pool.query<{ payload: Record<string, unknown> }>(
      `select payload from events
        where type = 'AgentTurnAbandoned' and session_id = $1
        order by received_at`,
      [claudeSessionId],
    );
    return rows;
  }

  // The predicate may be async: some of these poll the database, which is
  // the only place the fact being waited on actually lives.
  function waitFor(
    predicate: () => boolean | Promise<boolean>,
    timeoutMs = 2000,
  ): Promise<void> {
    // Polls rather than asserting a fixed delay. The target host's wall
    // clock steps backwards, so a test that waits exactly N ms and then
    // asserts is measuring the clock as much as the code.
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const tick = (): void => {
        void Promise.resolve(predicate()).then((met) => {
          if (met) return resolve();
          if (Date.now() > deadline) return reject(new Error("timed out waiting"));
          setTimeout(tick, 10);
        }, reject);
      };
      tick();
    });
  }

  it("arms on UserPromptSubmit and disarms on Stop", async () => {
    __setWatchdogWindowForTests(60_000);
    const projectId = await makeProject();
    const session = await makeSession(projectId);
    const claudeSessionId = session.claudeSessionId as string;

    await ingestHookPayload(promptPayload(claudeSessionId, "reply with the word ready"));
    expect(armedTurnCount()).toBe(1);

    await ingestHookPayload(stopPayload(claudeSessionId));
    expect(armedTurnCount()).toBe(0);
    expect(await abandonedEventsFor(claudeSessionId)).toHaveLength(0);
  });

  it("disarms on StopFailure too, so a failed turn is not reported as abandoned", async () => {
    __setWatchdogWindowForTests(60_000);
    const projectId = await makeProject();
    const session = await makeSession(projectId);
    const claudeSessionId = session.claudeSessionId as string;

    await ingestHookPayload(promptPayload(claudeSessionId, "do something"));
    await ingestHookPayload(
      JSON.stringify({
        session_id: claudeSessionId,
        hook_event_name: "StopFailure",
        error: "authentication_failed",
        last_assistant_message: "Failed to authenticate.",
      }),
    );
    expect(armedTurnCount()).toBe(0);
  });

  it("fires when a turn ends with no turn-end event at all", async () => {
    // The measured case this exists for: an Escape interrupt (and a
    // PreToolUse answered continue:false) fires NEITHER Stop NOR
    // StopFailure. The only event for the turn is its UserPromptSubmit.
    __setWatchdogWindowForTests(25);
    const projectId = await makeProject();
    const session = await makeSession(projectId);
    const claudeSessionId = session.claudeSessionId as string;

    await ingestHookPayload(promptPayload(claudeSessionId, "a long generation"));
    await waitFor(async () => armedTurnCount() === 0);
    await waitFor(async () => (await abandonedEventsFor(claudeSessionId)).length > 0).catch(
      () => undefined,
    );

    const events = await abandonedEventsFor(claudeSessionId);
    expect(events).toHaveLength(1);
    const payload = events[0]?.payload as Record<string, unknown>;
    expect(payload.session_id).toBe(session.id);
    expect(payload.machine_initiated).toBe(false);
    // A duration measured with performance.now(), which cannot go
    // backwards — unlike this host's wall clock, which was observed doing
    // exactly that twice in one session.
    expect(typeof payload.waited_ms).toBe("number");
    expect(payload.waited_ms as number).toBeGreaterThanOrEqual(0);

    // And it appends NOTHING: a turn that vanished produced no assistant
    // text, and a "(no reply)" line would be the empty bubble criterion 11
    // forbids.
    const conversation = await findConversationBySubject(
      conversationSubjectForSession(session),
    );
    if (conversation) {
      expect(await readAllMessages(conversation.id)).toHaveLength(0);
    }
  });

  it("labels a turn the orchestrator did not start as machine-initiated", async () => {
    // A finished subagent or background task is injected back into the
    // session AS A NEW USER PROMPT. The watchdog still watches it — the turn
    // is real — but the UI must not tell a human "you asked and got
    // nothing" when nobody asked.
    __setWatchdogWindowForTests(25);
    const projectId = await makeProject();
    const session = await makeSession(projectId);
    const claudeSessionId = session.claudeSessionId as string;

    await ingestHookPayload(
      promptPayload(
        claudeSessionId,
        '<agent-message from="ac051d3d">\n[Subagent hand-back] …\n  PONG\n</agent-message>',
      ),
    );
    await waitFor(async () => (await abandonedEventsFor(claudeSessionId)).length > 0).catch(
      () => undefined,
    );
    const events = await abandonedEventsFor(claudeSessionId);
    expect(events).toHaveLength(1);
    expect((events[0]?.payload as Record<string, unknown>).machine_initiated).toBe(true);
  });

  it("re-arms rather than stacking when a second prompt lands mid-turn", async () => {
    __setWatchdogWindowForTests(60_000);
    const projectId = await makeProject();
    const session = await makeSession(projectId);
    const claudeSessionId = session.claudeSessionId as string;

    await ingestHookPayload(promptPayload(claudeSessionId, "first"));
    await ingestHookPayload(promptPayload(claudeSessionId, "second"));
    // One desk, one running turn. The mid-turn message case ticket 008's
    // queue exists for must not produce two timers for one desk.
    expect(armedTurnCount()).toBe(1);
  });

  it("stays off, without throwing, when the window is unconfigured", async () => {
    // Reached from inside a bus listener on the ingest path. Throwing there
    // would make ticket 006's bus REMOVE the subscriber, silently disabling
    // the watchdog — the exact failure shape this system keeps trying to
    // avoid. It complains once instead.
    __setWatchdogWindowForTests(null);
    const projectId = await makeProject();
    const session = await makeSession(projectId);
    await ingestHookPayload(
      promptPayload(session.claudeSessionId as string, "nothing is watching"),
    );
    expect(armedTurnCount()).toBe(0);
  });
});
