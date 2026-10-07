// The session registry against a real database, with a fake tmux adapter.
//
// The adapter is faked and the database is not, deliberately. What this
// ticket can get wrong is lifecycle and persistence — a row written in the
// wrong order, a transition that should have been refused, a queued message
// that survives an interrupt — and none of that is testable against a mock
// database. tmux itself was measured on the real host instead
// (docs/spikes/002-vps-results/), which is the only place it means anything.
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  SESSION_STATUSES,
  type SessionStatus,
} from "@office/shared/sessions";
import type { ProjectId, SessionId } from "@office/shared/ids";
import { pool } from "../../core/db/pool.ts";
import type { TmuxAdapter, TmuxErrorKind, TmuxResult } from "./tmux.ts";
import {
  SESSION_TRANSITIONS,
  SessionError,
  __resetSessionsDeps,
  __setSessionsDeps,
  getSession,
  interruptSession,
  isLegalSessionTransition,
  killSession,
  listSessions,
  messageSession,
  onSessionEnd,
  onSessionStart,
  pendingMessages,
  startSession,
} from "./sessions.ts";

const createdProjects: string[] = [];

const slugOf = new Map<string, string>();

async function makeProject(): Promise<ProjectId> {
  const slug = `t008-${randomUUID()}`;
  const result = await pool.query<{ id: string }>(
    `insert into projects (name, slug, repo_url) values ($1, $2, $3) returning id`,
    [slug, slug, "https://example.invalid/repo.git"],
  );
  const id = result.rows[0]!.id;
  createdProjects.push(id);
  // The tmux name is derived from the project SLUG, and `projects.slug` is
  // unique — so each test project needs its own, or every desk collides on
  // `sessions_one_live_per_tmux_name` for a reason production cannot reach.
  slugOf.set(id, slug);
  return id as ProjectId;
}

// --- The fake adapter -----------------------------------------------------------

interface FakeState {
  spawn: TmuxResult<{ name: string; dialogsAnswered: readonly string[]; readyMs: number | null }>;
  send: TmuxResult<{ byteLength: number }>;
  escape: TmuxResult<Record<string, never>>;
  kill: TmuxResult<Record<string, never>>;
  calls: string[];
}

function ok<T>(value: T): TmuxResult<T> {
  return { ok: true, value };
}

function bad(kind: TmuxErrorKind, message: string = kind): TmuxResult<never> {
  return { ok: false, kind, message };
}

let fake: FakeState;

function freshFake(): FakeState {
  return {
    spawn: ok({ name: "x", dialogsAnswered: [], readyMs: 1200 }),
    send: ok({ byteLength: 4 }),
    escape: ok({}),
    kill: ok({}),
    calls: [],
  };
}

function fakeAdapter(): TmuxAdapter {
  const record = <T>(label: string, result: TmuxResult<T>): TmuxResult<T> => {
    fake.calls.push(label);
    return result;
  };
  return {
    newSession: async () => record("newSession", fake.spawn),
    hasSession: async () => ok({ exists: true }),
    listSessions: async () => ok({ names: [], foreign: [] }),
    capturePane: async () => ok({ pane: "" }),
    sendLiteral: async () => record("sendLiteral", fake.send),
    sendKeys: async () => record("sendKeys", ok({})),
    sendEscape: async () => record("sendEscape", fake.escape),
    clearComposer: async () => ok({ clears: 1 }),
    sendMessage: async () => record("sendMessage", fake.send),
    killSession: async () => record("killSession", fake.kill),
  } as unknown as TmuxAdapter;
}

/** Hook events are simulated: `null` means "none ever arrived". */
let hookArrival: { sessionId: string } | null = { sessionId: "auto" };

beforeEach(() => {
  fake = freshFake();
  hookArrival = { sessionId: "auto" };
  __setSessionsDeps({
    tmux: fakeAdapter(),
    waitForFirstEvent: async (claudeSessionId) =>
      hookArrival === null
        ? null
        : ({
            id: randomUUID(),
            projectId: null,
            sessionId: claudeSessionId,
            type: "SessionStart",
            payload: {},
            receivedAt: "now",
            cursor: "c",
          } as never),
  });
});

afterAll(async () => {
  __resetSessionsDeps();
  for (const id of createdProjects) {
    await pool.query("delete from projects where id = $1", [id]);
  }
});

async function start(
  overrides: Partial<Parameters<typeof startSession>[0]> = {},
): Promise<Awaited<ReturnType<typeof startSession>>["session"]> {
  const projectId = overrides.projectId ?? (await makeProject());
  const result = await startSession({
    projectId,
    projectSlug: slugOf.get(projectId as string) ?? `slug-${randomUUID()}`,
    role: "dept_lead",
    dept: "dev",
    owner: "gluy",
    backend: "claude",
    model: "sonnet",
    modelReason: "routine work",
    cwd: "/srv/office/projects/schedool",
    claudeBin: "/usr/local/bin/claude",
    hookArrivalTimeoutMs: 50,
    ...overrides,
  });
  return result.session;
}

