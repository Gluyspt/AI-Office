// Pause and emergency stop against a real database, with the turn-wait and
// the clock injected.
//
// Those two are injected for a reason that is itself a finding. "The agent's
// turn ended" is read from hook events, never from the pane: spike 003
// measured the `esc to interrupt` marker clearing 148–342 ms after a message
// is *submitted* while the turn runs on for seconds, so anything scraping the
// pane reports a working agent as finished almost immediately — which during
// a pause means killing a desk mid-commit and reporting that it stopped
// cleanly. And the clock is injected because the target host's wall clock
// steps backwards (two sightings, −494 ms and −100 ms), so a deadline
// measured against `Date.now()` can expire early or never.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectId, TaskId } from "@office/shared/ids";
import { pool } from "../../core/db/pool.ts";
import { createTask } from "../tasks/model.ts";
import { insertTask } from "../tasks/repo.ts";
import { transition } from "../tasks/states.ts";
import { acquireScope, expireLocks, listActiveLocks } from "../locks/registry.ts";
import {
  ControlError,
  __resetPauseDeps,
  __setPauseDeps,
  activePauseFor,
  activePauses,
  assertStartAllowed,
  emergencyStop,
  liftPausesFor,
  pauseScope,
} from "./pause.ts";

const createdProjects: string[] = [];

async function makeProject(): Promise<ProjectId> {
  const slug = `t028-${randomUUID()}`;
  const result = await pool.query<{ id: string }>(
    `insert into projects (name, slug, repo_url) values ($1, $2, $3) returning id`,
    [slug, slug, "https://example.invalid/repo.git"],
  );
  const id = result.rows[0]!.id;
  createdProjects.push(id);
  return id as ProjectId;
}

/** A task parked in a state a pause is supposed to move. */
async function makeWorkingTask(projectId: ProjectId): Promise<TaskId> {
  const record = await insertTask(
    createTask({ projectId, title: "pausable work", department: "dev", owner: "gluy" }),
  );
  await transition({
    taskId: record.id,
    to: "pending",
    actor: "test",
    actorKind: "system",
  });
  await transition({
    taskId: record.id,
    to: "in_progress",
    actor: "test",
    actorKind: "system",
  });
  return record.id;
}

let turnEnds = true;
let now = 0;

beforeEach(() => {
  turnEnds = true;
  now = 0;
  __setPauseDeps({
    waitForTurnEnd: async () => turnEnds,
    // Monotonic and injected: a real clock here would make the deadline
    // assertions measure the host rather than the code.
    monotonicMs: () => (now += 10),
  });
});

afterAll(async () => {
  __resetPauseDeps();
  for (const id of createdProjects) {
    await pool.query("delete from projects where id = $1", [id]);
  }
});

// --- Identity and audit ---------------------------------------------------------

describe("every pause records who pressed it", () => {
  it("refuses a blank actor — an anonymous stop is the one audit record nobody can follow up", async () => {
    const projectId = await makeProject();
    await expect(pauseScope({ projectId, initiatedBy: "   " })).rejects.toBeInstanceOf(
      ControlError,
    );
    await expect(emergencyStop({ projectId, initiatedBy: "" })).rejects.toBeInstanceOf(
      ControlError,
    );
  });

  it("records the scope, the actor and the reason", async () => {
    const projectId = await makeProject();
    const result = await pauseScope({
      projectId,
      initiatedBy: "human:gluy",
      reason: "rate limited",
    });
    expect(result.pause.initiatedBy).toBe("human:gluy");
    expect(result.pause.reason).toBe("rate limited");
    expect(result.pause.projectId).toBe(projectId);
    expect(result.pause.kind).toBe("graceful");
  });

  it("records the deadline that was in force, not the one configured now", async () => {
    // So an audit can answer "was 20s too short?" after the number has been
    // changed.
    const projectId = await makeProject();
    const result = await pauseScope({ projectId, initiatedBy: "human:gluy", deadlineMs: 1234 });
    expect(result.pause.deadlineMs).toBe(1234);
  });

  it("gives an emergency stop no deadline — it has none by definition", async () => {
    const projectId = await makeProject();
    const result = await emergencyStop({ projectId, initiatedBy: "human:gluy" });
    expect(result.pause.kind).toBe("emergency");
    expect(result.pause.deadlineMs).toBeNull();
  });
});

// --- What a pause blocks --------------------------------------------------------

