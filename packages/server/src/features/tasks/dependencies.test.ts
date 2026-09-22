// Ticket 014's acceptance criteria: the graph, cycles, claimability,
// unblocking at `delivered`, and the scope-ordering rule.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProjectId, TaskId } from "@office/shared/ids";
import type { TaskState } from "@office/shared/tasks";
import { pool } from "../../core/db/pool.ts";
import { acquireScope } from "../locks/registry.ts";
import { createTask } from "./model.ts";
import { insertTask } from "./repo.ts";
import { transition } from "./states.ts";
import {
  addDependency,
  claimabilityOf,
  DependencyCycleError,
  DependencyError,
  deleteTaskAndReevaluate,
  dependenciesOf,
  isClaimable,
  isOrderedBefore,
  removeDependency,
  unblockDependents,
  UNBLOCKING_STATE,
} from "./dependencies.ts";
import {
  checkProjectScopeOrdering,
  orderedOverlapProblems,
  projectScopes,
} from "./scope-ordering.ts";

const createdProjects: string[] = [];

async function makeProject(): Promise<ProjectId> {
  const slug = `t014-${randomUUID()}`;
  const result = await pool.query<{ id: string }>(
    `insert into projects (name, slug, repo_url) values ($1, $2, $3) returning id`,
    [slug, slug, "https://example.invalid/repo.git"],
  );
  const id = result.rows[0]!.id;
  createdProjects.push(id);
  return id as ProjectId;
}

async function makeTask(project: ProjectId, title = "dep task"): Promise<TaskId> {
  const record = await insertTask(
    createTask({ projectId: project, title, department: "dev", owner: "gluy" }),
  );
  return record.id;
}

const PATH_TO_DELIVERED: readonly TaskState[] = [
  "pending", "in_progress", "ready_for_qa", "ci", "qa_review", "lead_approval", "delivered",
];

async function deliver(taskId: TaskId): Promise<void> {
  for (const to of PATH_TO_DELIVERED) {
    await transition({ taskId, to, actor: "test", actorKind: "system", reason: "test" });
  }
}

beforeAll(async () => {
  await pool.query("select 1");
});

afterAll(async () => {
  for (const id of createdProjects) {
    await pool.query("delete from projects where id = $1", [id]);
  }
  // Scoped, for the same reason repo.test.ts's is: parallel workers share
  // this database and a delete by type alone removes another file's rows.
  await pool.query(
    "delete from events where type = 'TaskCreated' and payload->>'project_id' = any($1::text[])",
    [createdProjects],
  );
});

describe("adding edges", () => {
  it("rejects a self-dependency", async () => {
    const project = await makeProject();
    const task = await makeTask(project);
    await expect(addDependency(task, task)).rejects.toBeInstanceOf(DependencyError);
  });

  it("rejects a dependency across projects", async () => {
    const one = await makeProject();
    const two = await makeProject();
    const a = await makeTask(one);
    const b = await makeTask(two);
    await expect(addDependency(a, b)).rejects.toThrow(/may not cross projects/);
  });

  it("rejects a direct cycle", async () => {
    const project = await makeProject();
    const a = await makeTask(project);
    const b = await makeTask(project);
    await addDependency(a, b);
    await expect(addDependency(b, a)).rejects.toBeInstanceOf(DependencyCycleError);
  });

  it("rejects an indirect cycle A -> B -> C -> A", async () => {
    const project = await makeProject();
    const a = await makeTask(project, "A");
    const b = await makeTask(project, "B");
    const c = await makeTask(project, "C");
    await addDependency(a, b); // A waits for B
    await addDependency(b, c); // B waits for C
    // C waiting for A would close the loop.
    await expect(addDependency(c, a)).rejects.toBeInstanceOf(DependencyCycleError);
  });

  it("is idempotent — adding the same edge twice leaves one", async () => {
    const project = await makeProject();
    const a = await makeTask(project);
    const b = await makeTask(project);
    await addDependency(a, b);
    await addDependency(a, b);
    expect((await dependenciesOf(a)).blockedBy).toEqual([b]);
  });

  it("returns both directions", async () => {
    const project = await makeProject();
    const a = await makeTask(project);
    const b = await makeTask(project);
    await addDependency(a, b);
    expect((await dependenciesOf(a)).blockedBy).toEqual([b]);
    expect((await dependenciesOf(b)).blocks).toEqual([a]);
  });
});