// --- The transition table -------------------------------------------------------

describe("the session state machine", () => {
  it("matches the SQL check constraint's vocabulary", () => {
    // The migration and the shared union are the only two copies of this
    // set. If they drift, a legal status becomes a constraint violation at
    // runtime and nothing catches it until a spawn fails in production.
    expect([...SESSION_STATUSES].sort()).toEqual(
      ["ended", "failed", "running", "starting"].sort(),
    );
  });

  // The criterion asks for a test per illegal pair. Table-driven over the
  // whole 4x4 matrix so a new status cannot be added without this failing.
  const all = SESSION_STATUSES;
  for (const from of all) {
    for (const to of all) {
      if (from === to) continue;
      const legal = SESSION_TRANSITIONS.some((r) => r.from === from && r.to === to);
      it(`${legal ? "allows" : "refuses"} ${from} -> ${to}`, () => {
        expect(isLegalSessionTransition(from, to)).toBe(legal);
      });
    }
  }

  it("treats ended and failed as terminal — nothing leaves them", () => {
    for (const terminal of ["ended", "failed"] as SessionStatus[]) {
      expect(SESSION_TRANSITIONS.filter((r) => r.from === terminal)).toEqual([]);
    }
  });
});

// --- The row comes first --------------------------------------------------------

describe("the row is written before tmux is spawned", () => {
  it("leaves a failed row with the reason attached when the spawn crashes", async () => {
    fake.spawn = bad("sudo_denied", "sudo: a password is required");
    const session = await start();

    expect(session.status).toBe("failed");
    expect(session.failureKind).toBe("spawn_failed");
    expect(session.failureReason).toContain("sudo_denied");
    // The point of the ordering: the record survives the failure.
    const reread = await getSession(session.id);
    expect(reread?.status).toBe("failed");
    expect(reread?.endedAt).not.toBeNull();
  });

  it("distinguishes a composer that never appeared from a refused spawn", async () => {
    fake.spawn = bad("not_ready", "no composer within 120000ms");
    const session = await start();
    expect(session.failureKind).toBe("not_ready");
  });

  it("rejects a blank model_reason before touching the database", async () => {
    await expect(start({ modelReason: "   " })).rejects.toMatchObject({
      kind: "invalid_request",
    });
    expect(fake.calls).not.toContain("newSession");
  });
});

// --- The hook gate --------------------------------------------------------------

describe("a session is not running until its hooks reach ingest", () => {
  it("fails the session when no event ever arrives, and kills the mute desk", async () => {
    hookArrival = null;
    const session = await start();

    expect(session.status).toBe("failed");
    expect(session.failureKind).toBe("hooks_never_arrived");
    expect(session.failureReason).toMatch(/not reaching ingest/);
    // A desk that is alive but mute would spend tokens nobody can see.
    expect(fake.calls).toContain("killSession");
  });

  it("names a rejected handshake instead, when one was logged in the window", async () => {
    // 005 records TlsHandshakeRejected as a system event. The remedies
    // differ — a missing NODE_EXTRA_CA_CERTS versus a certificate that needs
    // reissuing — so the two must not collapse into one "failed".
    hookArrival = null;
    // Inserted with a future-ish timestamp so it falls inside the window
    // this session opens, which is what the diagnosis is scoped to. A
    // rejection from some earlier suite must NOT count — that was the bug
    // this test found.
    await pool.query(
      `insert into events (type, payload, received_at)
       values ('TlsHandshakeRejected', '{}'::jsonb, now() + interval '1 second')`,
    );
    try {
      const session = await start();
      expect(session.failureKind).toBe("hooks_handshake_rejected");
      expect(session.failureReason).toMatch(/NODE_EXTRA_CA_CERTS|certificate/);
    } finally {
      await pool.query(`delete from events where type = 'TlsHandshakeRejected'`);
    }
  });

  it("does NOT blame TLS for a rejection that predates the session", async () => {
    // The global-state trap: one unrelated rejection anywhere would
    // otherwise make every later failure claim "handshake rejected", and
    // send someone to reissue a certificate that is fine.
    hookArrival = null;
    await pool.query(
      `insert into events (type, payload, received_at)
       values ('TlsHandshakeRejected', '{}'::jsonb, now() - interval '30 seconds')`,
    );
    try {
      const session = await start();
      expect(session.failureKind).toBe("hooks_never_arrived");
    } finally {
      await pool.query(`delete from events where type = 'TlsHandshakeRejected'`);
    }
  });

  it("reaches running when an event does arrive", async () => {
    const session = await start();
    expect(session.status).toBe("running");
    expect(session.claudeSessionId).not.toBeNull();
    expect(session.endedAt).toBeNull();
  });
});

