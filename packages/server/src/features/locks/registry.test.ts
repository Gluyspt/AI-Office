// The registry against a real database — concurrency included, because a
// mocked concurrency test proves nothing about the thing that actually
// races.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProjectId, TaskId } from "@office/shared/ids";
import { pool } from "../../core/db/pool.ts";
import { createTask } from "../tasks/model.ts";
import { insertTask } from "../tasks/repo.ts";
import {
  acquireScope,
  expireLocks,
  heartbeat,
  listActiveLocks,
  releaseBySession,
  releaseByTask,
  setLocksPaused,
} from "./registry.ts";

const TTL = 900;
const createdProjects: string[] = [];
let projectId: ProjectId;

async function makeProject(): Promise<ProjectId> {
  const slug = `t015-${randomUUID()}`;
  const result = await pool.query<{ id: string }>(
    `insert into projects (name, slug, repo_url) values ($1, $2, $3) returning id`,
    [slug, slug, "https://example.invalid/repo.git"],
  );
  const id = result.rows[0]!.id;
  createdProjects.push(id);
  return id as ProjectId;
}

async function makeTask(project: ProjectId, title = "scope holder"): Promise<TaskId> {
  const record = await insertTask(
    createTask({ projectId: project, title, department: "dev", owner: "gluy" }),
  );
  return record.id;
}

/**
 * Drags a lock's whole lifetime into the past, so it is expired without the
 * test having to wait out a TTL.
 *
 * Both columns move, not just `expires_at`: the schema's
 * file_locks_expires_after_acquired constraint is a real invariant worth
 * keeping, and backdating only the deadline would produce a row that
 * expired before it was taken.
 */
async function expireNow(taskId: TaskId): Promise<void> {
  await pool.query(
    `update file_locks
        set acquired_at = now() - interval '2 hours',
            expires_at  = now() - interval '1 hour'
      where task_id = $1`,
    [taskId],
  );
}

beforeAll(async () => {
  projectId = await makeProject();
});

afterAll(async () => {
  for (const id of createdProjects) {
    await pool.query("delete from projects where id = $1", [id]);
  }
  await pool.query("delete from events where type in ('TaskCreated', 'FileLocksSwept')");
});

