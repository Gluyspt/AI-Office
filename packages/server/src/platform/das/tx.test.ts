// Ticket 034. Transaction semantics against the real database, because the
// property that matters here — a write disappearing on rollback — is a
// property of Postgres, not of our bookkeeping. The stub-pool half is in
// das.test.ts.
//
// THE POOL IS max: 1 ON PURPOSE for the leak test. A connection released
// twice, or not at all, is invisible against a healthy pool: the next
// checkout simply takes a different connection. With one connection, a leak
// makes the next checkout wait — and `connectionTimeoutMillis` turns that
// wait into a named failure instead of a test that hangs until vitest gives
// up and blames the wrong thing.
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadDatabaseConfig } from "../../core/config.ts";
import { createDas } from "./das.ts";
import type { DataAccess } from "./contract.ts";

const suffix = randomBytes(4).toString("hex");
const tableA = `das_t034_a_${suffix}`;
const tableB = `das_t034_b_${suffix}`;

let admin: pg.Pool;
let pool: pg.Pool;
let das: DataAccess;

beforeAll(async () => {
  const config = loadDatabaseConfig();
  admin = new pg.Pool({ connectionString: config.url, max: 2 });
  await admin.query(`create table ${tableA} (id int primary key, note text)`);
  await admin.query(`create table ${tableB} (id int primary key, note text)`);

  pool = new pg.Pool({
    connectionString: config.url,
    max: 1,
    connectionTimeoutMillis: 3000,
  });
  das = createDas({ pool });
});

afterAll(async () => {
  await das.end();
  await admin.query(`drop table if exists ${tableA}`);
  await admin.query(`drop table if exists ${tableB}`);
  await admin.end();
});

async function rowsIn(table: string): Promise<number> {
  const result = await admin.query<{ count: string }>(`select count(*)::text as count from ${table}`);
  return Number(result.rows[0]!.count);
}

function grant(): ReturnType<DataAccess["grant"]> {
  return das.grant("tasks", []);
}

beforeAll(() => {
  das.grant("tasks", [tableA, tableB]);
});

describe("tx", () => {
  it("commits what the callback returns", async () => {
    const before = await rowsIn(tableA);
    const returned = await grant().tx(async (tx) => {
      await tx.query(`insert into ${tableA} (id, note) values (1, 'committed')`);
      return "the return value";
    });

    expect(returned).toBe("the return value");
    expect(await rowsIn(tableA)).toBe(before + 1);
  });

  it("rolls back what the callback throws", async () => {
    const before = await rowsIn(tableA);
    await expect(
      grant().tx(async (tx) => {
        await tx.query(`insert into ${tableA} (id, note) values (2, 'rolled back')`);
        throw new Error("changed my mind");
      }),
    ).rejects.toThrow("changed my mind");

    expect(await rowsIn(tableA)).toBe(before);
  });

  it("rolls back a refusal decided AFTER a write — the 017 case", async () => {
    // The bug `ClaimRefused` exists to prevent, in miniature. `claim_task`
    // acquires a scope and may then refuse because another desk won the race;
    // when that refusal was RETURNED rather than thrown, the locks of a
    // failed claim were committed — a task left pending while holding a scope
    // nobody owned, blocking the next claim for a full TTL for a reason no
    // log explained.
    //
    // The DAS cannot stop a caller returning a refusal. What it guarantees is
    // that a THROWN one leaves nothing behind, which is what makes "a failure
    // leaves no locks held" true by construction.
    class Refused extends Error {
      constructor(readonly reason: string) {
        super(reason);
      }
    }

    const before = await rowsIn(tableA);
    const outcome = await grant()
      .tx(async (tx) => {
        await tx.query(`insert into ${tableA} (id, note) values (3, 'scope acquired')`);
        throw new Refused("another desk got there first");
      })
      .then(
        () => "committed",
        (error: unknown) => (error instanceof Refused ? error.reason : "unexpected"),
      );

    expect(outcome).toBe("another desk got there first");
    expect(await rowsIn(tableA)).toBe(before);
  });

  it("is all-or-nothing across two tables — the shape claim_task relies on", async () => {
    // tasks writes its transition, locks writes the scope, one transaction.
    // This is the property that makes `tasks` and `locks` one deployment
    // unit; see tests/boundaries/crossings.ts.
    const beforeA = await rowsIn(tableA);
    const beforeB = await rowsIn(tableB);

    await expect(
      grant().tx(async (tx) => {
        await tx.query(`insert into ${tableA} (id, note) values (10, 'transition')`);
        await tx.query(`insert into ${tableB} (id, note) values (10, 'scope')`);
        throw new Error("refused after both writes");
      }),
    ).rejects.toThrow();

    expect(await rowsIn(tableA)).toBe(beforeA);
    expect(await rowsIn(tableB)).toBe(beforeB);
  });

  it("surfaces a database error from inside the transaction, having rolled back", async () => {
    const before = await rowsIn(tableA);
    await expect(
      grant().tx(async (tx) => {
        await tx.query(`insert into ${tableA} (id, note) values (20, 'first')`);
        await tx.query(`insert into ${tableA} (id, note) values (20, 'duplicate key')`);
      }),
    ).rejects.toThrow(/duplicate key/i);

    expect(await rowsIn(tableA)).toBe(before);
  });
});

describe("no connection leaks, on a pool of one", () => {
  // Each of these takes the single connection and must give it back. If any
  // path leaks, a LATER test fails to check out within 3 s — so the order
  // matters and the failure, when it comes, names the path after the broken
  // one. Run them in sequence rather than in parallel for exactly that
  // reason.
  it("after a commit", async () => {
    await grant().tx(async (tx) => {
      await tx.query(`insert into ${tableA} (id, note) values (100, 'a')`);
    });
    await expect(grant().query("select 1")).resolves.toBeDefined();
  });

  it("after a rollback", async () => {
    await grant()
      .tx(async () => {
        throw new Error("no");
      })
      .catch(() => undefined);
    await expect(grant().query("select 1")).resolves.toBeDefined();
  });

  it("after a failed statement outside a transaction", async () => {
    await grant().query("select * from a_table_that_does_not_exist").catch(() => undefined);
    await expect(grant().query("select 1")).resolves.toBeDefined();
  });

  it("after a failed statement inside a transaction", async () => {
    await grant()
      .tx(async (tx) => {
        await tx.query("select * from a_table_that_does_not_exist");
      })
      .catch(() => undefined);
    await expect(grant().query("select 1")).resolves.toBeDefined();
  });

  it("and the metrics agree that nothing is held", () => {
    const tasks = das.metrics().services.find((s) => s.service === "tasks")!;
    expect(tasks.inUse).toBe(0);
  });
});

describe("metrics against a real pool", () => {
  it("records time waiting for a connection and time inside a transaction", async () => {
    await grant().tx(async (tx) => {
      await tx.query("select pg_sleep(0.05)");
    });

    const tasks = das.metrics().services.find((s) => s.service === "tasks")!;
    expect(tasks.transactionMs).toBeGreaterThanOrEqual(50);
    expect(tasks.checkoutWaitMs).toBeGreaterThanOrEqual(0);
  });
});