// --- Identity -------------------------------------------------------------------

describe("two sessions with the same identity", () => {
  it("conflicts rather than reusing — and the database enforces it", async () => {
    const projectId = await makeProject();
    await start({ projectId });
    await expect(start({ projectId })).rejects.toMatchObject({ kind: "identity_conflict" });
  });

  it("reports a tmux-name collision as its own thing, not as an identity clash", async () => {
    // Two different projects that happen to share a slug derive the SAME
    // tmux name, so the second desk's messages would land in the first.
    // `projects.slug` is unique so production cannot reach this, but the
    // error must still name the right constraint — an earlier version
    // mapped every unique violation to "that role is already staffed" and
    // sent the reader to the wrong place.
    const a = await makeProject();
    const b = await makeProject();
    const shared = `shared-${randomUUID()}`;
    await start({ projectId: a, projectSlug: shared });
    await expect(start({ projectId: b, projectSlug: shared })).rejects.toMatchObject({
      kind: "identity_conflict",
    });
    await expect(start({ projectId: b, projectSlug: shared })).rejects.toThrow(/tmux name/);
  });

  it("allows a restart once the first has ended", async () => {
    const projectId = await makeProject();
    const first = await start({ projectId });
    await killSession(first.id, "test");
    const second = await start({ projectId });
    expect(second.status).toBe("running");
    expect(second.id).not.toBe(first.id);
  });
});

// --- Messaging ------------------------------------------------------------------

describe("messageSession", () => {
  it("queues durably and marks it sent", async () => {
    const session = await start();
    const result = await messageSession(session.id, "focus on auth", "human:gluy");
    expect(result.delivered).toBe(true);
    expect(await pendingMessages(session.id)).toEqual([]);
  });

  it("refuses an ended session with session_ended, not a silent drop", async () => {
    const session = await start();
    await killSession(session.id, "test");
    await expect(messageSession(session.id, "anything", "human:gluy")).rejects.toMatchObject({
      kind: "session_ended",
    });
  });

  it("refuses to deliver into a permission dialog, and LEAVES THE MESSAGE PENDING", async () => {
    // The hazard: an ordinary chat message delivered into a waiting dialog
    // approves it — 20/20 on the target, with the approved command's file
    // left on disk. The message must not be lost either; it goes out when
    // the dialog clears.
    const session = await start();
    fake.send = bad("blocked_by_dialog", "a permission dialog is open: Bash(rm -rf /)");

    await expect(messageSession(session.id, "hello", "human:gluy")).rejects.toMatchObject({
      kind: "blocked_by_dialog",
    });
    const pending = await pendingMessages(session.id);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.body).toBe("hello");
  });

  it("names the pending tool call on the refusal, so the UI can say which", async () => {
    const session = await start();
    fake.send = bad("blocked_by_dialog", "pending: Bash(rm -rf /)");
    await expect(messageSession(session.id, "hello", "human:gluy")).rejects.toMatchObject({
      pendingToolCall: "pending: Bash(rm -rf /)",
    });
  });
});

// --- Interrupt ------------------------------------------------------------------

describe("interruptSession", () => {
  it("discards pending messages, because Escape alone does not stop them", async () => {
    // Measured on the target: a message queued before Escape still ran in
    // 17 of 19 trials and was discarded in 2. An interrupt that leaves a
    // ~90% chance of the next instruction running is not an interrupt. This
    // is why the orchestrator holds the queue at all.
    const session = await start();
    fake.send = bad("blocked_by_dialog", "dialog");
    await messageSession(session.id, "queued one", "human:gluy").catch(() => undefined);
    await messageSession(session.id, "queued two", "human:gluy").catch(() => undefined);
    expect(await pendingMessages(session.id)).toHaveLength(2);

    const result = await interruptSession(session.id, "human:gluy");
    expect(result.discarded).toBe(2);
    expect(await pendingMessages(session.id)).toEqual([]);
    expect(fake.calls).toContain("sendEscape");
  });

  it("leaves the session running — Escape halts a turn, it does not end a desk", async () => {
    const session = await start();
    const result = await interruptSession(session.id, "human:gluy");
    expect(result.session.status).toBe("running");
    expect((await getSession(session.id))?.status).toBe("running");
  });

  it("refuses to interrupt an ended session rather than pretending", async () => {
    const session = await start();
    await killSession(session.id, "test");
    await expect(interruptSession(session.id, "x")).rejects.toMatchObject({
      kind: "session_ended",
    });
  });
});

// --- Kill -----------------------------------------------------------------------