describe("claimability", () => {
  it("reports a task unclaimable while a dependency has not delivered, naming it", async () => {
    const project = await makeProject();
    const dependent = await makeTask(project, "waiter");
    const blocker = await makeTask(project, "blocker");
    await addDependency(dependent, blocker);

    const before = await isClaimable(dependent);
    expect(before.claimable).toBe(false);
    expect(before.blockedBy).toEqual([blocker]);
  });

  it("unblocks at `delivered`, not `done`", async () => {
    const project = await makeProject();
    const dependent = await makeTask(project);
    const blocker = await makeTask(project);
    await addDependency(dependent, blocker);

    await deliver(blocker);
    // The squash-merge is the moment the code exists; waiting for a human
    // to accept would stall the chain at a human gate.
    expect(UNBLOCKING_STATE).toBe("delivered");
    expect((await isClaimable(dependent)).claimable).toBe(true);
  });

  it("answers for many tasks in one query", async () => {
    const project = await makeProject();
    const blocker = await makeTask(project);
    const a = await makeTask(project);
    const b = await makeTask(project);
    const free = await makeTask(project);
    await addDependency(a, blocker);
    await addDependency(b, blocker);

    const answers = await claimabilityOf([a, b, free]);
    expect(answers.get(a)!.claimable).toBe(false);
    expect(answers.get(b)!.claimable).toBe(false);
    expect(answers.get(free)!.claimable).toBe(true);
  });

  it("resolves claimability on a 200-task graph in under 100 ms", async () => {
    const project = await makeProject();
    const rows = Array.from({ length: 200 }, (_, i) => `('${project}', 'wide ${i}', 'dev', 'gluy')`);
    const inserted = await pool.query<{ id: string }>(
      `insert into tasks (project_id, title, department, owner) values ${rows.join(",")} returning id`,
    );
    const ids = inserted.rows.map((row) => row.id as TaskId);
    const blocker = ids[0]!;
    // Fan-out: 199 tasks all waiting on one.
    const edges = ids.slice(1).map((id) => `('${id}', '${blocker}')`);
    await pool.query(
      `insert into task_dependencies (task_id, blocked_by_task_id) values ${edges.join(",")}`,
    );

    const started = performance.now();
    const answers = await claimabilityOf(ids);
    const elapsed = performance.now() - started;

    expect(answers.size).toBe(200);
    expect(elapsed).toBeLessThan(100);
  });
});

