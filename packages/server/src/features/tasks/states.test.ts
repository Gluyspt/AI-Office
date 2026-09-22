// The state machine, tested at two levels:
//
//   - **Pure**, against the table: the whole 10x10 matrix, every pair, no
//     sampling. A sampled matrix is how an illegal edge gets added by
//     accident and nobody notices for three tickets.
//   - **Against real Postgres**: every legal edge actually applied, the
//     audit row actually written, and the three triggers in
//     0005_tasks.sql actually refusing the ways round transition().
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TASK_STATES, type TaskState } from "@office/shared/tasks";
import { asProjectId, type ProjectId, type TaskId } from "@office/shared/ids";
import { pool, withTransaction } from "../../core/db/pool.ts";
import { createTask } from "./model.ts";
import {
  ConcurrentTransitionError,
  IllegalTransitionError,
  PAUSABLE_STATES,
  TASK_TRANSITIONS,
  TaskNotFoundError,
  checkTransition,
  isLegalTransition,
  legalTargets,
  pausedOriginState,
  taskStateHistory,
  transition,
} from "./states.ts";

const serverSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const repoRoot = path.resolve(serverSrc, "../../..");

// --- The expected edge set, written out by hand -------------------------------
//
// Transcribed from the design's lifecycle diagram arrow by arrow, plus the
// pause rule. Deliberately NOT derived from TASK_TRANSITIONS - a test that
// computes its expectation from the thing under test proves nothing.

const DIAGRAM_EDGES: ReadonlyArray<readonly [TaskState, TaskState]> = [
  ["draft", "pending"], // start working
  ["pending", "in_progress"],
  ["in_progress", "paused"], // pause
  ["paused", "in_progress"], // resume
  ["in_progress", "ready_for_qa"],
  ["ready_for_qa", "ci"],
  ["ci", "in_progress"], // fail
  ["ci", "qa_review"], // pass
  ["qa_review", "in_progress"], // reject
  ["qa_review", "lead_approval"], // approve
  ["lead_approval", "delivered"],
  ["delivered", "done"], // accept
  ["delivered", "in_progress"], // send back
];

/** The states work can be in flight in - see PAUSABLE_STATES' comment for
 * why `draft` and `done` are excluded, an assumption this ticket states
 * rather than a fact the design gives. */
const EXPECTED_PAUSABLE: readonly TaskState[] = [
  "pending",
  "in_progress",
  "ready_for_qa",
  "ci",
  "qa_review",
  "lead_approval",
  "delivered",
];

const EXPECTED_EDGES = new Set<string>([
  ...DIAGRAM_EDGES.map(([from, to]) => `${from}->${to}`),
  ...EXPECTED_PAUSABLE.flatMap((state) => [`${state}->paused`, `paused->${state}`]),
]);

// --- Pure: the table -----------------------------------------------------------