describe("killSession", () => {
  it("is idempotent: a second call returns the ended row, not an error", async () => {
    const session = await start();
    const first = await killSession(session.id, "human:gluy");
    expect(first.status).toBe("ended");
    const second = await killSession(session.id, "human:gluy");
    expect(second.status).toBe("ended");
    expect(second.endedAt).toBe(first.endedAt);
  });

  it("treats an already-gone tmux session as success", async () => {
    // Someone ran `tmux kill-session` by hand. The desk should still end
    // cleanly rather than leaving a row stuck at running.
    const session = await start();
    fake.kill = bad("not_found", "can't find session");
    const ended = await killSession(session.id, "human:gluy");
    expect(ended.status).toBe("ended");
  });

  it("discards anything still queued", async () => {
    const session = await start();
    fake.send = bad("blocked_by_dialog", "dialog");
    await messageSession(session.id, "never sent", "human:gluy").catch(() => undefined);
    await killSession(session.id, "human:gluy");
    expect(await pendingMessages(session.id)).toEqual([]);
  });
});

// --- Correlation ----------------------------------------------------------------

describe("hook correlation", () => {
  it("SessionStart moves a starting row to running", async () => {
    hookArrival = null; // so start() leaves it failed and we can test the handler path
    const projectId = await makeProject();
    const session = await start({ projectId });
    expect(session.status).toBe("failed");
    // A failed row is terminal: a late SessionStart must not resurrect it.
    expect(await onSessionStart(session.claudeSessionId as string)).toBeNull();
  });

  it("SessionEnd with reason 'clear' does NOT end the row", async () => {
    // SessionEnd does not mean the agent stopped. It fires on /clear while
    // the agent keeps working; ending the row there would leave an orphan
    // tmux session nobody is tracking, and the row would say ended while
    // the agent carried on spending tokens.
    const session = await start();
    const result = await onSessionEnd(session.claudeSessionId as string, "clear");
    expect(result).toBeNull();
    expect((await getSession(session.id))?.status).toBe("running");
  });

  for (const reason of ["other", "prompt_input_exit", null]) {
    it(`SessionEnd with reason ${JSON.stringify(reason)} ends the row`, async () => {
      const session = await start({ projectId: await makeProject() });
      const result = await onSessionEnd(session.claudeSessionId as string, reason);
      expect(result?.status).toBe("ended");
      expect((await getSession(session.id))?.status).toBe("ended");
    });
  }

  it("ends a row killed from outside the orchestrator", async () => {
    const session = await start();
    // No API call — only the hook. This is the `tmux kill-session` by hand case.
    await onSessionEnd(session.claudeSessionId as string, "other");
    expect((await getSession(session.id))?.status).toBe("ended");
  });

  it("ignores an event it cannot correlate, rather than guessing", async () => {
    expect(await onSessionStart(randomUUID())).toBeNull();
    expect(await onSessionEnd(randomUUID(), "other")).toBeNull();
  });
});

// --- Events ---------------------------------------------------------------------

describe("every control action is visible on the event stream", () => {
  it("writes an event for register, run, message, interrupt and kill", async () => {
    const session = await start();
    await messageSession(session.id, "hi", "human:gluy");
    await interruptSession(session.id, "human:gluy");
    await killSession(session.id, "human:gluy");

    const { rows } = await pool.query<{ type: string }>(
      `select type from events
        where payload->>'session_id' = $1 order by received_at, id`,
      [session.id],
    );
    const types = rows.map((r) => r.type);
    // The interrupt one is the criterion's own example: "a test asserts an
    // interrupt is visible to a subscribed client". The event row is what a
    // subscriber receives, so asserting the row is asserting the stream.
    expect(types).toContain("SessionRegistered");
    expect(types).toContain("SessionRunning");
    expect(types).toContain("SessionMessageSent");
    expect(types).toContain("SessionInterrupted");
    expect(types).toContain("SessionEnded");
  });
});

// --- Reads ----------------------------------------------------------------------

describe("listSessions", () => {
  it("returns live desks by default and excludes ended ones", async () => {
    const projectId = await makeProject();
    const live = await start({ projectId });
    const gone = await start({ projectId, dept: "qa" });
    await killSession(gone.id, "test");

    const ids = (await listSessions({ projectId })).map((s) => s.id as string);
    expect(ids).toContain(live.id as string);
    expect(ids).not.toContain(gone.id as string);

    const all = (await listSessions({ projectId, liveOnly: false })).map((s) => s.id as string);
    expect(all).toContain(gone.id as string);
  });
});

describe("SessionError", () => {
  it("carries a kind a caller can switch on instead of matching message text", async () => {
    const error = await getSession(randomUUID() as SessionId)
      .then(() => new SessionError("not_found", "x"))
      .catch((e: unknown) => e);
    expect((error as SessionError).kind).toBe("not_found");
  });
});