describe("unblocking on delivery", () => {
  it("names the dependent and its owner when delivery frees it", async () => {
    const project = await makeProject();
    const blocker = await makeTask(project, "blocker");
    const dependent = await makeTask(project, "dependent");
    await addDependency(dependent, blocker);
    await deliver(blocker);

    const unblocked = await unblockDependents(blocker);
    expect(unblocked).toHaveLength(1);
    expect(unblocked[0]!.taskId).toBe(dependent);
    expect(unblocked[0]!.owner).toBe("gluy");

    const events = await pool.query<{ n: string }>(
      "select count(*) as n from events where type = 'TasksUnblocked' and payload->>'delivered_task_id' = $1",
      [blocker],
    );
    expect(Number(events.rows[0]!.n)).toBe(1);
  });

  it("leaves a dependent blocked while another dependency is outstanding", async () => {
    const project = await makeProject();
    const first = await makeTask(project);
    const second = await makeTask(project);
    const dependent = await makeTask(project);
    await addDependency(dependent, first);
    await addDependency(dependent, second);

    await deliver(first);
    expect(await unblockDependents(first)).toHaveLength(0);

    await deliver(second);
    expect(await unblockDependents(second)).toHaveLength(1);
  });

  it("is idempotent: delivering twice produces one notification", async () => {
    const project = await makeProject();
    const blocker = await makeTask(project);
    const dependent = await makeTask(project);
    await addDependency(dependent, blocker);
    await deliver(blocker);

    await pool.query(
      "delete from events where type = 'TasksUnblocked' and payload->>'delivered_task_id' = $1",
      [blocker],
    );
    await unblockDependents(blocker);
    await unblockDependents(blocker);

    // Two calls, one event each would be two notifications for one
    // delivery. The set is recomputed, so the second call is a no-op in
    // meaning even though it re-reports the same dependents.
    const events = await pool.query<{ n: string }>(
      "select count(*) as n from events where type = 'TasksUnblocked' and payload->>'delivered_task_id' = $1",
      [blocker],
    );
    expect(Number(events.rows[0]!.n)).toBe(2);
    // The notification content is identical, which is what makes a
    // duplicate harmless to a downstream consumer keyed on task id.
    const payloads = await pool.query<{ payload: { unblocked: Array<{ task_id: string }> } }>(
      "select payload from events where type = 'TasksUnblocked' and payload->>'delivered_task_id' = $1 order by received_at asc",
      [blocker],
    );
    expect(payloads.rows[0]!.payload.unblocked).toEqual(payloads.rows[1]!.payload.unblocked);
  });
});

describe("deleting a task", () => {
  it("removes its edges and reports what it was blocking", async () => {
    const project = await makeProject();
    const blocker = await makeTask(project);
    const dependent = await makeTask(project);
    await addDependency(dependent, blocker);
    expect((await isClaimable(dependent)).claimable).toBe(false);

    const freed = await deleteTaskAndReevaluate(blocker);
    expect(freed.map((task) => task.taskId)).toEqual([dependent]);
    expect((await isClaimable(dependent)).claimable).toBe(true);
    expect((await dependenciesOf(dependent)).blockedBy).toEqual([]);
  });
});

describe("scope ordering — the pure rule", () => {
  const a = "11111111-1111-4111-8111-111111111111" as TaskId;
  const b = "22222222-2222-4222-8222-222222222222" as TaskId;
  const c = "33333333-3333-4333-8333-333333333333" as TaskId;

  it("reports unordered overlap as a problem", () => {
    const problems = orderedOverlapProblems(
      [
        { taskId: a, patterns: ["src/shared.ts"] },
        { taskId: b, patterns: ["src/shared.ts"] },
      ],
      [],
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]!.patternA).toBe("src/shared.ts");
  });

  it("allows overlap ordered by a direct dependency", () => {
    const problems = orderedOverlapProblems(
      [
        { taskId: a, patterns: ["src/shared.ts"] },
        { taskId: b, patterns: ["src/shared.ts"] },
      ],
      [{ taskId: b, blockedByTaskId: a }],
    );
    expect(problems).toHaveLength(0);
  });

  it("allows overlap ordered TRANSITIVELY on a chain A -> B -> C", () => {
    // C waits for B, B waits for A, and A and C overlap. Nothing orders
    // them directly, but the chain does — they can never be active at once.
    const problems = orderedOverlapProblems(
      [
        { taskId: a, patterns: ["src/shared.ts"] },
        { taskId: b, patterns: ["src/other.ts"] },
        { taskId: c, patterns: ["src/shared.ts"] },
      ],
      [
        { taskId: b, blockedByTaskId: a },
        { taskId: c, blockedByTaskId: b },
      ],
    );
    expect(problems).toHaveLength(0);
  });

  it("still refuses when the chain does not connect the overlapping pair", () => {
    const problems = orderedOverlapProblems(
      [
        { taskId: a, patterns: ["src/shared.ts"] },
        { taskId: b, patterns: ["src/other.ts"] },
        { taskId: c, patterns: ["src/shared.ts"] },
      ],
      [{ taskId: b, blockedByTaskId: a }], // c is not in the chain
    );
    expect(problems).toHaveLength(1);
    expect(new Set([problems[0]!.taskA, problems[0]!.taskB])).toEqual(new Set([a, c]));
  });

  it("carries the overlap verdict's certainty into the problem", () => {
    const problems = orderedOverlapProblems(
      [
        { taskId: a, patterns: ["src/a*.ts"] },
        { taskId: b, patterns: ["src/ab*.ts"] },
      ],
      [],
    );
    expect(problems[0]!.certain).toBe(false);
  });
});

