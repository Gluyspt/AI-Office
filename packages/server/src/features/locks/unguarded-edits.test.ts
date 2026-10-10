// The flush path: ingest a buffer the guard script wrote while the
// orchestrator was down, check retroactively what it touched, flag both
// sides for review.
//
// This is the end-to-end assertion the ticket asks for — "stop the server,
// have an agent edit a file owned by another task, restart, and confirm both
// tasks are flagged" — minus the live agent, which this machine has no way to
// run. The buffer the script would have written is constructed here from the
// script's own output format, and `guard-script.test.ts` proves the script
// really produces that format against a stopped server. The two halves
// together cover the criterion; neither alone does, and the join between them
// is a format, which is the part a test can hold.
//
// Every assertion is scoped to this file's own rows.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { ProjectId, TaskId } from "@office/shared/ids";
import { pool } from "../../core/db/pool.ts";
import { createTask } from "../tasks/model.ts";
import { insertTask } from "../tasks/repo.ts";
import { acquireScope } from "./registry.ts";
import {
  ingestFlush,
  listConflictsForEdit,
  listUnguardedEdits,
  type FlushedEdit,
} from "./unguarded-edits.ts";

const TTL = 900;
const CWD = "/srv/office/projects/demo";
const createdProjects: string[] = [];

async function makeProject(): Promise<ProjectId> {
  const slug = `t020f-${randomUUID()}`;
  const { rows } = await pool.query<{ id: string }>(
    `insert into projects (name, slug, repo_url) values ($1, $2, $3) returning id`,
    [slug, slug, "https://example.invalid/repo.git"],
  );
  const id = rows[0]!.id;
  createdProjects.push(id);
  return id as ProjectId;
}

async function makeTask(projectId: ProjectId, title: string, owner = "agent1"): Promise<TaskId> {
  const record = await insertTask(createTask({ projectId, title, department: "dev", owner }));
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
    [projectId, `t020f-${randomUUID()}`, claudeId],
  );
  return { rowId: rows[0]!.id, claudeId };
}

/** One line of the buffer, in the shape hooks/pretooluse-guard.sh writes. */
function bufferedEdit(
  claudeId: string,
  absolutePath: string | null,
  overrides: Partial<FlushedEdit> = {},
): FlushedEdit {
  return {
    edit_id: randomUUID(),
    at: new Date().toISOString(),
    reason: "the orchestrator did not answer POST /guard/flush (curl exit 7)",
    session_id: claudeId,
    cwd: CWD,
    tool_name: "Edit",
    tool_use_id: `toolu_${randomUUID()}`,
    paths: absolutePath === null ? [] : [absolutePath],
    ...overrides,
  };
}

async function reviewFlag(
  taskId: TaskId,
): Promise<{ flagged: boolean; at: string | null; reason: string | null }> {
  const { rows } = await pool.query<{
    review_flagged: boolean;
    review_flagged_at: string | null;
    review_flagged_reason: string | null;
  }>(
    `select review_flagged, review_flagged_at::text as review_flagged_at, review_flagged_reason
       from tasks where id = $1`,
    [taskId],
  );
  const row = rows[0]!;
  return {
    flagged: row.review_flagged,
    at: row.review_flagged_at,
    reason: row.review_flagged_reason,
  };
}

afterAll(async () => {
  delete process.env.GUARD_FLUSH_MAX_EDITS;
  for (const id of createdProjects) {
    await pool.query("delete from projects where id = $1", [id]);
  }
});

