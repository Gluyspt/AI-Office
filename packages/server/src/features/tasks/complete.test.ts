// `complete_task`, against a real database.
//
// Ticket 017. Three things here are requirements rather than preferences, and
// each has a test that fails if someone "simplifies" it: the learning entry is
// mandatory, completion stops at ready-for-QA, and the git half is a named
// seam that announces its own absence.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionRecord } from "@office/shared/sessions";
import { asProjectId, asSessionId, asTaskId, type ProjectId, type TaskId } from "@office/shared/ids";
import { pool } from "../../core/db/pool.ts";
import { createTask } from "./model.ts";
import { getTask } from "./repo.ts";
import { taskStateHistory, transition } from "./states.ts";
import { claimTask } from "./claim.ts";
import { completeTask, gitDelivery } from "./complete.ts";

let projectId: ProjectId;
const createdProjects: string[] = [];

beforeAll(async () => {
  const slug = `t017c-${randomUUID()}`;
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

async function claimed(
  owner = "agent1",
  scope: readonly string[] = [`src/${randomUUID()}/`],
): Promise<TaskId> {
  const task = createTask({ projectId, title: "completable fixture", department: "dev", owner });
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
  await transition({
    taskId: task.id,
    to: "pending",
    actor: "lead",
    actorKind: "human",
    reason: "start working",
  });
  const result = await claimTask({ taskId: task.id, session: desk(owner), scope, ttlSeconds: 600 });
  if (!result.ok) throw new Error(`fixture could not claim: ${result.message}`);
  return task.id;
}

async function heldLocks(taskId: TaskId): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    "select count(*)::text as count from file_locks where task_id = $1 and released_at is null",
    [taskId],
  );
  return Number(rows[0]!.count);
}

async function learningOf(taskId: TaskId): Promise<string | null> {
  const { rows } = await pool.query<{ learning: string | null }>(
    "select learning from tasks where id = $1",
    [taskId],
  );
  return rows[0]?.learning ?? null;
}

// --- The mandatory entries ------------------------------------------------------

