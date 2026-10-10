// The heartbeat, driven through ingest rather than by calling handle().
//
// Going through `ingestHookPayload` is the point: it exercises the whole path
// a real hook takes — validate, persist, publish, dispatch — and therefore
// also proves 005's convention, that adding a file under
// features/locks/handlers/ needs no edit to ingest or the dispatcher. Ticket
// 015 left "what triggers a heartbeat" explicitly open and this is the answer.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { ProjectId, TaskId } from "@office/shared/ids";
import { pool } from "../../../core/db/pool.ts";
import { ingestHookPayload } from "../../events/ingest.ts";
import { createTask } from "../../tasks/model.ts";
import { insertTask } from "../../tasks/repo.ts";
import { acquireScope, expireLocks, listActiveLocks } from "../registry.ts";

const CWD = "/srv/office/projects/demo";
const createdProjects: string[] = [];

async function makeProject(): Promise<ProjectId> {
  const slug = `t020h-${randomUUID()}`;
  const { rows } = await pool.query<{ id: string }>(
    `insert into projects (name, slug, repo_url) values ($1, $2, $3) returning id`,
    [slug, slug, "https://example.invalid/repo.git"],
  );
  const id = rows[0]!.id;
  createdProjects.push(id);
  return id as ProjectId;
}

async function makeTask(projectId: ProjectId, title: string): Promise<TaskId> {
  const record = await insertTask(
    createTask({ projectId, title, department: "dev", owner: "agent1" }),
  );
  return record.id;
}

async function makeSession(projectId: ProjectId): Promise<{ rowId: string; claudeId: string }> {
  const claudeId = randomUUID();
  const { rows } = await pool.query<{ id: string }>(
    `insert into sessions
       (project_id, tmux_name, role, dept, owner, backend, model, model_reason,
        status, claude_session_id)
     values ($1, $2, 'dept_lead', 'dev', 'agent1', 'claude', 'claude-sonnet-5',
             'test fixture', 'running', $3)
     returning id`,
    [projectId, `t020h-${randomUUID()}`, claudeId],
  );
  return { rowId: rows[0]!.id, claudeId };
}

/** The captured PreToolUse payload (spike 001 §5). `Read` on purpose in one
 *  case: the heartbeat fires for read-only tools too, which is a reason it
 *  sits on PreToolUse rather than PostToolUse. */
function preToolUse(claudeId: string, toolName = "Read"): string {
  return JSON.stringify({
    session_id: claudeId,
    transcript_path: `/home/agent1/.claude/projects/x/${claudeId}.jsonl`,
    cwd: CWD,
    prompt_id: randomUUID(),
    permission_mode: "manual",
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: { file_path: `${CWD}/src/mine/a.ts` },
    tool_use_id: `toolu_${randomUUID()}`,
  });
}

/**
 * The lock's deadline, as exact text AND as a comparable epoch.
 *
 * Both, because neither alone works. `timestamptz` -> JS `Date` loses
 * microseconds, so an equality check has to be on the text — and Postgres's
 * own text rendering is `2026-10-10 21:24:12.123456+00`, whose `+00` offset
 * `new Date()` refuses to parse, so the ORDERING check has to come from a
 * number the database computed. Pushing a 5-second TTL out by a few hundred
 * microseconds is exactly the size of difference this would silently lose.
 */
async function expiryOf(taskId: TaskId): Promise<{ text: string; epoch: number }> {
  const { rows } = await pool.query<{ expires_at: string; epoch: string }>(
    `select expires_at::text as expires_at,
            extract(epoch from expires_at)::text as epoch
       from file_locks
      where task_id = $1 and released_at is null order by id limit 1`,
    [taskId],
  );
  const row = rows[0]!;
  return { text: row.expires_at, epoch: Number(row.epoch) };
}

afterAll(async () => {
  for (const id of createdProjects) {
    await pool.query("delete from projects where id = $1", [id]);
  }
});

describe("the PreToolUse heartbeat", () => {
  it("pushes out the TTL of every lock the calling session holds", async () => {
    const project = await makeProject();
    const session = await makeSession(project);
    const task = await makeTask(project, "heartbeat holder");
    await acquireScope({
      projectId: project,
      taskId: task,
      sessionId: session.rowId,
      patterns: ["src/mine/"],
      // Short, so the push is a large and unambiguous move rather than a
      // sub-millisecond one.
      ttlSeconds: 5,
    });
    const before = await expiryOf(task);

    await ingestHookPayload(preToolUse(session.claudeId));

    const after = await expiryOf(task);
    expect(after.text).not.toBe(before.text);
    expect(after.epoch).toBeGreaterThan(before.epoch);
  });

  it("keeps a lock alive across a long task even with a TTL shorter than the work", async () => {
    // The acceptance criterion, with time compressed: a 2-second TTL and four
    // tool calls spaced over ~4 seconds. Without the heartbeat the sweeper
    // reclaims the scope mid-task; with it, the lock never expires.
    const project = await makeProject();
    const session = await makeSession(project);
    const task = await makeTask(project, "long-running task");
    await acquireScope({
      projectId: project,
      taskId: task,
      sessionId: session.rowId,
      patterns: ["src/long/"],
      ttlSeconds: 2,
    });

    for (let i = 0; i < 4; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await ingestHookPayload(preToolUse(session.claudeId, "Edit"));
      // The sweeper runs on a timer in production; running it here every
      // round is the hostile version — it gets a chance to reclaim after
      // every single heartbeat.
      await expireLocks();
      const stillHeld = await listActiveLocks({ taskId: task });
      expect(stillHeld, `the lock expired after ${i + 1} heartbeat(s)`).toHaveLength(1);
    }
  }, 20_000);

  it("does nothing for a session that holds no locks, and does not throw", async () => {
    const project = await makeProject();
    const session = await makeSession(project);
    // A lead has no task and therefore no scope. This must be a no-op, not an
    // error: it runs on the hot path of every tool call of every lead.
    const stored = await ingestHookPayload(preToolUse(session.claudeId));
    expect(stored.type).toBe("PreToolUse");
  });

  it("does nothing for an unregistered session id", async () => {
    const stored = await ingestHookPayload(preToolUse(randomUUID()));
    expect(stored.type).toBe("PreToolUse");
  });

  it("refreshes a lock attributed to the CLAUDE session id as well", async () => {
    const project = await makeProject();
    const session = await makeSession(project);
    const task = await makeTask(project, "claimed under the claude id");
    await acquireScope({
      projectId: project,
      taskId: task,
      sessionId: session.claudeId,
      patterns: ["src/claude/"],
      ttlSeconds: 5,
    });
    const before = await expiryOf(task);
    await ingestHookPayload(preToolUse(session.claudeId));
    expect((await expiryOf(task)).text).not.toBe(before.text);
  });

  it("leaves a PAUSED lock's deadline alone — a paused task still owns its files", async () => {
    // The registry exempts paused locks from expiry entirely, so moving their
    // deadline would be meaningless. Asserted here because the heartbeat is
    // the only thing that would ever try.
    const project = await makeProject();
    const session = await makeSession(project);
    const task = await makeTask(project, "paused holder");
    await acquireScope({
      projectId: project,
      taskId: task,
      sessionId: session.rowId,
      patterns: ["src/paused/"],
      ttlSeconds: 5,
    });
    await pool.query(`update file_locks set paused = true where task_id = $1`, [task]);
    const before = await expiryOf(task);
    await ingestHookPayload(preToolUse(session.claudeId));
    expect((await expiryOf(task)).text).toBe(before.text);
  });
});