describe("the retroactive check", () => {
  it("flags BOTH tasks when an unguarded edit touched another task's file", async () => {
    const project = await makeProject();
    const session = await makeSession(project);
    const offender = await makeTask(project, "the offender", "agent1");
    const owner = await makeTask(project, "the owner", "agent2");

    // The offender holds its own (disjoint) scope, which is how the flush
    // works out which task made the edit: there is no sessions.task_id.
    await acquireScope({
      projectId: project,
      taskId: offender,
      sessionId: session.rowId,
      patterns: ["src/offender/"],
      ttlSeconds: TTL,
    });
    await acquireScope({
      projectId: project,
      taskId: owner,
      sessionId: randomUUID(),
      patterns: ["src/db/"],
      ttlSeconds: TTL,
    });

    const edit = bufferedEdit(session.claudeId, `${CWD}/src/db/schema.ts`);
    const result = await ingestFlush({ session_id: session.claudeId, dropped: 0, edits: [edit] });

    expect(result.accepted).toBe(1);
    expect(result.conflicts).toBe(1);
    expect(result.flaggedTaskIds).toHaveLength(2);
    expect(result.flaggedTaskIds).toContain(owner);
    expect(result.flaggedTaskIds).toContain(offender);

    expect((await reviewFlag(owner)).flagged).toBe(true);
    expect((await reviewFlag(offender)).flagged).toBe(true);
    expect((await reviewFlag(owner)).reason).toContain("src/db/");
    expect((await reviewFlag(offender)).reason).toContain("src/db/schema.ts");

    // The finding itself, denormalised so it still reads after the lock goes.
    const [stored] = await listUnguardedEdits({ projectId: project });
    expect(stored!.paths).toEqual(["src/db/schema.ts"]);
    expect(stored!.conflictCount).toBe(1);
    expect(stored!.checkedAt).not.toBeNull();
    const conflicts = await listConflictsForEdit(stored!.id);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.ownerTaskId).toBe(owner);
    expect(conflicts[0]!.ownerTaskTitle).toBe("the owner");
    expect(conflicts[0]!.ownerTaskOwner).toBe("agent2");
    expect(conflicts[0]!.heldPattern).toBe("src/db/");
    expect(conflicts[0]!.certain).toBe(true);
  });

  it("does not double-flag when the same flush arrives twice", async () => {
    const project = await makeProject();
    const session = await makeSession(project);
    const offender = await makeTask(project, "offender twice", "agent1");
    const owner = await makeTask(project, "owner twice", "agent2");
    await acquireScope({
      projectId: project,
      taskId: offender,
      sessionId: session.rowId,
      patterns: ["src/twice-mine/"],
      ttlSeconds: TTL,
    });
    await acquireScope({
      projectId: project,
      taskId: owner,
      sessionId: randomUUID(),
      patterns: ["src/twice/"],
      ttlSeconds: TTL,
    });

    const edits = [bufferedEdit(session.claudeId, `${CWD}/src/twice/a.ts`)];
    const first = await ingestFlush({ session_id: session.claudeId, edits });
    const firstFlaggedAt = (await reviewFlag(owner)).at;

    // Exactly the same spool, re-sent — the case a lost ack produces.
    const second = await ingestFlush({ session_id: session.claudeId, edits });

    expect(first.accepted).toBe(1);
    expect(second.accepted).toBe(0);
    expect(second.duplicates).toBe(1);
    expect(second.conflicts).toBe(0);
    // Nothing newly flagged, and the first-flag timestamp did not move.
    expect(second.flaggedTaskIds).toEqual([]);
    expect((await reviewFlag(owner)).at).toBe(firstFlaggedAt);

    // One row and one finding, not two of each.
    const stored = await listUnguardedEdits({ projectId: project });
    expect(stored).toHaveLength(1);
    expect(await listConflictsForEdit(stored[0]!.id)).toHaveLength(1);
  });

  it("checks locks held AT THE TIME of the edit, including one since released", async () => {
    // An outage is exactly when tasks finish and release their scope. Checking
    // what is held NOW would lose the collision the moment the owner
    // completed.
    const project = await makeProject();
    const session = await makeSession(project);
    const owner = await makeTask(project, "owner who has since finished", "agent2");
    await acquireScope({
      projectId: project,
      taskId: owner,
      sessionId: randomUUID(),
      patterns: ["src/released/"],
      ttlSeconds: TTL,
    });
    // Held from two hours ago until ten minutes ago.
    await pool.query(
      `update file_locks
          set acquired_at = now() - interval '2 hours',
              expires_at  = now() + interval '1 hour',
              released_at = now() - interval '10 minutes'
        where task_id = $1`,
      [owner],
    );

    const duringTheOutage = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const result = await ingestFlush({
      session_id: session.claudeId,
      edits: [
        bufferedEdit(session.claudeId, `${CWD}/src/released/a.ts`, { at: duringTheOutage }),
      ],
    });
    expect(result.conflicts).toBe(1);
    expect((await reviewFlag(owner)).flagged).toBe(true);
  });

  it("does not flag a lock acquired AFTER the edit happened", async () => {
    const project = await makeProject();
    const session = await makeSession(project);
    const owner = await makeTask(project, "owner who claimed later", "agent2");
    await acquireScope({
      projectId: project,
      taskId: owner,
      sessionId: randomUUID(),
      patterns: ["src/later/"],
      ttlSeconds: TTL,
    });

    // The edit happened a day before the lock was taken. Well outside
    // CLOCK_SKEW_GRACE, so this is testing the window, not the grace.
    const longBefore = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const result = await ingestFlush({
      session_id: session.claudeId,
      edits: [bufferedEdit(session.claudeId, `${CWD}/src/later/a.ts`, { at: longBefore })],
    });
    expect(result.conflicts).toBe(0);
    expect((await reviewFlag(owner)).flagged).toBe(false);
  });

  it("does not flag an unowned file, nor the editor's own scope", async () => {
    const project = await makeProject();
    const session = await makeSession(project);
    const mine = await makeTask(project, "mine during the outage", "agent1");
    await acquireScope({
      projectId: project,
      taskId: mine,
      sessionId: session.rowId,
      patterns: ["src/mine/"],
      ttlSeconds: TTL,
    });

    const result = await ingestFlush({
      session_id: session.claudeId,
      edits: [
        bufferedEdit(session.claudeId, `${CWD}/src/mine/a.ts`),
        bufferedEdit(session.claudeId, `${CWD}/README.md`),
      ],
    });
    expect(result.accepted).toBe(2);
    expect(result.conflicts).toBe(0);
    expect(result.flaggedTaskIds).toEqual([]);
    expect((await reviewFlag(mine)).flagged).toBe(false);
  });

  it("stores a path-less edit from a box with no jq, and says why", async () => {
    const project = await makeProject();
    const session = await makeSession(project);
    const result = await ingestFlush({
      session_id: session.claudeId,
      edits: [
        bufferedEdit(session.claudeId, null, {
          extract: "no path extracted: jq unavailable or payload unreadable",
          tool_name: undefined,
          cwd: undefined,
          tool_use_id: undefined,
        }),
      ],
    });
    expect(result.accepted).toBe(1);
    const [stored] = await listUnguardedEdits({ projectId: project });
    expect(stored!.paths).toEqual([]);
    expect(stored!.extractNote).toContain("jq unavailable");
    // Still checked, so "accepted but never checked" keeps meaning "crashed
    // mid-flush" rather than "had no paths".
    expect(stored!.checkedAt).not.toBeNull();
  });

  it("counts a line with no edit_id as unusable rather than storing it", async () => {
    const project = await makeProject();
    const session = await makeSession(project);
    const result = await ingestFlush({
      session_id: session.claudeId,
      edits: [{ at: new Date().toISOString(), paths: [`${CWD}/src/x.ts`] }],
    });
    expect(result.accepted).toBe(0);
    expect(result.unusable).toBe(1);
    expect(await listUnguardedEdits({ projectId: project })).toHaveLength(0);
  });
});