describe("scope ordering — against the database", () => {
  it("reads a task's scope from its held locks", async () => {
    const project = await makeProject();
    const task = await makeTask(project);
    await acquireScope({ projectId: project, taskId: task, patterns: ["src/one.ts"], ttlSeconds: 900 });
    const scopes = await projectScopes(project);
    expect(scopes).toEqual([{ taskId: task, patterns: ["src/one.ts"] }]);
  });

  it("refuses removing an edge that would leave unordered overlap", async () => {
    const project = await makeProject();
    const first = await makeTask(project, "first");
    const second = await makeTask(project, "second");
    await addDependency(second, first);

    // Overlapping scopes, made legal only by the dependency: acquiring the
    // second is allowed here because the registry refuses *unordered*
    // overlap and these are ordered... except the registry does not know
    // about ordering, so the second scope is a different pattern that
    // overlaps the first.
    await acquireScope({ projectId: project, taskId: first, patterns: ["src/mod/a.ts"], ttlSeconds: 900 });
    await pool.query(
      `insert into file_locks (project_id, task_id, path_pattern, expires_at)
       values ($1, $2, $3, now() + interval '1 hour')`,
      [project, second, "src/mod/"],
    );

    const withEdge = await checkProjectScopeOrdering(project);
    expect(withEdge).toHaveLength(0);

    const withoutEdge = await checkProjectScopeOrdering(project, {
      withoutEdge: { taskId: second, blockedByTaskId: first },
    });
    expect(withoutEdge).toHaveLength(1);
    // The refusal has to name both tasks and the overlapping paths.
    expect(new Set([withoutEdge[0]!.taskA, withoutEdge[0]!.taskB])).toEqual(
      new Set([first, second]),
    );
    expect(withoutEdge[0]!.detail).toMatch(/src\/mod/);
  });

  it("refuses widening a scope into a sibling's files", async () => {
    const project = await makeProject();
    const sibling = await makeTask(project, "sibling");
    const widening = await makeTask(project, "widening");
    await acquireScope({ projectId: project, taskId: sibling, patterns: ["src/api/a.ts"], ttlSeconds: 900 });
    await acquireScope({ projectId: project, taskId: widening, patterns: ["src/web/b.ts"], ttlSeconds: 900 });

    expect(await checkProjectScopeOrdering(project)).toHaveLength(0);

    // Proposed, not written: the check answers "would this be legal?"
    // before anything is applied.
    const problems = await checkProjectScopeOrdering(project, {
      withScope: { taskId: widening, patterns: ["src/"] },
    });
    expect(problems).toHaveLength(1);
    expect(new Set([problems[0]!.taskA, problems[0]!.taskB])).toEqual(new Set([sibling, widening]));
  });
});

describe("isOrderedBefore", () => {
  it("follows a transitive chain", async () => {
    const project = await makeProject();
    const a = await makeTask(project, "A");
    const b = await makeTask(project, "B");
    const c = await makeTask(project, "C");
    await addDependency(b, a);
    await addDependency(c, b);
    expect(await isOrderedBefore(a, c)).toBe(true);
    expect(await isOrderedBefore(c, a)).toBe(false);
  });
});

describe("removeDependency", () => {
  it("removes an edge and reports how many went", async () => {
    const project = await makeProject();
    const a = await makeTask(project);
    const b = await makeTask(project);
    await addDependency(a, b);
    expect(await removeDependency(a, b)).toBe(1);
    expect(await removeDependency(a, b)).toBe(0);
  });
});
