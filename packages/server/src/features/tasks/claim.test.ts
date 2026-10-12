// `claim_task`, against a real database.
//
// Ticket 017. The things this can get wrong are all persistence: a claim that
// moves the task but holds no locks, a claim that holds locks and does not
// move the task, two agents both winning, an argument that overrides the
// transport's idea of who is calling. None of that is testable against a
// mocked database, and two of them are only visible under concurrency.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../core/app.ts";
import type { SessionRecord } from "@office/shared/sessions";
import { asProjectId, asSessionId, asTaskId, type ProjectId, type TaskId } from "@office/shared/ids";
import { pool } from "../../core/db/pool.ts";
import { addDependency } from "./dependencies.ts";
import { createTask } from "./model.ts";
import { getTask } from "./repo.ts";
import { transition } from "./states.ts";
import { claimTask } from "./claim.ts";
import { MCP_SERVER_NAME } from "./routes/mcp-tasks.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");

let projectId: ProjectId;
const createdProjects: string[] = [];
/** Locks are not project-cascaded in every path; track and clear our own. */
const createdTasks: string[] = [];

beforeAll(async () => {
  const slug = `t017-${randomUUID()}`;
  const result = await pool.query<{ id: string }>(
    `insert into projects (name, slug, repo_url) values ($1, $2, $3) returning id`,
    [slug, slug, "https://example.invalid/repo.git"],
  );
  projectId = asProjectId(result.rows[0]!.id);
  createdProjects.push(projectId);
});

afterAll(async () => {
  for (const id of createdProjects) {
    await pool.query("delete from projects where id = $1", [id]);
  }
});

/** A desk, as the transport would have proven it. Only `owner` is read by the
 * coordination layer; the rest is recognisably synthetic on purpose. */
function desk(owner: string): SessionRecord {
  return {
    id: asSessionId(randomUUID()),
    projectId,
    tmuxName: `test:${owner}`,
    role: "dept_lead",
    dept: "dev",
    owner,
    backend: "claude",
    model: "sonnet",
    modelReason: "test",
    status: "running",
    claudeSessionId: null,
    failureKind: null,
    failureReason: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
  } as SessionRecord;
}

