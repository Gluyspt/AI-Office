// Ticket 013's acceptance criteria, against a real database.
//
// Board shape, the 7-day Done window, filter combination, keyset paging
// under a concurrent insert, and the single-round-trip guarantee. The
// route-level criteria (department 400, PATCH refusing `state`) go through
// buildApp().inject() rather than being asserted against the repo, because
// the promise is about the HTTP answer.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import {
  TASK_BOARD_COLUMNS,
  TASK_BOARD_COLUMN_OF,
  TASK_STATES,
  type TaskState,
} from "@office/shared/tasks";
import type { ProjectId, TaskId } from "@office/shared/ids";
import { pool } from "../../core/db/pool.ts";
import { buildApp } from "../../core/app.ts";
import { createTask } from "./model.ts";
import { transition } from "./states.ts";
import {
  board,
  DONE_WINDOW_DAYS,
  getTaskWithHistory,
  insertTask,
  listTasks,
  StateNotPatchableError,
  updateTaskFields,
} from "./repo.ts";

let projectId: ProjectId;
const createdProjects: string[] = [];

async function makeProject(): Promise<ProjectId> {
  const slug = `t013-${randomUUID()}`;
  const result = await pool.query<{ id: string }>(
    `insert into projects (name, slug, repo_url) values ($1, $2, $3) returning id`,
    [slug, slug, "https://example.invalid/repo.git"],
  );
  const id = result.rows[0]!.id;
  createdProjects.push(id);
  return id as ProjectId;
}

async function makeTask(
  overrides: Partial<{ title: string; owner: string; department: string; project: ProjectId }> = {},
): Promise<TaskId> {
  const task = createTask({
    projectId: overrides.project ?? projectId,
    title: overrides.title ?? "a task",
    department: (overrides.department ?? "dev") as never,
    owner: overrides.owner ?? "gluy",
  });
  const record = await insertTask(task);
  return record.id;
}

/** Walks a task to `target` along the lifecycle, supplying a reason on
 * every edge (harmless where one is not required). */
const PATH_TO: Readonly<Record<TaskState, readonly TaskState[]>> = {
  draft: [],
  pending: ["pending"],
  in_progress: ["pending", "in_progress"],
  paused: ["pending", "in_progress", "paused"],
  ready_for_qa: ["pending", "in_progress", "ready_for_qa"],
  ci: ["pending", "in_progress", "ready_for_qa", "ci"],
  qa_review: ["pending", "in_progress", "ready_for_qa", "ci", "qa_review"],
  lead_approval: ["pending", "in_progress", "ready_for_qa", "ci", "qa_review", "lead_approval"],
  delivered: [
    "pending", "in_progress", "ready_for_qa", "ci", "qa_review", "lead_approval", "delivered",
  ],
  done: [
    "pending", "in_progress", "ready_for_qa", "ci", "qa_review", "lead_approval", "delivered", "done",
  ],
};

async function driveTo(taskId: TaskId, target: TaskState): Promise<void> {
  for (const to of PATH_TO[target]) {
    await transition({ taskId, to, actor: "test", actorKind: "system", reason: "test" });
  }
}

beforeAll(async () => {
  projectId = await makeProject();
});

afterAll(async () => {
  // Tasks and history cascade from projects.
  for (const id of createdProjects) {
    await pool.query("delete from projects where id = $1", [id]);
  }
  await pool.query("delete from events where type = 'TaskCreated'");
});