describe("what complete_task requires", () => {
  it("refuses an empty or whitespace-only learning, and says why it is required", async () => {
    const taskId = await claimed();
    for (const learning of [undefined, "", "   ", "\n\t "]) {
      const result = await completeTask({
        taskId,
        session: desk("agent1"),
        summary: "did the thing",
        ...(learning === undefined ? {} : { learning }),
      });
      expect(result.ok, JSON.stringify(learning)).toBe(false);
      if (result.ok) return;
      expect(result.kind).toBe("learning_required");
      expect(result.message).toContain("learning");
    }
    // Nothing moved, nothing was released.
    expect((await getTask(taskId))?.state).toBe("in_progress");
    expect(await heldLocks(taskId)).toBe(1);
  });

  it("refuses a missing summary before complaining about the learning", async () => {
    const taskId = await claimed();
    const result = await completeTask({ taskId, session: desk("agent1") });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("summary_required");
  });

  it("refuses a completion by an account that does not own the task", async () => {
    const taskId = await claimed("agent1");
    const result = await completeTask({
      taskId,
      session: desk("agent2"),
      summary: "s",
      learning: "l",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("owner_mismatch");
    expect(await heldLocks(taskId)).toBe(1);
  });

  it("refuses a task that was never claimed, and says to claim it", async () => {
    const task = createTask({
      projectId,
      title: "unclaimed",
      department: "dev",
      owner: "agent1",
    });
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
    await transition({
      taskId: task.id,
      to: "pending",
      actor: "lead",
      actorKind: "human",
      reason: "start working",
    });

    const result = await completeTask({
      taskId: task.id,
      session: desk("agent1"),
      summary: "s",
      learning: "l",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("wrong_state");
    expect(result.message).toContain("claim_task");
  });

  it("refuses a task that does not exist", async () => {
    const result = await completeTask({
      taskId: asTaskId(randomUUID()),
      session: desk("agent1"),
      summary: "s",
      learning: "l",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("not_found");
  });
});

// --- What completion does -------------------------------------------------------

describe("a completion", () => {
  it("moves the task to ready_for_qa, never done, and releases its locks", async () => {
    const taskId = await claimed("agent1", ["src/done/", "src/done-too/"]);
    expect(await heldLocks(taskId)).toBe(2);

    const result = await completeTask({
      taskId,
      session: desk("agent1"),
      summary: "wrote the thing and its tests",
      learning: "the dev Postgres clock is behind the host's",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // "A dev calling complete_task moves the task to ready for QA, never
    // straight to done." The three test stages are the point.
    expect(result.task.state).toBe("ready_for_qa");
    expect(result.locksReleased).toBe(2);
    expect(await heldLocks(taskId)).toBe(0);
  });

  it("stores the learning entry where step 5 will find it", async () => {
    const taskId = await claimed();
    await completeTask({
      taskId,
      session: desk("agent1"),
      summary: "s",
      learning: "  an unanchored allow glob approves nothing  ",
    });
    // Trimmed, because a trailing newline from a model's heredoc is not
    // content — and the column's check constraint refuses a blank.
    expect(await learningOf(taskId)).toBe("an unanchored allow glob approves nothing");
  });

  it("records the summary as the transition's reason, so the gate can read it", async () => {
    const taskId = await claimed();
    await completeTask({
      taskId,
      session: desk("agent1"),
      summary: "split the guard in two",
      learning: "l",
    });
    const history = await taskStateHistory(taskId);
    const last = history.at(-1);
    expect(last?.toState).toBe("ready_for_qa");
    expect(last?.reason).toBe("split the guard in two");
    expect(last?.actorKind).toBe("agent");
  });

  it("is idempotent in the only way that matters: the second call refuses", async () => {
    const taskId = await claimed();
    const first = await completeTask({
      taskId,
      session: desk("agent1"),
      summary: "s",
      learning: "l",
    });
    expect(first.ok).toBe(true);
    const second = await completeTask({
      taskId,
      session: desk("agent1"),
      summary: "s",
      learning: "l",
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.kind).toBe("wrong_state");
    // Reassuring rather than alarming: an agent that retried after a timeout
    // needs to know it already worked.
    expect(second.message).toContain("already ready for QA");
  });
});

// --- The git seam ---------------------------------------------------------------

describe("the git half", () => {
  it("is reachable, and says it did nothing", async () => {
    // THE CRITERION: "the seam is reachable, so step 4 cannot forget it."
    // Not "a comment mentions git" — the outcome travels back to the caller.
    const taskId = await claimed();
    const result = await completeTask({
      taskId,
      session: desk("agent1"),
      summary: "s",
      learning: "l",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.delivery.implemented).toBe(false);
    expect(result.delivery.ownedByStep).toBe(4);
    expect(result.delivery.message).toMatch(/not implemented in step 2/);
    // The agent must be told not to claim delivery. This is the sentence that
    // stops a lead reporting "merged" upward on the strength of a tool
    // returning success.
    expect(result.delivery.message).toMatch(/Do not report it as delivered/);
  });

  it("names the branch when there is one, and its absence when there is not", () => {
    const base = {
      id: asTaskId(randomUUID()),
      branch: null,
    } as never;
    expect(gitDelivery(base).message).toContain("no branch yet");
    expect(
      gitDelivery({ ...(base as object), branch: "task/abc-thing" } as never).message,
    ).toContain("task/abc-thing");
  });
});

// --- The race, from the other end -----------------------------------------------

describe("concurrency", () => {
  it("refuses the loser of two concurrent completions rather than throwing", async () => {
    const taskId = await claimed();
    const [a, b] = await Promise.all([
      completeTask({ taskId, session: desk("agent1"), summary: "a", learning: "l" }),
      completeTask({ taskId, session: desk("agent1"), summary: "b", learning: "l" }),
    ]);
    expect([a, b].filter((result) => result.ok).length).toBe(1);
    const loser = [a, b].find((result) => !result.ok);
    if (loser && !loser.ok) expect(loser.kind).toBe("wrong_state");
    expect((await getTask(taskId))?.state).toBe("ready_for_qa");
  });

  it("leaves the locks held when a pause beats the completion to the transition", async () => {
    // THE REASON completion refuses by throwing rather than returning.
    // `withTransaction` commits what its callback returns, so a refusal
    // decided after the lock release would have COMMITTED that release — and
    // 028's rule is explicit that a paused task still owns its files.
    //
    // Honest about what this proves: the window is real but narrow, so this
    // races a pause against a completion a few times and asserts the
    // invariant on whichever branch it lands in. It does not guarantee it
    // reaches the refused branch on any given run — the claim-side test for
    // two different scopes is the deterministic one for the same mechanism,
    // and it failed before this was fixed.
    let sawRefusal = false;
    for (let attempt = 0; attempt < 6 && !sawRefusal; attempt += 1) {
      const taskId = await claimed();
      const [completion] = await Promise.all([
        completeTask({ taskId, session: desk("agent1"), summary: "s", learning: "l" }),
        transition({
          taskId,
          to: "paused",
          actor: "human",
          actorKind: "human",
          reason: "rate limit",
        }).catch(() => undefined),
      ]);

      const state = (await getTask(taskId))?.state;
      if (completion.ok) {
        // The completion won: ready for QA, files let go.
        expect(state).toBe("ready_for_qa");
        expect(await heldLocks(taskId)).toBe(0);
      } else {
        sawRefusal = true;
        expect(completion.kind).toBe("wrong_state");
        // The invariant: a refused completion released nothing.
        expect(state).toBe("paused");
        expect(await heldLocks(taskId)).toBe(1);
        expect(await learningOf(taskId)).toBeNull();
      }
    }
  });

  it("refuses the loser of two claims that declare DIFFERENT scopes", async () => {
    // The race the advisory lock does NOT catch: two desks claiming one task
    // with non-overlapping scopes never collide in the lock registry, so both
    // reach the transition. Before this was handled, the loser got a thrown
    // ConcurrentTransitionError — which reaches a model as "the tool failed
    // internally", i.e. as a reason to retry.
    const task = createTask({ projectId, title: "two scopes", department: "dev", owner: "agent1" });
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
    await transition({
      taskId: task.id,
      to: "pending",
      actor: "lead",
      actorKind: "human",
      reason: "start working",
    });

    const [a, b] = await Promise.all([
      claimTask({
        taskId: task.id,
        session: desk("agent1"),
        scope: ["src/scope-a/"],
        ttlSeconds: 600,
      }),
      claimTask({
        taskId: task.id,
        session: desk("agent1"),
        scope: ["src/scope-b/"],
        ttlSeconds: 600,
      }),
    ]);

    expect([a, b].filter((result) => result.ok).length).toBe(1);
    const loser = [a, b].find((result) => !result.ok);
    expect(loser && !loser.ok && loser.kind).toBe("wrong_state");
    expect((await getTask(task.id))?.state).toBe("in_progress");
    // And the loser's scope was not left held — one claim, one scope.
    expect(await heldLocks(task.id)).toBe(1);
  });
});
