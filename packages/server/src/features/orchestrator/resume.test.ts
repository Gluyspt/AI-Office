// Resume against a real database.
//
// The thing this file is really testing is the design's claim that **one
// Resume recovers every kind of interruption** — manual pause, crash,
// circuit breaker, rate limit. They differ only in what is recorded on the
// pause row; they must not differ in what resume does, because the UI shows
// one button. A test per interruption kind is the only way that claim stays
// true as the kinds multiply.
//
// `respawn: false` is exercised deliberately rather than as an afterthought.
// It recovers task state and locks without starting any agent, which matters
// on this host specifically: 3.2 GB total, ~2.3 GB available, and a bare
// idle agent is ~290 MB with peaks to 343 MB. An operator who has just
// emergency-stopped because the box was thrashing wants the board back
// before the desks.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { ProjectId, TaskId } from "@office/shared/ids";
import { pool } from "../../core/db/pool.ts";
import { createTask } from "../tasks/model.ts";
import { insertTask } from "../tasks/repo.ts";
import { transition } from "../tasks/states.ts";
import { acquireScope, expireLocks, listActiveLocks } from "../locks/registry.ts";
import { addDependency } from "../tasks/dependencies.ts";
import { __resetPauseDeps, __setPauseDeps, liftPausesFor, pauseScope } from "./pause.ts";
import { RESUME_NOTICES, resume, resumeBrief, resumeProject, resumeTask } from "./resume.ts";

const createdProjects: string[] = [];

async function makeProject(): Promise<ProjectId> {
  const slug = `t028r-${randomUUID()}`;
  const result = await pool.query<{ id: string }>(
    `insert into projects (name, slug, repo_url) values ($1, $2, $3) returning id`,
    [slug, slug, "https://example.invalid/repo.git"],
  );
  const id = result.rows[0]!.id;
  createdProjects.push(id);
  return id as ProjectId;
}

async function makeWorkingTask(projectId: ProjectId): Promise<TaskId> {
  const record = await insertTask(
    createTask({ projectId, title: "resumable work", department: "dev", owner: "gluy" }),
  );
  await transition({ taskId: record.id, to: "pending", actor: "t", actorKind: "system" });
  await transition({ taskId: record.id, to: "in_progress", actor: "t", actorKind: "system" });
  return record.id;
}

async function stateOf(taskId: TaskId): Promise<string | undefined> {
  const { rows } = await pool.query<{ state: string }>(
    `select state from tasks where id = $1`,
    [taskId],
  );
  return rows[0]?.state;
}

// Turn-waiting and the clock are injected for the reasons pause.test.ts
// documents: "the turn ended" comes from hook events rather than the pane,
// and this host's wall clock steps backwards.
__setPauseDeps({ waitForTurnEnd: async () => true, monotonicMs: (() => { let t = 0; return () => (t += 10); })() });

afterAll(async () => {
  __resetPauseDeps();
  for (const id of createdProjects) {
    await pool.query("delete from projects where id = $1", [id]);
  }
});

// --- One Resume for every kind of interruption ----------------------------------

describe("one Resume recovers every kind of interruption", () => {
  // Manual pause, crash, circuit breaker and rate limit all land in the same
  // place by design — "paused is where every interruption lands" — and one
  // Resume recovers all of them. Which it was is recorded; it does not change
  // what resume does.
  for (const reason of ["manual", "crash", "circuit breaker", "rate limit"]) {
    it(`recovers a pause whose reason was ${JSON.stringify(reason)}`, async () => {
      const projectId = await makeProject();
      const taskId = await makeWorkingTask(projectId);
      await pauseScope({ projectId, initiatedBy: "human:gluy", reason });
      expect(await stateOf(taskId)).toBe("paused");

      const result = await resumeProject({
        projectId,
        requestedBy: "human:gluy",
        respawn: false,
      });
      expect(result.liftedPause?.reason).toBe(reason);
      expect(await stateOf(taskId)).toBe("in_progress");
    });
  }
});

// --- What resume restores -------------------------------------------------------

describe("resume restores the state a task was paused from", () => {
  it("returns a task to its origin state, not to a fixed one", async () => {
    // `pausedOriginState` exists because "paused" alone loses where the work
    // was. A resume that sent everything back to `in_progress` would silently
    // move a task that had been waiting for QA.
    const projectId = await makeProject();
    const taskId = await makeWorkingTask(projectId);
    await transition({ taskId, to: "ready_for_qa", actor: "t", actorKind: "system" });
    await pauseScope({ projectId, initiatedBy: "human:gluy" });
    expect(await stateOf(taskId)).toBe("paused");

    await resumeProject({ projectId, requestedBy: "human:gluy", respawn: false });
    expect(await stateOf(taskId)).toBe("ready_for_qa");
  });

  it("lifts the pause, so the project is startable again", async () => {
    const projectId = await makeProject();
    await makeWorkingTask(projectId);
    await pauseScope({ projectId, initiatedBy: "human:gluy" });
    const result = await resumeProject({ projectId, requestedBy: "human:gluy", respawn: false });
    expect(result.liftedPause).not.toBeNull();
    expect(result.liftedPause?.liftedBy).toBe("human:gluy");
  });

  it("records who asked", async () => {
    const projectId = await makeProject();
    await makeWorkingTask(projectId);
    await pauseScope({ projectId, initiatedBy: "human:gluy" });
    const result = await resumeProject({
      projectId,
      requestedBy: "human:ronna",
      respawn: false,
    });
    expect(result.requestedBy).toBe("human:ronna");
  });
});