describe("a pause is in effect from the instant it is pressed", () => {
  it("refuses start_session for a paused project", async () => {
    // Not from `completedAt`: start_session has to be refused the moment
    // someone presses the button, not when the last agent has been killed.
    const projectId = await makeProject();
    await expect(assertStartAllowed(projectId)).resolves.toBeUndefined();
    await pauseScope({ projectId, initiatedBy: "human:gluy" });
    await expect(assertStartAllowed(projectId)).rejects.toMatchObject({
      kind: "project_paused",
    });
  });

  it("leaves another project startable — a project pause is not an office pause", async () => {
    const paused = await makeProject();
    const other = await makeProject();
    await pauseScope({ projectId: paused, initiatedBy: "human:gluy" });
    await expect(assertStartAllowed(other)).resolves.toBeUndefined();
  });

  it("a global pause covers every project", async () => {
    const projectId = await makeProject();
    await pauseScope({ projectId: null, initiatedBy: "human:gluy" });
    await expect(assertStartAllowed(projectId)).rejects.toMatchObject({
      kind: "project_paused",
    });
    await liftPausesFor(null, "human:gluy");
  });
});

// --- Idempotence and durability -------------------------------------------------

describe("pause is idempotent and survives a restart", () => {
  it("a second pause over the same scope is visibly a no-op, not an error", async () => {
    const projectId = await makeProject();
    await makeWorkingTask(projectId);
    const first = await pauseScope({ projectId, initiatedBy: "human:gluy" });
    expect(first.alreadyPaused).toBe(false);

    const second = await pauseScope({ projectId, initiatedBy: "human:gluy" });
    expect(second.alreadyPaused).toBe(true);
    // Reported rather than counted in, so a repeat does not look like it
    // paused everything twice.
    expect(second.tasksPaused).toEqual([]);
  });

  it("the flag is a row, so it holds across a restart", async () => {
    // A pause held only in memory is not a pause: the whole point is that it
    // holds when things are going wrong, which includes the orchestrator
    // having just been restarted. Reading it back from the database with no
    // in-process state is the closest a unit test gets to proving that.
    const projectId = await makeProject();
    await pauseScope({ projectId, initiatedBy: "human:gluy" });
    const reread = await activePauseFor(projectId);
    expect(reread).not.toBeNull();
    expect(reread?.liftedAt).toBeNull();
  });
});

// --- Tasks ----------------------------------------------------------------------

describe("what a pause does to the board", () => {
  it("moves pausable tasks to paused and reports which", async () => {
    const projectId = await makeProject();
    const taskId = await makeWorkingTask(projectId);
    const result = await pauseScope({ projectId, initiatedBy: "human:gluy" });
    expect(result.tasksPaused).toContain(taskId);

    const { rows } = await pool.query<{ state: string }>(
      `select state from tasks where id = $1`,
      [taskId],
    );
    expect(rows[0]?.state).toBe("paused");
  });

  it("returns the seam notices, so a caller cannot show a report without them", async () => {
    // The handoff node is a NAMED SEAM that no-ops: the knowledge graph is
    // build step 5 and does not exist. 029's UI must say so rather than
    // promise "Full context".
    const projectId = await makeProject();
    const result = await pauseScope({ projectId, initiatedBy: "human:gluy" });
    expect(result.notices.length).toBeGreaterThan(0);
    expect(result.notices.join(" ")).toMatch(/handoff|context/i);
  });
});

// --- Emergency stop -------------------------------------------------------------

describe("emergency stop differs from pause", () => {
  it("does not wait for turns to end", async () => {
    // Graceful asks and waits; emergency does neither. If this called
    // waitForTurnEnd the injected false below would change the outcome.
    turnEnds = false;
    const projectId = await makeProject();
    const result = await emergencyStop({ projectId, initiatedBy: "human:gluy" });
    expect(result.pause.kind).toBe("emergency");
    expect(result.alreadyPaused).toBe(false);
  });

  it("can take over from a graceful pause still waiting out its deadline", async () => {
    const projectId = await makeProject();
    await pauseScope({ projectId, initiatedBy: "human:gluy", deadlineMs: 50 });
    const stopped = await emergencyStop({ projectId, initiatedBy: "human:gluy" });
    expect(stopped.pause.kind).toBe("emergency");
  });
});

// --- Lifting --------------------------------------------------------------------

describe("liftPausesFor", () => {
  it("lifts the pause and makes the project startable again", async () => {
    const projectId = await makeProject();
    await pauseScope({ projectId, initiatedBy: "human:gluy" });
    await liftPausesFor(projectId, "human:gluy");
    expect(await activePauseFor(projectId)).toBeNull();
    await expect(assertStartAllowed(projectId)).resolves.toBeUndefined();
  });

  it("records who lifted it", async () => {
    const projectId = await makeProject();
    await pauseScope({ projectId, initiatedBy: "human:gluy" });
    await liftPausesFor(projectId, "human:ronna");
    const { rows } = await pool.query<{ lifted_by: string | null }>(
      `select lifted_by from pause_state where project_id = $1 order by started_at desc limit 1`,
      [projectId],
    );
    expect(rows[0]?.lifted_by).toBe("human:ronna");
  });

  it("lifting a scope with no pause is not an error", async () => {
    const projectId = await makeProject();
    await expect(liftPausesFor(projectId, "human:gluy")).resolves.toBeDefined();
  });
});

