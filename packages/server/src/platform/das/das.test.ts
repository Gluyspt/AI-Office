// Ticket 034. The DAS against a stubbed pool, for the three things a real
// database cannot be made to do on demand:
//
//   - count how many times a connection was released,
//   - make ROLLBACK itself fail,
//   - observe what happens when BEGIN fails.
//
// The transaction semantics that a real database CAN demonstrate are in
// tx.test.ts, against the dev Postgres. Neither file substitutes for the
// other: a stub proves the bookkeeping, a database proves the behaviour.
import { describe, expect, it } from "vitest";
import type pg from "pg";
import { GrantError, RollbackFailedError } from "./contract.ts";
import { createDas } from "./das.ts";

interface StubClient {
  readonly statements: string[];
  releases: number;
}

interface Stub {
  readonly pool: pg.Pool;
  readonly clients: StubClient[];
  /** Connections handed out and not yet released. */
  outstanding(): number;
}

/**
 * A pool that records what was asked of it.
 *
 * `failOn` throws for any statement whose text contains the given string,
 * which is how ROLLBACK and BEGIN failures get tested at all — neither can be
 * provoked on demand from a healthy database.
 */
function stubPool(options: { failOn?: string; failTimes?: number } = {}): Stub {
  const clients: StubClient[] = [];
  let failures = options.failTimes ?? Number.POSITIVE_INFINITY;

  const pool = {
    totalCount: 0,
    idleCount: 0,
    waitingCount: 0,
    connect(): Promise<unknown> {
      const client: StubClient = { statements: [], releases: 0 };
      clients.push(client);
      return Promise.resolve({
        query(text: string): Promise<{ rows: unknown[]; rowCount: number }> {
          client.statements.push(text);
          if (options.failOn !== undefined && text.includes(options.failOn) && failures > 0) {
            failures -= 1;
            return Promise.reject(new Error(`stub: ${options.failOn} failed`));
          }
          return Promise.resolve({ rows: [], rowCount: 0 });
        },
        release(): void {
          client.releases += 1;
        },
      });
    },
    end(): Promise<void> {
      return Promise.resolve();
    },
  } as unknown as pg.Pool;

  return {
    pool,
    clients,
    outstanding: () => clients.filter((c) => c.releases === 0).length,
  };
}