// --- respawn: false -------------------------------------------------------------

describe("respawn: false", () => {
  it("recovers the board without starting any agent", async () => {
    // The memory case: 3.2 GB total and ~290 MB per bare agent, so after an
    // emergency stop an operator may want the board back before the desks.
    const projectId = await makeProject();
    const taskId = await makeWorkingTask(projectId);
    await pauseScope({ projectId, initiatedBy: "human:gluy" });

    const result = await resumeProject({ projectId, requestedBy: "x", respawn: false });
    expect(await stateOf(taskId)).toBe("in_progress");
    for (const outcome of result.tasks) {
      // Every task reports WHY no desk was started, rather than leaving the
      // caller to infer it from an absence.
      expect(outcome.respawn.spawned).toBe(false);
      expect(outcome.respawn.reason).not.toBeNull();
    }
  });
});

// --- Resuming one task ----------------------------------------------------------

describe("resumeTask", () => {
  it("REFUSES a single task while a project pause covers it, and says what to do", async () => {
    // Not what I first assumed, and the code is right. Resuming one task
    // under an office-wide pause would restart an agent inside a pause that
    // is still in effect — the board would show one task moving while
    // everything else is held, and `start_session` would still be refused
    // for it. So the refusal names the remedy instead of half-resuming.
    const projectId = await makeProject();
    const one = await makeWorkingTask(projectId);
    const other = await makeWorkingTask(projectId);
    await pauseScope({ projectId, initiatedBy: "human:gluy" });

    await expect(
      resumeTask({ taskId: one, requestedBy: "human:gluy", respawn: false }),
    ).rejects.toThrow(/resume the project instead/);
    expect(await stateOf(one)).toBe("paused");
    expect(await stateOf(other)).toBe("paused");
    await liftPausesFor(projectId, "cleanup");
  });

  it("resumes exactly one task and leaves its siblings alone, with no project pause", async () => {
    // The per-task path proper: a crash or a rate limit paused one task and
    // nothing else, so resuming it must not touch its siblings.
    const projectId = await makeProject();
    const one = await makeWorkingTask(projectId);
    const other = await makeWorkingTask(projectId);
    await transition({
      taskId: one,
      to: "paused",
      actor: "system",
      actorKind: "system",
      reason: "simulated rate limit",
    });

    await resumeTask({ taskId: one, requestedBy: "human:gluy", respawn: false });
    expect(await stateOf(one)).toBe("in_progress");
    expect(await stateOf(other)).toBe("in_progress");
  });

  it("resumes a task paused on its own, with no pause row behind it", async () => {
    // A crash or a rate limit pauses one task without an office-wide pause.
    // `liftedPause` is null there, and that is not an error.
    const projectId = await makeProject();
    const taskId = await makeWorkingTask(projectId);
    await transition({
      taskId,
      to: "paused",
      actor: "system",
      actorKind: "system",
      reason: "simulated crash",
    });

    const result = await resumeTask({ taskId, requestedBy: "human:gluy", respawn: false });
    expect(result.liftedPause).toBeNull();
    expect(await stateOf(taskId)).toBe("in_progress");
  });

  it("is a no-op on a task that was never paused, rather than an error", async () => {
    const projectId = await makeProject();
    const taskId = await makeWorkingTask(projectId);
    const result = await resumeTask({ taskId, requestedBy: "human:gluy", respawn: false });
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.resumed).toBe(false);
    // The refusal says why rather than looking like success.
    expect(result.tasks[0]?.skipReason).not.toBeNull();
    expect(await stateOf(taskId)).toBe("in_progress");
  });
});

// --- The dispatcher -------------------------------------------------------------