async function makeTask(owner = "agent1", title = "claimable fixture"): Promise<TaskId> {
  const task = createTask({ projectId, title, department: "dev", owner });
  await pool.query(
    `insert into tasks (id, project_id, title, brief, department, owner, model, model_reason, branch)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      task.id,
      task.projectId,
      task.title,
      task.brief,
      task.department,
      task.owner,
      task.model,
      task.modelReason,
      task.branch,
    ],
  );
  createdTasks.push(task.id);
  return task.id;
}

/** draft -> pending, which is what "start working" does and what a claim
 * expects to find. */
async function pending(owner = "agent1", title?: string): Promise<TaskId> {
  const id = await makeTask(owner, title);
  await transition({
    taskId: id,
    to: "pending",
    actor: "lead",
    actorKind: "human",
    reason: "start working",
  });
  return id;
}

async function locksHeldBy(taskId: TaskId): Promise<string[]> {
  const { rows } = await pool.query<{ path_pattern: string }>(
    "select path_pattern from file_locks where task_id = $1 and released_at is null order by path_pattern",
    [taskId],
  );
  return rows.map((row) => row.path_pattern);
}

// --- The three checks -----------------------------------------------------------

describe("claim_task's three checks", () => {
  it("claims a pending task owned by this account, and holds its scope", async () => {
    const taskId = await pending("agent1");
    const result = await claimTask({
      taskId,
      session: desk("agent1"),
      scope: ["src/a/"],
      ttlSeconds: 600,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.task.state).toBe("in_progress");
    expect(result.scope).toEqual(["src/a/"]);
    expect(await locksHeldBy(taskId)).toEqual(["src/a/"]);
  });

  it("refuses a task owned by another account, naming both owners", async () => {
    const taskId = await pending("agent2");
    const result = await claimTask({ taskId, session: desk("agent1"), scope: ["src/b/"] });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("owner_mismatch");
    // Both sides named: an agent that reads only "denied" cannot tell whether
    // it asked for the wrong task or is running as the wrong account.
    expect(result.message).toContain("agent2");
    expect(result.message).toContain("agent1");
    // And nothing happened.
    expect((await getTask(taskId))?.state).toBe("pending");
    expect(await locksHeldBy(taskId)).toEqual([]);
  });

  it("IGNORES a forged owner argument — identity comes from the transport", async () => {
    // THE CRITERION THIS FILE EXISTS FOR. `ClaimInput` has no `owner` field,
    // so an agent cannot assert one. This passes every plausible spelling of
    // a forgery through the same call and asserts the refusal is unchanged.
    const taskId = await pending("agent2");
    const forged = {
      owner: "agent2",
      session_id: randomUUID(),
      actor: "agent2",
      as: "agent2",
    } as unknown as Parameters<typeof claimTask>[0];

    const result = await claimTask({
      ...forged,
      taskId,
      session: desk("agent1"),
      scope: ["src/c/"],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("owner_mismatch");
    expect((await getTask(taskId))?.state).toBe("pending");
  });

  it("refuses a task whose dependency has not been delivered, and names it", async () => {
    const blocker = await pending("agent1", "the blocker");
    const blocked = await pending("agent1", "the blocked");
    await addDependency(blocked, blocker);

    const result = await claimTask({ taskId: blocked, session: desk("agent1"), scope: ["src/d/"] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("blocked_by_dependency");
    expect(result.blockedBy).toEqual([blocker]);
    expect(result.message).toContain(blocker);
    // The refusal teaches the rule, because "delivered, not done" is the part
    // an agent gets wrong and then retries against.
    expect(result.message).toContain("delivered");
  });

  it("refuses a scope another active task holds, naming the holder", async () => {
    const mine = await pending("agent1", "mine");
    const theirs = await pending("agent1", "theirs");
    const first = await claimTask({
      taskId: mine,
      session: desk("agent1"),
      scope: ["src/shared/"],
      ttlSeconds: 600,
    });
    expect(first.ok).toBe(true);

    const second = await claimTask({
      taskId: theirs,
      session: desk("agent1"),
      scope: ["src/shared/thing.ts"],
      ttlSeconds: 600,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.kind).toBe("scope_conflict");
    expect(second.conflicts?.[0]?.heldByTaskId).toBe(mine);
    expect(second.message).toContain(mine);
    // "A refused edit is information, not an obstacle" — the role file's
    // words, and the refusal has to agree with them or the agent retries.
    expect(second.message).toContain("dependency");
  });

  it("reports every colliding pattern, not just the first", async () => {
    const holder = await pending("agent1", "holder");
    const asker = await pending("agent1", "asker");
    await claimTask({
      taskId: holder,
      session: desk("agent1"),
      scope: ["src/one/", "src/two/"],
      ttlSeconds: 600,
    });

    const result = await claimTask({
      taskId: asker,
      session: desk("agent1"),
      scope: ["src/one/a.ts", "src/two/b.ts", "src/three/c.ts"],
      ttlSeconds: 600,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Two conflicts in one refusal, so the agent decides once instead of
    // discovering them one retry at a time.
    expect(result.conflicts?.length).toBe(2);
  });
});

// --- State and scope ------------------------------------------------------------

describe("what a claim refuses to move", () => {
  it("refuses a task that is already in progress, and says so distinctly", async () => {
    const taskId = await pending("agent1");
    await claimTask({ taskId, session: desk("agent1"), scope: ["src/e/"], ttlSeconds: 600 });
    const again = await claimTask({
      taskId,
      session: desk("agent1"),
      scope: ["src/e/"],
      ttlSeconds: 600,
    });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.kind).toBe("wrong_state");
    expect(again.message).toContain("already in progress");
  });

  it("refuses a draft — start working comes first", async () => {
    const taskId = await makeTask("agent1");
    const result = await claimTask({ taskId, session: desk("agent1"), scope: ["src/f/"] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("wrong_state");
  });

  it("refuses a claim with no file scope, and says what to pass", async () => {
    // SCOPE_IS_REQUIRED_UNTIL_019. The alternative is a claim that holds no
    // locks, which makes 020's guard inert for that task: two agents edit one
    // file and the registry reports no conflict.
    const taskId = await pending("agent1");
    for (const scope of [undefined, [], ["  "]]) {
      const result = await claimTask({
        taskId,
        session: desk("agent1"),
        ...(scope === undefined ? {} : { scope }),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.kind).toBe("scope_required");
      expect(result.message).toContain("file_scope");
    }
    expect((await getTask(taskId))?.state).toBe("pending");
  });

  it("refuses a task that does not exist", async () => {
    const result = await claimTask({
      taskId: asTaskId(randomUUID()),
      session: desk("agent1"),
      scope: ["src/g/"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("not_found");
  });
});

// --- Atomicity and concurrency --------------------------------------------------

describe("a claim is one transaction", () => {
  it("leaves the task pending and no locks held when the scope is refused", async () => {
    const holder = await pending("agent1", "holds the file");
    const loser = await pending("agent1", "wants the file");
    await claimTask({
      taskId: holder,
      session: desk("agent1"),
      scope: ["src/contested/"],
      ttlSeconds: 600,
    });

    const result = await claimTask({
      taskId: loser,
      session: desk("agent1"),
      scope: ["src/contested/x.ts", "src/free/"],
      ttlSeconds: 600,
    });
    expect(result.ok).toBe(false);

    // The criterion, both halves: the state did not move AND the
    // non-conflicting pattern was not left held. A partially-held scope is
    // worse than a refused one — the task appears to own files it does not.
    expect((await getTask(loser))?.state).toBe("pending");
    expect(await locksHeldBy(loser)).toEqual([]);
  });

  it("gives the task to exactly one of two concurrent claims", async () => {
    // Two desks on the SAME account, which is the realistic shape: one Linux
    // user hosts several desks, so this is not a contrived race.
    const taskId = await pending("agent1", "contested task");
    const [a, b] = await Promise.all([
      claimTask({ taskId, session: desk("agent1"), scope: ["src/race/"], ttlSeconds: 600 }),
      claimTask({ taskId, session: desk("agent1"), scope: ["src/race/"], ttlSeconds: 600 }),
    ]);

    const winners = [a, b].filter((result) => result.ok);
    const losers = [a, b].filter((result) => !result.ok);
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(1);

    // The loser must be told something it can act on. Either answer is
    // correct depending on which transaction got there first — what matters
    // is that it is one of them and not a crash or a silent second claim.
    const loser = losers[0];
    if (loser?.ok === false) {
      expect(["wrong_state", "scope_conflict"]).toContain(loser.kind);
    }
    expect((await getTask(taskId))?.state).toBe("in_progress");
    // One set of locks, not two.
    const { rows } = await pool.query<{ count: string }>(
      "select count(*)::text as count from file_locks where task_id = $1 and released_at is null",
      [taskId],
    );
    expect(Number(rows[0]!.count)).toBe(1);
  });
});

// --- The name that has to match in three places ---------------------------------

describe("the office_tasks server name", () => {
  it("matches the role files and the permission allowlist", async () => {
    // A mismatch here allowlists a server that does not exist, so in manual
    // mode every claim_task raises a PermissionRequest and parks the desk —
    // while the settings file reads as if it should not. Spike 003 wrote this
    // name two different ways in two sections; this test is why that cannot
    // happen again silently.
    const settings = await readFile(
      path.join(repoRoot, "config/hooks/base.settings.json"),
      "utf8",
    );
    const parsed = JSON.parse(settings) as { permissions: { allow: string[] } };
    expect(parsed.permissions.allow).toContain(`mcp__${MCP_SERVER_NAME}__*`);

    for (const role of ["dev-lead", "management-lead"]) {
      const text = await readFile(path.join(repoRoot, "agents", `${role}.md`), "utf8");
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
      expect(frontmatter, role).toContain(`- ${MCP_SERVER_NAME}:`);
      expect(frontmatter, role).toContain("/mcp/tasks");
    }
  });
});

// --- The HTTP surface -----------------------------------------------------------
//
// The same two operations a human drives from the Tasks page (025). Both call
// the same functions as the MCP tools, so what is tested here is the skin: the
// status codes, and that an operator's `owner` reaches the owner check.

describe("POST /tasks/:id/claim and /complete", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  const post = async (
    url: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const response = await app.inject({
      method: "POST",
      url,
      payload: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
    return {
      status: response.statusCode,
      body: response.body === "" ? {} : (JSON.parse(response.body) as Record<string, unknown>),
    };
  };

  it("claims and then completes a task end to end", async () => {
    const taskId = await pending("agent1", "http fixture");
    const claim = await post(`/tasks/${taskId}/claim`, {
      owner: "agent1",
      file_scope: ["src/http/"],
    });
    expect(claim.status).toBe(200);
    expect((claim.body.task as { state: string }).state).toBe("in_progress");

    const complete = await post(`/tasks/${taskId}/complete`, {
      owner: "agent1",
      summary: "did it",
      learning: "learned it",
    });
    expect(complete.status).toBe(200);
    expect((complete.body.task as { state: string }).state).toBe("ready_for_qa");
    // The git seam's words reach an API consumer too, not only an agent.
    expect((complete.body.delivery as { implemented: boolean }).implemented).toBe(false);
  });

  it("answers 409 for a conflict and 400 for a missing argument", async () => {
    // 409, not 403: these are conflicts with the state of the work, and a 403
    // would make the Tasks page show a permissions error for a task that is
    // merely blocked.
    const theirs = await pending("agent2", "someone else's");
    const mismatch = await post(`/tasks/${theirs}/claim`, {
      owner: "agent1",
      file_scope: ["src/x/"],
    });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.kind).toBe("owner_mismatch");

    const noScope = await post(`/tasks/${theirs}/claim`, { owner: "agent2" });
    expect(noScope.status).toBe(400);
    expect(noScope.body.kind).toBe("scope_required");

    const claimed = await pending("agent1", "for the 400");
    await post(`/tasks/${claimed}/claim`, { owner: "agent1", file_scope: ["src/y/"] });
    const noLearning = await post(`/tasks/${claimed}/complete`, {
      owner: "agent1",
      summary: "s",
    });
    expect(noLearning.status).toBe(400);
    expect(noLearning.body.kind).toBe("learning_required");
  });

  it("answers 404 for a task that does not exist and 400 with no owner", async () => {
    const missing = await post(`/tasks/${randomUUID()}/claim`, {
      owner: "agent1",
      file_scope: ["src/z/"],
    });
    expect(missing.status).toBe(404);

    const anonymous = await post(`/tasks/${randomUUID()}/claim`, { file_scope: ["src/z/"] });
    expect(anonymous.status).toBe(400);
  });
});