// --- Reads ----------------------------------------------------------------------

describe("activePauses", () => {
  it("returns the reason and the actor, not just the fact", async () => {
    // A banner that says only "paused" sends someone to ask in chat what
    // happened.
    const projectId = await makeProject();
    await pauseScope({ projectId, initiatedBy: "human:gluy", reason: "deploy window" });
    const pauses = await activePauses(projectId);
    expect(pauses).toHaveLength(1);
    expect(pauses[0]?.reason).toBe("deploy window");
    expect(pauses[0]?.initiatedBy).toBe("human:gluy");
  });

  it("excludes a lifted pause", async () => {
    const projectId = await makeProject();
    await pauseScope({ projectId, initiatedBy: "human:gluy" });
    await liftPausesFor(projectId, "human:gluy");
    expect(await activePauses(projectId)).toEqual([]);
  });
});

// --- Precedence: in flight is not the same as done ------------------------------

// EVERY TEST BELOW CLEANS UP ITS OWN pause_state ROWS, and that is not
// housekeeping. `createdProjects` in afterAll cannot do it: a pause row for the
// whole office has `project_id = null`, so no project cascade reaches it, and
// `lifted_at is null` means "still in effect". One leaked global row makes
// `assertStartAllowed` refuse every project and makes `pauseScope` refuse every
// later pause as interleaving — in this file and in every other file, because
// they share one database. Written the slow way after a draft of these tests
// leaked exactly one row and took 20 unrelated tests down with it.
const createdPauses: string[] = [];

afterEach(async () => {
  if (createdPauses.length === 0) return;
  await pool.query(`delete from pause_state where id = any($1::uuid[])`, [createdPauses.splice(0)]);
});

describe("a pause already in flight", () => {
  // Criterion: "Pause during an in-flight pause is rejected rather than
  // interleaved." This is NOT the idempotence asserted above, and the
  // difference is the point: a *completed* pause over the same scope is a
  // no-op, while one still running must be refused. Two choreographies sharing
  // even one project would interleave their interrupts, instructions and kills
  // — one killing a desk the other is still waiting on, and both reporting
  // that they stopped it cleanly.
  //
  // In flight is `completed_at is null` on an unlifted row, so it is set
  // directly rather than by racing a real choreography. That is also the only
  // way to reach it here: the graceful path blocks only while waiting on an
  // agent's turn, and waiting on one needs a live session and tmux.
  async function openInFlightPause(
    projectId: ProjectId | null,
    kind: "graceful" | "emergency" = "graceful",
  ): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `insert into pause_state (project_id, kind, initiated_by, reason, deadline_ms)
       values ($1, $2, 'human:fixture', 'still running', $3)
       returning id`,
      // An emergency stop has no deadline by definition, and
      // pause_state_deadline_matches_kind enforces it. A fixture that ignored
      // that would be testing a row the system cannot produce.
      [projectId, kind, kind === "emergency" ? null : 60000],
    );
    const id = rows[0]!.id;
    createdPauses.push(id);
    return id;
  }

  it("refuses a second graceful pause rather than interleaving with it", async () => {
    const projectId = await makeProject();
    const taskId = await makeWorkingTask(projectId);
    await openInFlightPause(projectId);

    await expect(pauseScope({ projectId, initiatedBy: "human:gluy" })).rejects.toBeInstanceOf(
      ControlError,
    );
    // It names what it is deferring to: the useful answer to "why can't I
    // pause" is "someone already is".
    await expect(pauseScope({ projectId, initiatedBy: "human:gluy" })).rejects.toThrow(/in flight/i);

    // The refusal left the board alone. A rejected pause must not half-pause
    // anything on its way out.
    const { rows } = await pool.query<{ state: string }>(`select state from tasks where id = $1`, [
      taskId,
    ]);
    expect(rows[0]?.state).toBe("in_progress");
  });

  it("refuses a project pause while a GLOBAL pause is in flight", async () => {
    // Overlap, not equality, is the test: two different scope rows can mean
    // the same agents, so running both choreographies interleaves them.
    const projectId = await makeProject();
    await openInFlightPause(null);
    await expect(pauseScope({ projectId, initiatedBy: "human:gluy" })).rejects.toThrow(
      /whole office/i,
    );
    await expect(pauseScope({ initiatedBy: "human:gluy" })).rejects.toThrow(/in flight/i);
  });

  it("lets an EMERGENCY STOP take over from a graceful pause that is still in flight", async () => {
    // The inverse rule, and why it is not symmetric: a graceful pause hanging
    // on its deadline is exactly when someone reaches for the big red button.
    // Refusing the stop then would make a stuck pause unstoppable.
    const projectId = await makeProject();
    const stuck = await openInFlightPause(projectId);

    const stopped = await emergencyStop({ projectId, initiatedBy: "human:gluy" });
    createdPauses.push(stopped.pause.id);
    expect(stopped.pause.kind).toBe("emergency");

    // The superseded row is lifted and points at the stop that took over, so
    // the trail survives instead of two active rows over one scope.
    const { rows } = await pool.query<{ lifted_at: string | null; escalated_to: string | null }>(
      `select lifted_at::text as lifted_at, escalated_to from pause_state where id = $1`,
      [stuck],
    );
    expect(rows[0]?.lifted_at).not.toBeNull();
    expect(rows[0]?.escalated_to).toBe(stopped.pause.id);
  });

  it("refuses a second emergency stop while one is in flight", async () => {
    const projectId = await makeProject();
    await openInFlightPause(projectId, "emergency");
    await expect(emergencyStop({ projectId, initiatedBy: "human:gluy" })).rejects.toThrow(
      /already in flight/i,
    );
  });

  it("does NOT let a one-project stop lift a global pause", async () => {
    // Superseding is limited to rows this scope covers. A stop on one project
    // lifting the office-wide pause would restart every other project in the
    // office as a side effect of stopping one.
    const projectId = await makeProject();
    const global = await pauseScope({ initiatedBy: "human:gluy", reason: "office-wide" });
    createdPauses.push(global.pause.id);
    const stopped = await emergencyStop({ projectId, initiatedBy: "human:gluy" });
    createdPauses.push(stopped.pause.id);
    expect(stopped.pause.kind).toBe("emergency");

    const { rows } = await pool.query<{ lifted_at: string | null }>(
      `select lifted_at::text as lifted_at from pause_state where id = $1`,
      [global.pause.id],
    );
    expect(rows[0]?.lifted_at).toBeNull();
  });
});