describe("the buffer's own reporting", () => {
  it("records the count of entries the buffer dropped", async () => {
    const project = await makeProject();
    const session = await makeSession(project);
    const result = await ingestFlush({
      session_id: session.claudeId,
      dropped: 37,
      edits: [bufferedEdit(session.claudeId, `${CWD}/src/a.ts`)],
    });
    expect(result.droppedReported).toBe(37);
    const [stored] = await listUnguardedEdits({ projectId: project });
    expect(stored!.bufferDropped).toBe(37);
  });

  it("refuses the overflow above GUARD_FLUSH_MAX_EDITS instead of truncating silently", async () => {
    const project = await makeProject();
    const session = await makeSession(project);
    process.env.GUARD_FLUSH_MAX_EDITS = "2";
    const result = await ingestFlush({
      session_id: session.claudeId,
      edits: [
        bufferedEdit(session.claudeId, `${CWD}/src/a.ts`),
        bufferedEdit(session.claudeId, `${CWD}/src/b.ts`),
        bufferedEdit(session.claudeId, `${CWD}/src/c.ts`),
      ],
    });
    delete process.env.GUARD_FLUSH_MAX_EDITS;
    expect(result.received).toBe(2);
    expect(result.accepted).toBe(2);
    expect(result.refusedOverflow).toBe(1);
  });
});