describe("board — columns and chips", () => {
  it("maps every state in the union to a column, so none can vanish", () => {
    // The guarantee is about the shared mapping, not about rows: if a state
    // is added to TASK_STATES without a column, this fails rather than the
    // card silently disappearing from the page.
    for (const state of TASK_STATES) {
      expect(TASK_BOARD_COLUMN_OF[state], `state ${state} has no column`).toBeTruthy();
      expect(TASK_BOARD_COLUMNS).toContain(TASK_BOARD_COLUMN_OF[state]);
    }
  });

  it("returns all four columns even when empty, in a stable order", async () => {
    const empty = await makeProject();
    const result = await board({ projectId: empty });
    expect(result.columns.map((c) => c.column)).toEqual([...TASK_BOARD_COLUMNS]);
    expect(result.columns.every((c) => c.cards.length === 0)).toBe(true);
  });

  it("puts a task in the column its state maps to, and carries the state as the chip", async () => {
    const project = await makeProject();
    for (const state of ["draft", "pending", "in_progress", "paused", "done"] as TaskState[]) {
      const id = await makeTask({ project });
      await driveTo(id, state);
    }
    const result = await board({ projectId: project });
    for (const column of result.columns) {
      for (const card of column.cards) {
        expect(card.column).toBe(TASK_BOARD_COLUMN_OF[card.task.state]);
        expect(card.chip).toBe(card.task.state);
      }
    }
    const inProgress = result.columns.find((c) => c.column === "in_progress")!;
    // in_progress and paused share the column; the chip is what separates them.
    expect(inProgress.cards.map((c) => c.chip).sort()).toEqual(["in_progress", "paused"]);
  });

  it("carries state_entered_at on every card, so time-in-state needs no history walk", async () => {
    const project = await makeProject();
    await makeTask({ project });
    const result = await board({ projectId: project });
    const card = result.columns.find((c) => c.column === "draft")!.cards[0]!;
    expect(card.task.stateEnteredAt).toBeInstanceOf(Date);
  });

  it("carries the fields the card renders", async () => {
    const project = await makeProject();
    await makeTask({ project, title: "renders", owner: "user2", department: "qa" });
    const card = (await board({ projectId: project })).columns.find((c) => c.column === "draft")!
      .cards[0]!;
    expect(card.task.title).toBe("renders");
    expect(card.task.owner).toBe("user2");
    expect(card.task.department).toBe("qa");
    expect(card.task.tokenCost).toBe(0);
    expect(card.task.turnCount).toBe(0);
    expect(card.task).toHaveProperty("model");
  });
});

describe("board — the Done window", () => {
  it("shows Done tasks from the last 7 days and counts the earlier ones", async () => {
    const project = await makeProject();
    const recent = await makeTask({ project });
    await driveTo(recent, "done");
    const old = await makeTask({ project });
    await driveTo(old, "done");

    // Backdate one past the window. state_entered_at is maintained by the
    // trigger, so this is a deliberate out-of-band write for the test —
    // the only way to produce a task finished more than a week ago.
    await pool.query(
      `update tasks set state_entered_at = now() - ($2::int * interval '1 day') where id = $1`,
      [old, DONE_WINDOW_DAYS + 1],
    );

    const result = await board({ projectId: project });
    const done = result.columns.find((c) => c.column === "done")!;
    expect(done.cards.map((c) => c.task.id)).toEqual([recent]);
    expect(done.earlierCount).toBe(1);
    expect(result.doneWindowDays).toBe(DONE_WINDOW_DAYS);
  });

  it("orders Done newest first", async () => {
    const project = await makeProject();
    const first = await makeTask({ project });
    await driveTo(first, "done");
    const second = await makeTask({ project });
    await driveTo(second, "done");
    const done = (await board({ projectId: project })).columns.find((c) => c.column === "done")!;
    expect(done.cards[0]!.task.id).toBe(second);
    expect(done.cards[1]!.task.id).toBe(first);
  });

  it("reports earlierCount only on the Done column", async () => {
    const result = await board({ projectId });
    for (const column of result.columns) {
      if (column.column !== "done") expect(column.earlierCount).toBe(0);
    }
  });
});

describe("board — filters", () => {
  it("combines project, owner, department and state", async () => {
    const project = await makeProject();
    await makeTask({ project, owner: "alice", department: "dev" });
    await makeTask({ project, owner: "bob", department: "dev" });
    await makeTask({ project, owner: "alice", department: "qa" });

    const cards = (b: Awaited<ReturnType<typeof board>>): number =>
      b.columns.reduce((n, c) => n + c.cards.length, 0);

    expect(cards(await board({ projectId: project }))).toBe(3);
    expect(cards(await board({ projectId: project, owner: "alice" }))).toBe(2);
    expect(cards(await board({ projectId: project, owner: "alice", department: "dev" }))).toBe(1);
    expect(cards(await board({ projectId: project, state: "draft" }))).toBe(3);
    expect(cards(await board({ projectId: project, state: "done" }))).toBe(0);
  });
});