// --- Locks ----------------------------------------------------------------------

describe("what a pause does to the locks", () => {
  // Criterion: "every affected task is `paused` and its locks are kept and
  // marked paused, exempt from TTL expiry — asserted against ticket 015's
  // sweeper." Ticket 015 asserts the exemption itself (a paused lock survives
  // `expireLocks`). What nothing asserted until now is the half that belongs
  // here: that a pause actually MARKS them. Without that call the locks stay
  // unpaused, their TTL runs out while the office is stopped, the sweeper
  // reclaims them, and a paused task silently loses the files it owns — with
  // nothing in the pause report saying so.
  it("keeps the locks and marks them paused, so the sweeper cannot reclaim them", async () => {
    const projectId = await makeProject();
    const taskId = await makeWorkingTask(projectId);
    await acquireScope({ projectId, taskId, patterns: ["src/paused-by-028.ts"], ttlSeconds: 60 });

    const paused = await pauseScope({ projectId, initiatedBy: "human:gluy" });
    createdPauses.push(paused.pause.id);

    const held = await listActiveLocks({ taskId });
    expect(held).toHaveLength(1);
    expect(held[0]?.paused).toBe(true);

    // The join with 015 the criterion asks for: age the lock past its TTL and
    // run the real sweeper. A paused lock is exempt, so the task still owns
    // its files when it resumes.
    await pool.query(
      // Both columns move: file_locks_expires_after_acquired refuses an
      // expiry that precedes its own acquisition, so ageing only expires_at
      // would be an impossible row rather than an expired lock.
      `update file_locks
          set acquired_at = now() - interval '2 hours',
              expires_at = now() - interval '1 hour'
        where task_id = $1 and released_at is null`,
      [taskId],
    );
    await expireLocks();
    const afterSweep = await listActiveLocks({ taskId });
    expect(afterSweep).toHaveLength(1);
    expect(afterSweep[0]?.paused).toBe(true);
  });

  it("marks the locks of a task that was ALREADY paused", async () => {
    // A task paused on its own earlier may still hold unpaused locks. The
    // criterion is about the state of the locks, not about which call moved
    // the task, so a pause that skipped them would leave exactly the gap above.
    const projectId = await makeProject();
    const taskId = await makeWorkingTask(projectId);
    await acquireScope({
      projectId,
      taskId,
      patterns: ["src/already-paused-028.ts"],
      ttlSeconds: 60,
    });
    await transition({
      taskId,
      to: "paused",
      actor: "test",
      actorKind: "system",
      reason: "paused on its own, before the office-wide pause",
    });

    const result = await pauseScope({ projectId, initiatedBy: "human:gluy" });
    createdPauses.push(result.pause.id);
    expect(result.tasksPaused).not.toContain(taskId);

    const held = await listActiveLocks({ taskId });
    expect(held[0]?.paused).toBe(true);
  });
});