describe("the events a flush emits", () => {
  it("brackets the outage with GuardDegraded and GuardRecovered, and announces the flag", async () => {
    // The orchestrator was DOWN during this outage, so guard-check.ts's live
    // pair could not fire. Emitting it here is what lets ticket 029 show the
    // banner and the listing for a window the UI also missed.
    const project = await makeProject();
    const session = await makeSession(project);
    const offender = await makeTask(project, "events offender", "agent1");
    const owner = await makeTask(project, "events owner", "agent2");
    await acquireScope({
      projectId: project,
      taskId: offender,
      sessionId: session.rowId,
      patterns: ["src/ev-mine/"],
      ttlSeconds: TTL,
    });
    await acquireScope({
      projectId: project,
      taskId: owner,
      sessionId: randomUUID(),
      patterns: ["src/ev/"],
      ttlSeconds: TTL,
    });

    const result = await ingestFlush({
      session_id: session.claudeId,
      dropped: 3,
      edits: [bufferedEdit(session.claudeId, `${CWD}/src/ev/a.ts`)],
    });

    const { rows } = await pool.query<{ type: string; payload: Record<string, unknown> }>(
      `select type, payload from events where project_id = $1 order by received_at, id`,
      [project],
    );
    const byType = new Map(rows.map((row) => [row.type, row.payload]));

    expect(byType.get("GuardDegraded")?.source).toBe("flush");
    expect(byType.get("GuardDegraded")?.flush_id).toBe(result.flushId);
    expect(byType.get("UnguardedEditsFlushed")?.accepted).toBe(1);
    expect(byType.get("UnguardedEditsFlushed")?.conflicts).toBe(1);
    expect(byType.get("UnguardedEditsFlushed")?.buffer_dropped).toBe(3);
    expect(byType.get("GuardRecovered")?.source).toBe("flush");
    expect(byType.get("TaskFlaggedForReview")).toBeDefined();

    // Ordering matters for the banner: degraded must precede recovered.
    const types = rows.map((row) => row.type);
    expect(types.indexOf("GuardDegraded")).toBeLessThan(types.indexOf("GuardRecovered"));
  });

  it("emits UnguardedEditsFlushed even for an empty flush — it is the reachability probe", async () => {
    // The script posts an empty flush on every mutating tool call; that is how
    // it learns the orchestrator is up. The event is what makes the probe
    // visible, and an empty one must not pretend an outage happened.
    const before = await pool.query<{ n: string }>(
      `select count(*)::text as n from events where type = 'GuardDegraded'`,
    );
    const result = await ingestFlush({ edits: [], dropped: 0 });
    expect(result.accepted).toBe(0);
    const after = await pool.query<{ n: string }>(
      `select count(*)::text as n from events where type = 'GuardDegraded'`,
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    await pool.query(`delete from events where type = 'UnguardedEditsFlushed' and project_id is null`);
  });
});