describe("the transition table", () => {
  it("contains every arrow in the design's lifecycle diagram", () => {
    for (const [from, to] of DIAGRAM_EDGES) {
      expect(isLegalTransition(from, to), `${from} -> ${to} should be legal`).toBe(true);
    }
  });

  it("has both edges out of delivered, and both out of CI", () => {
    expect(new Set(legalTargets("delivered"))).toEqual(new Set(["done", "in_progress", "paused"]));
    expect(new Set(legalTargets("ci"))).toEqual(new Set(["in_progress", "qa_review", "paused"]));
  });

  it("pauses from every in-flight state and nowhere else", () => {
    expect([...PAUSABLE_STATES]).toEqual([...EXPECTED_PAUSABLE]);
    expect(isLegalTransition("draft", "paused")).toBe(false);
    expect(isLegalTransition("done", "paused")).toBe(false);
  });

  it("leaves done terminal", () => {
    expect(legalTargets("done")).toEqual([]);
  });

  it("refuses in_progress -> done: a dev cannot reach done in one step", () => {
    // "A dev calling complete_task moves the task to ready for QA, never
    // straight to done." The three test stages are the whole point.
    expect(isLegalTransition("in_progress", "done")).toBe(false);
    const check = checkTransition("in_progress", "done");
    expect(check.ok).toBe(false);
    expect(new Set(legalTargets("in_progress"))).toEqual(new Set(["paused", "ready_for_qa"]));
  });

  it("agrees with the whole 10x10 matrix - every pair, legal and illegal", () => {
    const wrong: string[] = [];
    let legal = 0;
    let illegal = 0;
    for (const from of TASK_STATES) {
      for (const to of TASK_STATES) {
        const edge = `${from}->${to}`;
        const expected = EXPECTED_EDGES.has(edge);
        if (isLegalTransition(from, to) !== expected) {
          wrong.push(`${edge} should be ${expected ? "legal" : "illegal"}`);
        }
        if (expected) legal += 1;
        else illegal += 1;
      }
    }
    expect(wrong).toEqual([]);
    // 100 pairs accounted for, so this really is the full matrix.
    expect(legal + illegal).toBe(TASK_STATES.length ** 2);
    expect(legal).toBe(EXPECTED_EDGES.size);
    expect(legal).toBe(25);
    expect(illegal).toBe(75);
  });

  it("rejects every illegal pair through checkTransition, with a reason", () => {
    for (const from of TASK_STATES) {
      for (const to of TASK_STATES) {
        if (EXPECTED_EDGES.has(`${from}->${to}`)) continue;
        // Generous context: a reason, and a pause origin that would satisfy
        // the resume guard. Nothing about the situation should rescue an
        // edge that is not in the table.
        const check = checkTransition(from, to, { reason: "because", pausedFrom: to });
        expect(check.ok, `${from} -> ${to} must be refused`).toBe(false);
        if (!check.ok) expect(check.detail.length).toBeGreaterThan(0);
      }
    }
  });

  it("refuses a no-op as its own kind of mistake", () => {
    for (const state of TASK_STATES) {
      const check = checkTransition(state, state);
      expect(check.ok).toBe(false);
      if (!check.ok) expect(check.detail).toMatch(/already the current state/);
    }
  });

  it("returns a task to the state it was paused from, and to nothing else", () => {
    for (const origin of PAUSABLE_STATES) {
      expect(checkTransition("paused", origin, { pausedFrom: origin }).ok).toBe(true);
      for (const other of PAUSABLE_STATES) {
        if (other === origin) continue;
        const check = checkTransition("paused", other, { pausedFrom: origin });
        expect(check.ok, `resume ${origin} -> ${other} must be refused`).toBe(false);
      }
    }
  });

  it("refuses to resume a task whose pause has no recorded origin", () => {
    const check = checkTransition("paused", "in_progress", {});
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.detail).toMatch(/no history row records/);
  });

  it("requires a reason exactly where the design asks for one", () => {
    const needsReason = TASK_TRANSITIONS.filter((rule) => rule.requiresReason).map(
      (rule) => `${rule.from}->${rule.to}`,
    );
    expect(new Set(needsReason)).toEqual(
      new Set([
        // reject_task(task_id, reason)
        "qa_review->in_progress",
        // Send back "reopens the task with your comment"
        "delivered->in_progress",
        // a CI failure has a failure to report
        "ci->in_progress",
        // which interruption this was - manual, crash, breaker, rate limit
        ...EXPECTED_PAUSABLE.map((state) => `${state}->paused`),
      ]),
    );
    expect(checkTransition("qa_review", "in_progress", {}).ok).toBe(false);
    expect(checkTransition("qa_review", "in_progress", { reason: "  " }).ok).toBe(false);
    expect(checkTransition("qa_review", "in_progress", { reason: "missing tests" }).ok).toBe(true);
  });
});