describe("connection release", () => {
  it("releases exactly once when a query succeeds", async () => {
    const stub = stubPool();
    const das = createDas({ pool: stub.pool });
    await das.grant("tasks", ["tasks"]).query("select 1");

    expect(stub.clients).toHaveLength(1);
    expect(stub.clients[0]!.releases).toBe(1);
    expect(stub.outstanding()).toBe(0);
  });

  it("releases exactly once when a query throws", async () => {
    const stub = stubPool({ failOn: "select" });
    const das = createDas({ pool: stub.pool });

    await expect(das.grant("tasks", ["tasks"]).query("select 1")).rejects.toThrow();
    expect(stub.clients[0]!.releases).toBe(1);
  });

  it("releases exactly once when a transaction commits", async () => {
    const stub = stubPool();
    const das = createDas({ pool: stub.pool });
    await das.grant("tasks", ["tasks"]).tx(async (tx) => {
      await tx.query("insert into tasks values (1)");
    });

    expect(stub.clients[0]!.releases).toBe(1);
    expect(stub.clients[0]!.statements).toEqual([
      "BEGIN",
      "insert into tasks values (1)",
      "COMMIT",
    ]);
  });

  it("releases exactly once when the body throws", async () => {
    const stub = stubPool();
    const das = createDas({ pool: stub.pool });

    await expect(
      das.grant("tasks", ["tasks"]).tx(async () => {
        throw new Error("refused");
      }),
    ).rejects.toThrow("refused");

    expect(stub.clients[0]!.releases).toBe(1);
    expect(stub.clients[0]!.statements).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it("releases exactly once when the ROLLBACK also fails", async () => {
    // The path where a naive `finally` is easiest to get wrong, and the one
    // that only happens when the database is already in trouble.
    const stub = stubPool({ failOn: "ROLLBACK" });
    const das = createDas({ pool: stub.pool });

    await expect(
      das.grant("tasks", ["tasks"]).tx(async () => {
        throw new Error("refused");
      }),
    ).rejects.toThrow("refused");

    expect(stub.clients[0]!.releases).toBe(1);
  });

  it("releases exactly once when BEGIN fails", async () => {
    const stub = stubPool({ failOn: "BEGIN" });
    const das = createDas({ pool: stub.pool });

    await expect(das.grant("tasks", ["tasks"]).tx(async () => 1)).rejects.toThrow();
    expect(stub.clients[0]!.releases).toBe(1);
  });
});

describe("a failed ROLLBACK does not destroy the error that caused it", () => {
  // The fix to `core/db/pool.ts`'s `catch { await query("ROLLBACK"); throw }`,
  // where a throwing ROLLBACK replaced the real error with its own. That
  // fires exactly when the database is in trouble — when the original
  // message is the only thing that would have explained anything.
  it("rethrows the ORIGINAL error", async () => {
    const stub = stubPool({ failOn: "ROLLBACK" });
    const das = createDas({ pool: stub.pool });

    await expect(
      das.grant("tasks", ["tasks"]).tx(async () => {
        throw new Error("the real problem");
      }),
    ).rejects.toThrow("the real problem");
  });

  it("carries the rollback failure as the original error's cause", async () => {
    const stub = stubPool({ failOn: "ROLLBACK" });
    const das = createDas({ pool: stub.pool });

    const error = await das
      .grant("tasks", ["tasks"])
      .tx(async () => {
        throw new Error("the real problem");
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    const cause = (error as Error).cause;
    expect(cause).toBeInstanceOf(RollbackFailedError);
    expect((cause as RollbackFailedError).rollbackCause).toBeInstanceOf(Error);
  });

  it("does not overwrite a cause the original error already had", async () => {
    const stub = stubPool({ failOn: "ROLLBACK" });
    const das = createDas({ pool: stub.pool });
    const inner = new Error("inner");

    const error = await das
      .grant("tasks", ["tasks"])
      .tx(async () => {
        throw new Error("outer", { cause: inner });
      })
      .catch((e: unknown) => e);

    // A caller's own causal chain is more informative than ours. 017's
    // refusals carry structured detail; losing it to a rollback note would
    // be the same mistake in a new place.
    expect((error as Error).cause).toBe(inner);
  });
});

describe("grants", () => {
  it("returns the same handle for the same service", () => {
    const das = createDas({ pool: stubPool().pool });
    const first = das.grant("tasks", ["tasks"]);
    const second = das.grant("tasks", ["tasks"]);
    expect(second).toBe(first);
  });

  it("returns the existing handle when a second call site declares nothing", () => {
    const das = createDas({ pool: stubPool().pool });
    const first = das.grant("tasks", ["tasks", "task_dependencies"]);
    const second = das.grant("tasks", []);
    expect(second).toBe(first);
    expect(second.tables).toEqual(["task_dependencies", "tasks"]);
  });

  it("refuses a second, conflicting declaration", () => {
    const das = createDas({ pool: stubPool().pool });
    das.grant("tasks", ["tasks"]);
    expect(() => das.grant("tasks", ["file_locks"])).toThrow(GrantError);
  });

  it("refuses an unusable service name before a connection is ever opened", () => {
    const stub = stubPool();
    const das = createDas({ pool: stub.pool });
    expect(() => das.grant("My-Service", ["tasks"])).toThrow(GrantError);
    expect(stub.clients).toHaveLength(0);
  });

  it("exposes its table list sorted, for 035 to turn into GRANT statements", () => {
    const das = createDas({ pool: stubPool().pool });
    expect(das.grant("tasks", ["tasks", "task_dependencies"]).tables).toEqual([
      "task_dependencies",
      "tasks",
    ]);
  });
});

describe("metrics", () => {
  it("counts queries and transactions per service", async () => {
    const das = createDas({ pool: stubPool().pool });
    const tasks = das.grant("tasks", ["tasks"]);
    const locks = das.grant("locks", ["file_locks"]);

    await tasks.query("select 1");
    await tasks.tx(async (tx) => {
      await tx.query("select 2");
    });
    await locks.query("select 3");

    const byService = new Map(das.metrics().services.map((s) => [s.service, s]));
    expect(byService.get("tasks")!.queries).toBe(2);
    expect(byService.get("tasks")!.transactions).toBe(1);
    expect(byService.get("locks")!.queries).toBe(1);
    expect(byService.get("locks")!.transactions).toBe(0);
  });

  it("counts a rollback as a rollback", async () => {
    const das = createDas({ pool: stubPool().pool });
    await das
      .grant("tasks", ["tasks"])
      .tx(async () => {
        throw new Error("no");
      })
      .catch(() => undefined);

    const tasks = das.metrics().services.find((s) => s.service === "tasks")!;
    expect(tasks.transactions).toBe(1);
    expect(tasks.rollbacks).toBe(1);
  });

  it("reports a service with a grant and no traffic, rather than omitting it", async () => {
    // 036 needs to see a lane's idle services too; a service that appears
    // only once it has been used makes "who is holding connections" a
    // question you can only answer during an incident.
    const das = createDas({ pool: stubPool().pool });
    das.grant("planning", ["batches"]);
    expect(das.metrics().services.map((s) => s.service)).toContain("planning");
  });

  it("returns to zero in-use after everything finishes", async () => {
    const das = createDas({ pool: stubPool().pool });
    await das.grant("tasks", ["tasks"]).query("select 1");
    expect(das.metrics().services.find((s) => s.service === "tasks")!.inUse).toBe(0);
  });
});