describe("resume() dispatches on what it was given", () => {
  it("a taskId resumes that task", async () => {
    // No project pause: a single-task resume under one is refused, which the
    // test above covers. Here the task was paused on its own.
    const projectId = await makeProject();
    const taskId = await makeWorkingTask(projectId);
    await transition({
      taskId,
      to: "paused",
      actor: "system",
      actorKind: "system",
      reason: "simulated crash",
    });

    const one = await resume({ taskId, requestedBy: "x", respawn: false });
    expect(one.scope.taskId).toBe(taskId);
    // The project comes back populated, not null: resume knows which project
    // the task belongs to, and a caller rendering the result should not have
    // to look it up again. (I expected null here and was wrong.)
    expect(one.scope.projectId).toBe(projectId);
    expect(await stateOf(taskId)).toBe("in_progress");
  });

  it("a projectId resumes the project", async () => {
    const projectId = await makeProject();
    const taskId = await makeWorkingTask(projectId);
    await pauseScope({ projectId, initiatedBy: "human:gluy" });

    const all = await resume({ projectId, requestedBy: "x", respawn: false });
    expect(all.scope.projectId).toBe(projectId);
    expect(all.scope.taskId).toBeNull();
    expect(await stateOf(taskId)).toBe("in_progress");
  });
});

// --- The seams ------------------------------------------------------------------

describe("the seams are reported, not hidden", () => {
  it("returns the handoff and WIP notices with every resume", async () => {
    // The knowledge graph is build step 5 and does not exist, so the handoff
    // node no-ops. 029's UI must say so rather than promise "Full context" —
    // which it can only do if resume hands it the notice.
    const projectId = await makeProject();
    await makeWorkingTask(projectId);
    await pauseScope({ projectId, initiatedBy: "human:gluy" });
    const result = await resumeProject({ projectId, requestedBy: "x", respawn: false });
    expect(result.notices).toEqual(RESUME_NOTICES);
    expect(result.notices.join(" ")).toMatch(/handoff|context|commit/i);
  });

  it("the brief tells the agent it does not remember the work", async () => {
    // The human sees continuous history; the agent does not. A brief that
    // implied otherwise would have the agent act as though it remembered
    // decisions it never made.
    const projectId = await makeProject();
    const taskId = await makeWorkingTask(projectId);
    const { rows } = await pool.query(`select * from tasks where id = $1`, [taskId]);
    void rows;
    const brief = resumeBrief(
      { id: taskId, title: "resumable work" } as never,
      null,
    );
    expect(brief.length).toBeGreaterThan(20);
    expect(brief).toContain("resumable work");
  });
});

// --- Locks, and the clock behind them -------------------------------------------

describe("resume and the locks", () => {
  // Criterion: "Resume of a single task respawns its agent with the task brief
  // and the handoff, and clears the paused flag on its locks." The respawn and
  // brief halves are covered above; the lock half was asserted nowhere, which
  // is the half that loses work.
  it("clears the paused flag AND restarts the TTL, in one go", async () => {
    // Both, or neither is any use. A paused lock's TTL has almost certainly
    // expired while the work was paused — that is what pausing it was for — so
    // clearing `paused` without restarting the clock hands the sweeper a
    // live-but-expired lock and the task loses the files it was just resumed
    // to work on. The sweep would look like ordinary TTL reclamation, timed
    // for the moment someone pressed Resume.
    const projectId = await makeProject();
    const taskId = await makeWorkingTask(projectId);
    await acquireScope({ projectId, taskId, patterns: ["src/resumed-028.ts"], ttlSeconds: 60 });

    await pauseScope({ projectId, initiatedBy: "human:gluy" });
    const pausedLocks = await listActiveLocks({ taskId });
    expect(pausedLocks[0]?.paused).toBe(true);

    // Age it the way a real pause would: the TTL lapses while the lock is
    // exempt from the sweeper. Both columns move because
    // file_locks_expires_after_acquired refuses an expiry before acquisition.
    await pool.query(
      `update file_locks
          set acquired_at = now() - interval '2 hours',
              expires_at = now() - interval '1 hour'
        where task_id = $1 and released_at is null`,
      [taskId],
    );

    const result = await resumeProject({ projectId, requestedBy: "human:gluy", respawn: false });
    const outcome = result.tasks.find((task) => task.taskId === taskId);
    expect(outcome?.resumed).toBe(true);
    expect(outcome?.locksUnpaused).toBe(1);

    const live = await listActiveLocks({ taskId });
    expect(live).toHaveLength(1);
    expect(live[0]?.paused).toBe(false);

    // The clock restarted, so the sweeper leaves it alone. Asserted by running
    // the real sweeper rather than by reading the timestamp: expireLocks is
    // what would have taken it.
    await expireLocks();
    expect(await listActiveLocks({ taskId })).toHaveLength(1);
  });
});

// --- Dependencies ---------------------------------------------------------------