describe("the SQL check constraint and the TypeScript union", () => {
  it("list the same ten states", async () => {
    const sql = await readFile(path.join(repoRoot, "db/migrations/0005_tasks.sql"), "utf8");
    const match = sql.match(/state in \(([^)]*)\)/);
    expect(match, "0005_tasks.sql should constrain tasks.state").toBeTruthy();
    const fromSql = [...(match?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(fromSql).toEqual([...TASK_STATES]);
  });
});

// --- Against Postgres ------------------------------------------------------------

let projectId: ProjectId;

async function makeTask(): Promise<TaskId> {
  const task = createTask({
    projectId,
    title: "state machine fixture",
    department: "dev",
    owner: "fixture-owner",
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
  return task.id;
}

async function stateOf(taskId: TaskId): Promise<TaskState> {
  const result = await pool.query<{ state: TaskState }>("select state from tasks where id = $1", [
    taskId,
  ]);
  return result.rows[0]!.state;
}

/** The forward path through the pipeline, so a test can put a task in any
 * state without hand-writing the walk each time. */
const FORWARD_PATH: readonly TaskState[] = [
  "pending",
  "in_progress",
  "ready_for_qa",
  "ci",
  "qa_review",
  "lead_approval",
  "delivered",
  "done",
];

async function driveTo(taskId: TaskId, target: TaskState): Promise<void> {
  const stop = FORWARD_PATH.indexOf(target);
  if (stop < 0) throw new Error(`no forward route to ${target}`);
  for (const next of FORWARD_PATH.slice(0, stop + 1)) {
    await transition({ taskId, to: next, actor: "driver", actorKind: "system", reason: "fixture" });
  }
}

beforeAll(async () => {
  const result = await pool.query<{ id: string }>(
    `insert into projects (name, slug, repo_url) values ($1, $2, $3) returning id`,
    ["ticket 012 test project", `t012-${Date.now()}-${Math.random().toString(36).slice(2)}`, "git@example.com:t012.git"],
  );
  projectId = asProjectId(result.rows[0]!.id);
});

afterAll(async () => {
  // tasks and task_state_history cascade from the project row.
  if (projectId) await pool.query("delete from projects where id = $1", [projectId]);
});

describe("transition() against the database", () => {
  it("applies every legal edge in the table for real", async () => {
    for (const rule of TASK_TRANSITIONS) {
      const taskId = await makeTask();
      if (rule.from === "paused") {
        // Reach `paused` *from* this edge's target, so resume has the right
        // origin to return to.
        await driveTo(taskId, rule.to);
        await transition({ taskId, to: "paused", actor: "supervisor", actorKind: "system", reason: "crash" });
      } else if (rule.from !== "draft") {
        await driveTo(taskId, rule.from);
      }

      const result = await transition({
        taskId,
        to: rule.to,
        actor: "edge-test",
        actorKind: "human",
        reason: rule.requiresReason ? `because: ${rule.label}` : null,
      });

      expect(result.task.state, `${rule.from} -> ${rule.to}`).toBe(rule.to);
      expect(result.change.fromState).toBe(rule.from);
      expect(result.change.toState).toBe(rule.to);
      expect(await stateOf(taskId)).toBe(rule.to);
    }
  });

  it("writes an audit row with actor, kind, reason and timestamp", async () => {
    const taskId = await makeTask();
    const before = Date.now();
    const { change, task } = await transition({
      taskId,
      to: "pending",
      actor: "gluy",
      actorKind: "human",
      reason: "start working",
    });
    expect(change.actor).toBe("gluy");
    expect(change.actorKind).toBe("human");
    expect(change.reason).toBe("start working");
    expect(change.occurredAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    // The audit row's timestamp IS the task's state_entered_at - which is
    // what lets the card render "pending / 2d" without reading history.
    expect(change.occurredAt.getTime()).toBe(task.stateEnteredAt.getTime());
  });

  it("reconstructs a task's full path from history alone", async () => {
    const taskId = await makeTask();
    await driveTo(taskId, "in_progress");
    await transition({ taskId, to: "paused", actor: "supervisor", actorKind: "system", reason: "rate limit" });
    await transition({ taskId, to: "in_progress", actor: "gluy", actorKind: "human" });
    await transition({ taskId, to: "ready_for_qa", actor: "dev-agent", actorKind: "agent" });
    await transition({ taskId, to: "ci", actor: "orchestrator", actorKind: "system" });
    await transition({ taskId, to: "in_progress", actor: "orchestrator", actorKind: "system", reason: "tests failed" });
    for (const next of ["ready_for_qa", "ci", "qa_review", "lead_approval", "delivered", "done"] as const) {
      await transition({ taskId, to: next, actor: "pipeline", actorKind: "system" });
    }

    const history = await taskStateHistory(taskId);
    const path = [history[0]!.fromState, ...history.map((entry) => entry.toState)];
    expect(path).toEqual([
      "draft",
      "pending",
      "in_progress",
      "paused",
      "in_progress",
      "ready_for_qa",
      "ci",
      "in_progress",
      "ready_for_qa",
      "ci",
      "qa_review",
      "lead_approval",
      "delivered",
      "done",
    ]);
    // Reasons survived, so an audit can answer "why did CI send it back".
    expect(history.find((entry) => entry.fromState === "ci" && entry.toState === "in_progress")?.reason)
      .toBe("tests failed");
  });

  it("pauses from four or more origins and resumes each to where it came from", async () => {
    for (const origin of PAUSABLE_STATES) {
      const taskId = await makeTask();
      await driveTo(taskId, origin);
      await transition({ taskId, to: "paused", actor: "gluy", actorKind: "human", reason: "manual pause" });
      expect(await stateOf(taskId)).toBe("paused");
      expect(await pausedOriginState(taskId)).toBe(origin);

      // Resuming anywhere else is refused...
      const wrong = PAUSABLE_STATES.find((state) => state !== origin)!;
      await expect(
        transition({ taskId, to: wrong, actor: "gluy", actorKind: "human" }),
      ).rejects.toBeInstanceOf(IllegalTransitionError);

      // ...and the real origin works.
      const resumed = await transition({ taskId, to: origin, actor: "gluy", actorKind: "human" });
      expect(resumed.task.state).toBe(origin);
    }
    expect(PAUSABLE_STATES.length).toBeGreaterThanOrEqual(4);
  });

  it("rejects an illegal transition with a typed error and changes nothing", async () => {
    const taskId = await makeTask();
    await driveTo(taskId, "in_progress");
    await expect(
      transition({ taskId, to: "done", actor: "dev-agent", actorKind: "agent" }),
    ).rejects.toBeInstanceOf(IllegalTransitionError);
    expect(await stateOf(taskId)).toBe("in_progress");
    expect(await taskStateHistory(taskId)).toHaveLength(2);
  });

  it("rejects a required-reason edge with no reason", async () => {
    const taskId = await makeTask();
    await driveTo(taskId, "ci");
    await expect(
      transition({ taskId, to: "in_progress", actor: "ci", actorKind: "system" }),
    ).rejects.toThrow(/requires a reason/);
    expect(await stateOf(taskId)).toBe("ci");
  });

  it("rejects a transition with no actor", async () => {
    const taskId = await makeTask();
    await expect(
      transition({ taskId, to: "pending", actor: "  ", actorKind: "human" }),
    ).rejects.toThrow(/must record an actor/);
    expect(await stateOf(taskId)).toBe("draft");
  });

  it("fails loudly when the task moved under the caller", async () => {
    const taskId = await makeTask();
    await transition({ taskId, to: "pending", actor: "gluy", actorKind: "human" });
    await expect(
      transition({ taskId, to: "in_progress", actor: "a", actorKind: "agent", expectedFrom: "draft" }),
    ).rejects.toBeInstanceOf(ConcurrentTransitionError);
  });

  it("fails loudly for a task that does not exist", async () => {
    await expect(
      transition({
        taskId: "00000000-0000-4000-8000-000000000000" as TaskId,
        to: "pending",
        actor: "gluy",
        actorKind: "human",
      }),
    ).rejects.toBeInstanceOf(TaskNotFoundError);
  });

  it("commits the state change and its audit row together, or neither", async () => {
    const taskId = await makeTask();
    await withTransaction(async (client) => {
      await transition({ taskId, to: "pending", actor: "gluy", actorKind: "human" }, client);
      expect(await stateOf(taskId)).toBe("draft"); // not visible outside the txn yet
      throw new Error("caller changed its mind");
    }).catch(() => undefined);
    expect(await stateOf(taskId)).toBe("draft");
    expect(await taskStateHistory(taskId)).toHaveLength(0);
  });

  it("leaves state_entered_at alone when something other than state is edited", async () => {
    // This is what makes the card's "paused / 2d" correct: renaming a task
    // must not restart its clock.
    const taskId = await makeTask();
    await transition({ taskId, to: "pending", actor: "gluy", actorKind: "human" });
    const before = await pool.query<{ state_entered_at: Date; updated_at: Date }>(
      "select state_entered_at, updated_at from tasks where id = $1",
      [taskId],
    );
    await pool.query("update tasks set title = $2 where id = $1", [taskId, "renamed"]);
    const after = await pool.query<{ state_entered_at: Date; updated_at: Date }>(
      "select state_entered_at, updated_at from tasks where id = $1",
      [taskId],
    );
    expect(after.rows[0]!.state_entered_at.getTime()).toBe(before.rows[0]!.state_entered_at.getTime());
    expect(after.rows[0]!.updated_at.getTime()).toBeGreaterThan(before.rows[0]!.updated_at.getTime());
  });

  it("defaults token_cost and turn_count to zero, never null", async () => {
    const taskId = await makeTask();
    const row = await pool.query<{ token_cost: string; turn_count: number }>(
      "select token_cost, turn_count from tasks where id = $1",
      [taskId],
    );
    expect(row.rows[0]!.token_cost).toBe("0");
    expect(row.rows[0]!.turn_count).toBe(0);
    const { task } = await transition({ taskId, to: "pending", actor: "gluy", actorKind: "human" });
    expect(task.tokenCost).toBe(0);
    expect(task.turnCount).toBe(0);
  });
});

// --- The structural guarantee ------------------------------------------------------

describe("nothing else can change tasks.state", () => {
  it("refuses a direct UPDATE of the state column (SQLSTATE OF001)", async () => {
    const taskId = await makeTask();
    await expect(
      pool.query("update tasks set state = 'done' where id = $1", [taskId]),
    ).rejects.toMatchObject({ code: "OF001" });
    expect(await stateOf(taskId)).toBe("draft");
  });

  it("refuses a task inserted directly into any state but draft (SQLSTATE OF003)", async () => {
    await expect(
      pool.query(
        `insert into tasks (project_id, title, department, owner, state)
         values ($1, 'smuggled', 'dev', 'o', 'done')`,
        [projectId],
      ),
    ).rejects.toMatchObject({ code: "OF003" });
  });

  it("refuses a state change with no audit row, even with the guard flag set (SQLSTATE OF002)", async () => {
    const taskId = await makeTask();
    await expect(
      withTransaction(async (client) => {
        await client.query(`set local office.task_transition = 'on'`);
        await client.query("update tasks set state = 'pending' where id = $1", [taskId]);
      }),
    ).rejects.toMatchObject({ code: "OF002" });
    expect(await stateOf(taskId)).toBe("draft");
  });

  it("re-arms the guard inside a caller-supplied transaction", async () => {
    // transition() opts the transaction in and opts it straight back out,
    // so a caller that goes on to do other writes in the same transaction
    // cannot ride on the flag transition() set.
    const taskId = await makeTask();
    await expect(
      withTransaction(async (client) => {
        await transition({ taskId, to: "pending", actor: "gluy", actorKind: "human" }, client);
        await client.query("update tasks set state = 'done' where id = $1", [taskId]);
      }),
    ).rejects.toMatchObject({ code: "OF001" });
    expect(await stateOf(taskId)).toBe("draft");
  });

  it("has no other module writing the state column", async () => {
    // The database triggers above are the real guarantee; this grep is the
    // early warning, so a would-be second writer is caught at review time
    // rather than at runtime.
    const { readdir } = await import("node:fs/promises");
    const offenders: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        if (full === path.join(serverSrc, "features", "tasks", "states.ts")) continue;
        if (entry.name.endsWith(".test.ts")) continue;
        const source = await readFile(full, "utf8");
        if (/update\s+tasks\s+set[^;`]*\bstate\s*=/is.test(source)) {
          offenders.push(path.relative(repoRoot, full));
        }
        if (/office\.task_transition/i.test(source)) {
          offenders.push(`${path.relative(repoRoot, full)} (sets the transition guard flag)`);
        }
      }
    };
    await walk(serverSrc);
    expect(offenders).toEqual([]);
  });
});