describe("acquireScope", () => {
  it("grants a disjoint scope", async () => {
    const project = await makeProject();
    const a = await makeTask(project);
    const b = await makeTask(project);
    expect((await acquireScope({ projectId: project, taskId: a, patterns: ["src/a.ts"], ttlSeconds: TTL })).ok).toBe(true);
    expect((await acquireScope({ projectId: project, taskId: b, patterns: ["src/b.ts"], ttlSeconds: TTL })).ok).toBe(true);
  });

  it("refuses an overlapping scope and names the conflicting task", async () => {
    const project = await makeProject();
    const holder = await makeTask(project, "holder");
    const other = await makeTask(project, "other");
    await acquireScope({ projectId: project, taskId: holder, patterns: ["src/"], ttlSeconds: TTL });

    const result = await acquireScope({
      projectId: project,
      taskId: other,
      patterns: ["src/deep/a.ts"],
      ttlSeconds: TTL,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.heldByTaskId).toBe(holder);
    expect(result.conflicts[0]!.heldPattern).toBe("src/");
    expect(result.conflicts[0]!.certain).toBe(true);
  });

  it("reports an unprovable glob pair as a conservative conflict", async () => {
    const project = await makeProject();
    const holder = await makeTask(project);
    const other = await makeTask(project);
    await acquireScope({ projectId: project, taskId: holder, patterns: ["src/a*.ts"], ttlSeconds: TTL });

    const result = await acquireScope({
      projectId: project,
      taskId: other,
      patterns: ["src/ab*.ts"],
      ttlSeconds: TTL,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The refusal has to admit it was conservative, or a human cannot tell
    // a demonstrated collision from an undecidable one.
    expect(result.conflicts[0]!.certain).toBe(false);
    expect(result.conflicts[0]!.reason).toMatch(/cannot prove|conservativ/i);
  });

  it("is all-or-nothing: one conflict in five acquires none", async () => {
    const project = await makeProject();
    const holder = await makeTask(project);
    const other = await makeTask(project);
    await acquireScope({ projectId: project, taskId: holder, patterns: ["src/c.ts"], ttlSeconds: TTL });

    const result = await acquireScope({
      projectId: project,
      taskId: other,
      patterns: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"],
      ttlSeconds: TTL,
    });

    expect(result.ok).toBe(false);
    expect(await listActiveLocks({ taskId: other })).toHaveLength(0);
  });

  it("lets a task re-declare its own scope without conflicting with itself", async () => {
    const project = await makeProject();
    const task = await makeTask(project);
    await acquireScope({ projectId: project, taskId: task, patterns: ["src/x.ts"], ttlSeconds: TTL });
    const again = await acquireScope({
      projectId: project,
      taskId: task,
      patterns: ["src/x.ts"],
      ttlSeconds: TTL,
    });
    expect(again.ok).toBe(true);
    expect(await listActiveLocks({ taskId: task })).toHaveLength(1);
  });

  it("scopes conflicts to a project — the same path in two projects is two files", async () => {
    const one = await makeProject();
    const two = await makeProject();
    const a = await makeTask(one);
    const b = await makeTask(two);
    expect((await acquireScope({ projectId: one, taskId: a, patterns: ["src/same.ts"], ttlSeconds: TTL })).ok).toBe(true);
    expect((await acquireScope({ projectId: two, taskId: b, patterns: ["src/same.ts"], ttlSeconds: TTL })).ok).toBe(true);
  });
});

describe("acquireScope under real concurrency", () => {
  it("lets exactly one of two overlapping acquisitions win", async () => {
    const project = await makeProject();
    const a = await makeTask(project, "racer a");
    const b = await makeTask(project, "racer b");

    // Genuinely parallel: two pool connections, two transactions, one
    // per-project advisory lock between them.
    const [first, second] = await Promise.all([
      acquireScope({ projectId: project, taskId: a, patterns: ["src/race.ts"], ttlSeconds: TTL }),
      acquireScope({ projectId: project, taskId: b, patterns: ["src/race.ts"], ttlSeconds: TTL }),
    ]);

    const winners = [first, second].filter((r) => r.ok);
    expect(winners).toHaveLength(1);
    expect(await listActiveLocks({ projectId: project })).toHaveLength(1);
  });

  it("holds for overlapping-but-different patterns, which no unique index can catch", async () => {
    const project = await makeProject();
    const a = await makeTask(project);
    const b = await makeTask(project);

    const [first, second] = await Promise.all([
      acquireScope({ projectId: project, taskId: a, patterns: ["src/"], ttlSeconds: TTL }),
      acquireScope({ projectId: project, taskId: b, patterns: ["src/nested/a.ts"], ttlSeconds: TTL }),
    ]);

    expect([first, second].filter((r) => r.ok)).toHaveLength(1);
  });
});

describe("release paths", () => {
  it("releaseByTask frees every lock the task held", async () => {
    const project = await makeProject();
    const task = await makeTask(project);
    await acquireScope({ projectId: project, taskId: task, patterns: ["src/r1.ts", "src/r2.ts"], ttlSeconds: TTL });
    expect(await releaseByTask(task)).toBe(2);
    expect(await listActiveLocks({ taskId: task })).toHaveLength(0);
  });

  it("releasing an already-released lock is idempotent", async () => {
    const project = await makeProject();
    const task = await makeTask(project);
    await acquireScope({ projectId: project, taskId: task, patterns: ["src/idem.ts"], ttlSeconds: TTL });
    await releaseByTask(task);
    const before = await pool.query<{ released_at: Date }>(
      "select released_at from file_locks where task_id = $1",
      [task],
    );
    expect(await releaseByTask(task)).toBe(0);
    const after = await pool.query<{ released_at: Date }>(
      "select released_at from file_locks where task_id = $1",
      [task],
    );
    // The original timestamp survives: the audit keeps saying when the
    // files were actually let go.
    expect(after.rows[0]!.released_at.getTime()).toBe(before.rows[0]!.released_at.getTime());
  });

  it("releaseBySession frees the session's locks — the SessionEnd path", async () => {
    const project = await makeProject();
    const task = await makeTask(project);
    const sessionId = randomUUID();
    await acquireScope({ projectId: project, taskId: task, sessionId, patterns: ["src/s1.ts"], ttlSeconds: TTL });
    expect(await releaseBySession(sessionId, "prompt_input_exit")).toBe(1);
    expect(await listActiveLocks({ taskId: task })).toHaveLength(0);
  });

  it("releaseBySession ignores reason 'clear', because the agent keeps working", async () => {
    const project = await makeProject();
    const task = await makeTask(project);
    const sessionId = randomUUID();
    await acquireScope({ projectId: project, taskId: task, sessionId, patterns: ["src/s2.ts"], ttlSeconds: TTL });
    expect(await releaseBySession(sessionId, "clear")).toBe(0);
    expect(await listActiveLocks({ taskId: task })).toHaveLength(1);
  });
});

describe("TTL, heartbeat and the sweeper", () => {
  it("a heartbeat pushes the deadline out", async () => {
    const project = await makeProject();
    const task = await makeTask(project);
    await acquireScope({ projectId: project, taskId: task, patterns: ["src/hb.ts"], ttlSeconds: 60 });
    const before = (await listActiveLocks({ taskId: task }))[0]!.expiresAt;
    expect(await heartbeat(task, 3600)).toBe(1);
    const after = (await listActiveLocks({ taskId: task }))[0]!.expiresAt;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });

  it("an expired lock stops blocking a new acquisition even before the sweeper runs", async () => {
    const project = await makeProject();
    const dead = await makeTask(project, "crashed agent");
    const fresh = await makeTask(project, "next task");
    await acquireScope({ projectId: project, taskId: dead, patterns: ["src/reclaim.ts"], ttlSeconds: TTL });
    await expireNow(dead);

    // Otherwise a crashed agent's scope stays unusable for as long as
    // nobody happens to call the sweeper.
    const result = await acquireScope({
      projectId: project,
      taskId: fresh,
      patterns: ["src/reclaim.ts"],
      ttlSeconds: TTL,
    });
    expect(result.ok).toBe(true);
  });

  it("the sweeper releases expired locks and announces the reclaim", async () => {
    const project = await makeProject();
    const task = await makeTask(project);
    await acquireScope({ projectId: project, taskId: task, patterns: ["src/sweep.ts"], ttlSeconds: TTL });
    await expireNow(task);

    const result = await expireLocks();
    expect(result.expired.some((lock) => lock.taskId === task)).toBe(true);
    expect(await listActiveLocks({ taskId: task })).toHaveLength(0);

    // A reclaimed lock means an agent lost its files without asking; that
    // has to be visible rather than inferred.
    const events = await pool.query<{ n: string }>(
      "select count(*) as n from events where type = 'FileLocksSwept'",
    );
    expect(Number(events.rows[0]!.n)).toBeGreaterThan(0);
  });

  it("paused locks are exempt from expiry and stay unreclaimable", async () => {
    const project = await makeProject();
    const paused = await makeTask(project, "paused task");
    const other = await makeTask(project, "opportunist");
    await acquireScope({ projectId: project, taskId: paused, patterns: ["src/paused.ts"], ttlSeconds: TTL });
    await setLocksPaused(paused, true);
    await expireNow(paused);

    await expireLocks();
    expect(await listActiveLocks({ taskId: paused })).toHaveLength(1);

    // A paused task still owns its files — the whole point of Pause is
    // that the work resumes on the same scope.
    const result = await acquireScope({
      projectId: project,
      taskId: other,
      patterns: ["src/paused.ts"],
      ttlSeconds: TTL,
    });
    expect(result.ok).toBe(false);
  });

  it("a heartbeat does not move a paused lock's deadline", async () => {
    const project = await makeProject();
    const task = await makeTask(project);
    await acquireScope({ projectId: project, taskId: task, patterns: ["src/ph.ts"], ttlSeconds: 60 });
    await setLocksPaused(task, true);
    expect(await heartbeat(task, 3600)).toBe(0);
  });

  it("reports no orphans while the cascade holds", async () => {
    // Defensive: on delete cascade should make this impossible. A check
    // that stays at zero is how a future schema change that drops the
    // cascade gets noticed instead of silently leaking locks.
    const result = await expireLocks();
    expect(result.orphaned).toHaveLength(0);
  });
});

describe("listActiveLocks", () => {
  it("filters by project, task and session", async () => {
    const project = await makeProject();
    const task = await makeTask(project);
    const sessionId = randomUUID();
    await acquireScope({ projectId: project, taskId: task, sessionId, patterns: ["src/f.ts"], ttlSeconds: TTL });
    expect(await listActiveLocks({ projectId: project })).toHaveLength(1);
    expect(await listActiveLocks({ taskId: task })).toHaveLength(1);
    expect(await listActiveLocks({ sessionId })).toHaveLength(1);
    expect(await listActiveLocks({ sessionId: randomUUID() })).toHaveLength(0);
  });
});