describe("board — one round trip", () => {
  it("issues exactly one query with 200 tasks present", async () => {
    const project = await makeProject();
    const rows = Array.from({ length: 200 }, (_, i) => `('${project}', 'bulk ${i}', 'dev', 'gluy')`);
    // Seeded with one INSERT rather than 200 insertTask calls: this test is
    // about the read, and 200 announcements would be noise.
    await pool.query(
      `insert into tasks (project_id, title, department, owner) values ${rows.join(",")}`,
    );

    const client: PoolClient = await pool.connect();
    let queries = 0;
    const counting = new Proxy(client, {
      get(target, prop, receiver) {
        if (prop === "query") {
          return (...args: unknown[]) => {
            queries += 1;
            return (target.query as (...a: unknown[]) => unknown)(...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as PoolClient;

    try {
      const result = await board({ projectId: project }, counting);
      expect(result.columns.find((c) => c.column === "draft")!.cards).toHaveLength(200);
      expect(queries).toBe(1);
    } finally {
      client.release();
    }
  });
});

describe("listTasks — deterministic paging", () => {
  it("pages stably across two pages with a concurrent insert", async () => {
    const project = await makeProject();
    const ids: TaskId[] = [];
    for (let i = 0; i < 6; i += 1) ids.push(await makeTask({ project, title: `page ${i}` }));

    const first = await listTasks({ projectId: project, limit: 3 });
    expect(first.tasks).toHaveLength(3);
    expect(first.nextCursor).toBeTruthy();

    // Inserted between the two reads. Ascending creation order means it
    // lands after everything already seen, so page 2 is unaffected — the
    // property OFFSET paging would lose.
    const inserted = await makeTask({ project, title: "concurrent" });

    const second = await listTasks({ projectId: project, limit: 3, cursor: first.nextCursor });
    const seen = [...first.tasks, ...second.tasks].map((t) => t.id);
    expect(new Set(seen).size).toBe(seen.length); // no duplicates
    expect(seen).toEqual(ids); // and no gaps: exactly the original six
    expect(seen).not.toContain(inserted);
  });

  it("returns a null cursor on the last page", async () => {
    const project = await makeProject();
    await makeTask({ project });
    const page = await listTasks({ projectId: project, limit: 50 });
    expect(page.nextCursor).toBeNull();
  });
});

describe("getTaskWithHistory", () => {
  it("returns the full state history inline, oldest first", async () => {
    const id = await makeTask();
    await driveTo(id, "in_progress");
    const found = await getTaskWithHistory(id);
    expect(found).not.toBeNull();
    expect(found!.task.state).toBe("in_progress");
    expect(found!.history.map((h) => h.toState)).toEqual(["pending", "in_progress"]);
  });

  it("returns null for an unknown id", async () => {
    expect(await getTaskWithHistory(randomUUID() as TaskId)).toBeNull();
  });
});

describe("updateTaskFields", () => {
  it("refuses to write state", async () => {
    const id = await makeTask();
    await expect(updateTaskFields(id, { state: "done" })).rejects.toBeInstanceOf(
      StateNotPatchableError,
    );
  });

  it("writes the fields it does own", async () => {
    const id = await makeTask();
    const updated = await updateTaskFields(id, { title: "renamed", owner: "user3" });
    expect(updated!.title).toBe("renamed");
    expect(updated!.owner).toBe("user3");
  });

  it("rejects an unknown field rather than ignoring it", async () => {
    const id = await makeTask();
    await expect(updateTaskFields(id, { nonsense: 1 })).rejects.toThrow(/unknown field/);
  });
});

describe("HTTP surface", () => {
  it("rejects a department outside the union with a 400 naming the valid values", async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/tasks",
        payload: JSON.stringify({
          projectId,
          title: "bad department",
          department: "marketing",
          owner: "gluy",
        }),
        headers: { "content-type": "application/json" },
      });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body) as { problems: string[] };
      expect(body.problems.join(" ")).toMatch(/dev, research, qa/);
    } finally {
      await app.close();
    }
  });

  it("PATCH /tasks/:id answers 400 for state, pointing at the transition endpoint", async () => {
    const app = await buildApp();
    try {
      const id = await makeTask();
      const response = await app.inject({
        method: "PATCH",
        url: `/tasks/${id}`,
        payload: JSON.stringify({ state: "done" }),
        headers: { "content-type": "application/json" },
      });
      expect(response.statusCode).toBe(400);
      expect(response.body).toMatch(/transition/);
    } finally {
      await app.close();
    }
  });

  it("creating a task emits a TaskCreated event so clients need not poll", async () => {
    const before = await pool.query<{ n: string }>(
      "select count(*) as n from events where type = 'TaskCreated'",
    );
    const id = await makeTask({ title: "announced" });
    const after = await pool.query<{ n: string }>(
      "select count(*) as n from events where type = 'TaskCreated'",
    );
    expect(Number(after.rows[0]!.n)).toBe(Number(before.rows[0]!.n) + 1);

    const stored = await pool.query<{ payload: { task_id: string } }>(
      "select payload from events where type = 'TaskCreated' order by received_at desc limit 1",
    );
    expect(stored.rows[0]!.payload.task_id).toBe(id);
  });

  it("GET /board answers 400 for a state outside the union", async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({ method: "GET", url: "/board?state=nonsense" });
      expect(response.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