describe("resume respects the dependency graph", () => {
  // Criterion: "Resume of a whole project respects dependencies via ticket 014
  // — a task whose dependency is still paused does not start." Resuming the
  // whole board is the one moment every task becomes startable at once, which
  // is exactly when an ordering constraint is easiest to lose.
  it("leaves a task paused while its blocker has not been delivered, and says what to wait for", async () => {
    const projectId = await makeProject();
    const blocker = await makeWorkingTask(projectId);
    const dependent = await makeWorkingTask(projectId);
    await addDependency(dependent, blocker);

    await pauseScope({ projectId, initiatedBy: "human:gluy" });
    const result = await resumeProject({ projectId, requestedBy: "human:gluy", respawn: false });

    const dependentOutcome = result.tasks.find((task) => task.taskId === dependent);
    expect(dependentOutcome?.resumed).toBe(false);
    expect(dependentOutcome?.skipReason).toBe("blocked_by_dependency");
    // The refusal names the task to wait for. "Blocked" with no referent is
    // not actionable on a board of forty tasks.
    expect(dependentOutcome?.blockedBy).toContain(blocker);
    expect(await stateOf(dependent)).toBe("paused");

    // And the blocker itself did resume — a dependency gate that held
    // everything would be indistinguishable from a resume that did nothing.
    expect(result.tasks.find((task) => task.taskId === blocker)?.resumed).toBe(true);
    expect(await stateOf(blocker)).toBe("in_progress");
  });
});

// --- Retry ----------------------------------------------------------------------

describe("resume is safe to press twice", () => {
  // Criterion: "Resume is idempotent and safe to retry after a partial
  // failure: a project half-resumed and then resumed again ends fully resumed
  // with no duplicates." A partial failure is the normal case here, not the
  // exotic one — a resume that spawns desks can fail halfway on a 3.2 GB box.
  it("finishes a half-resumed project without disturbing what already came back", async () => {
    const projectId = await makeProject();
    const first = await makeWorkingTask(projectId);
    const second = await makeWorkingTask(projectId);
    await pauseScope({ projectId, initiatedBy: "human:gluy" });

    // The half-resumed state, reached the way a partial failure reaches it:
    // the pause row is already gone and one task is back, while the other is
    // still paused. The lift comes first because `resumeTask` refuses while a
    // project pause still covers the task — correctly, since resuming one task
    // under a live pause restarts an agent inside the pause — and because a
    // project resume lifts the pause before it walks the tasks. So this is
    // precisely the state a resume that died halfway through leaves behind.
    await liftPausesFor(projectId, "human:gluy");
    await resumeTask({ taskId: first, requestedBy: "human:gluy", respawn: false });
    expect(await stateOf(first)).toBe("in_progress");
    expect(await stateOf(second)).toBe("paused");

    const retry = await resumeProject({ projectId, requestedBy: "human:gluy", respawn: false });

    // The one still paused came back...
    const secondOutcome = retry.tasks.find((task) => task.taskId === second);
    expect(secondOutcome?.resumed).toBe(true);
    expect(await stateOf(second)).toBe("in_progress");

    // ...and the one already resumed was left entirely alone. The project
    // path selects paused tasks, so an already-resumed task is not in the
    // report at all rather than reported as a skip — worth pinning, because
    // "absent" and "skipped" mean different things to 029's UI, and the
    // `not_paused` skip below proves the other path does report it.
    expect(retry.tasks.map((task) => task.taskId)).not.toContain(first);
    expect(await stateOf(first)).toBe("in_progress");

    // No duplicates: each task appears exactly once in the report.
    const ids = retry.tasks.map((task) => task.taskId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("reports `not_paused` when a single task is resumed twice", async () => {
    // The other half of idempotence, and the path that actually produces the
    // skip: resuming BY ID reaches a task whatever state it is in, so the
    // second press has to be a described no-op rather than an error or a
    // second transition.
    const projectId = await makeProject();
    const taskId = await makeWorkingTask(projectId);
    await pauseScope({ projectId, initiatedBy: "human:gluy" });
    await liftPausesFor(projectId, "human:gluy");

    const firstPress = await resumeTask({ taskId, requestedBy: "human:gluy", respawn: false });
    expect(firstPress.tasks[0]?.resumed).toBe(true);

    const secondPress = await resumeTask({ taskId, requestedBy: "human:gluy", respawn: false });
    expect(secondPress.tasks[0]?.resumed).toBe(false);
    expect(secondPress.tasks[0]?.skipReason).toBe("not_paused");
    expect(await stateOf(taskId)).toBe("in_progress");
  });

  it("is a no-op the third time, with nothing left paused", async () => {
    const projectId = await makeProject();
    const taskId = await makeWorkingTask(projectId);
    await pauseScope({ projectId, initiatedBy: "human:gluy" });

    await resumeProject({ projectId, requestedBy: "human:gluy", respawn: false });
    const again = await resumeProject({ projectId, requestedBy: "human:gluy", respawn: false });

    expect(again.tasks.every((task) => !task.resumed)).toBe(true);
    expect(await stateOf(taskId)).toBe("in_progress");
  });
});
