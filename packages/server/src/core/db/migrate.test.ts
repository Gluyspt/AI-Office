// Ticket 004's acceptance criteria, which shipped without tests.
//
// The migration runner is load-bearing — every schema change in the system
// goes through it, and its two riskiest promises ("a file that throws
// leaves the database unchanged and unrecorded", "ordering is by filename,
// not by directory listing") were asserted in a ticket and never in code.
//
// Probe migrations are numbered 9xxx so they sort ABOVE every real one and
// cannot trip the out-of-order warning, and every probe file and table is
// removed afterwards — these run against the same database as everything
// else.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, loadDatabaseConfig } from "../config.ts";
import { pool, withTransaction } from "./pool.ts";
import { runMigrations } from "./migrate.ts";

let scratch: string | null = null;

async function migrationDir(files: Record<string, string>): Promise<string> {
  scratch = await mkdtemp(path.join(tmpdir(), "office-migrate-"));
  for (const [name, sql] of Object.entries(files)) {
    await writeFile(path.join(scratch, name), sql, "utf8");
  }
  return scratch;
}

afterEach(async () => {
  // Probe rows and tables live in the shared database; leaving either would
  // corrupt the next run.
  await pool.query("delete from schema_migrations where filename like '9%'");
  await pool.query("drop table if exists probe_one, probe_two, probe_fail");
  if (scratch) {
    await rm(scratch, { recursive: true, force: true });
    scratch = null;
  }
});

describe("runMigrations", () => {
  it("applies pending files in filename order, not directory order", async () => {
    // The criterion names this shape exactly: a lower number created later
    // must still run first. readdir order is not guaranteed to match
    // filename order on every platform and filesystem, which is the whole
    // reason the runner sorts.
    const dir = await migrationDir({
      "9010_a.sql": "create table probe_two (id int);",
      "9002_b.sql": "create table probe_one (id int);",
    });
    const applied = await runMigrations(dir);
    expect(applied).toEqual(["9002_b.sql", "9010_a.sql"]);
  });

  it("records what it applied, and a second run applies nothing", async () => {
    const dir = await migrationDir({ "9002_b.sql": "create table probe_one (id int);" });
    expect(await runMigrations(dir)).toEqual(["9002_b.sql"]);
    expect(await runMigrations(dir)).toEqual([]);
  });

  it("leaves the database unchanged and the file unrecorded when a migration throws", async () => {
    // One transaction per file: the CREATE before the error must not
    // survive, or a half-applied schema is recorded as fully applied and
    // the next run skips it.
    const dir = await migrationDir({
      "9002_b.sql": "create table probe_fail (id int); select * from a_table_that_does_not_exist;",
    });

    await expect(runMigrations(dir)).rejects.toThrow();

    const table = await pool.query<{ exists: boolean }>(
      `select exists (select 1 from information_schema.tables
        where table_schema = 'public' and table_name = 'probe_fail') as exists`,
    );
    expect(table.rows[0]!.exists).toBe(false);

    const recorded = await pool.query(
      "select 1 from schema_migrations where filename = '9002_b.sql'",
    );
    expect(recorded.rowCount).toBe(0);
  });

  it("applies later files only after earlier ones succeed", async () => {
    const dir = await migrationDir({
      "9002_b.sql": "create table probe_one (id int);",
      "9003_b.sql": "select * from a_table_that_does_not_exist;",
      "9010_a.sql": "create table probe_two (id int);",
    });

    await expect(runMigrations(dir)).rejects.toThrow();

    // The first survives — "files applied before it stay applied".
    const recorded = await pool.query<{ filename: string }>(
      "select filename from schema_migrations where filename like '9%' order by filename",
    );
    expect(recorded.rows.map((row) => row.filename)).toEqual(["9002_b.sql"]);

    // The third never ran, even though it would have succeeded.
    const third = await pool.query<{ exists: boolean }>(
      `select exists (select 1 from information_schema.tables
        where table_schema = 'public' and table_name = 'probe_two') as exists`,
    );
    expect(third.rows[0]!.exists).toBe(false);
  });

  it("warns when a pending file is numbered below one already applied", async () => {
    // The hazard has been documented three times in this repo and detected
    // zero times until the runner started saying so.
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
    try {
      const dir = await migrationDir({ "9002_b.sql": "create table probe_one (id int);" });
      await runMigrations(dir);
      // 9002 is now applied; 9001 arriving afterwards is out of order.
      const later = await migrationDir({ "9001_late.sql": "select 1;" });
      await runMigrations(later);
    } finally {
      console.warn = original;
    }
    expect(warnings.join("\n")).toMatch(/numbered below/);
    expect(warnings.join("\n")).toMatch(/9001_late\.sql/);
  });
});

describe("withTransaction", () => {
  it("rolls back everything when the callback throws", async () => {
    const slug = `probe-rollback-${Date.now()}`;
    await expect(
      withTransaction(async (client) => {
        await client.query(
          "insert into projects (name, slug, repo_url) values ($1, $2, $3)",
          [slug, slug, "https://example.invalid/r.git"],
        );
        throw new Error("deliberate");
      }),
    ).rejects.toThrow("deliberate");

    const found = await pool.query("select 1 from projects where slug = $1", [slug]);
    expect(found.rowCount).toBe(0);
  });

  it("commits when the callback returns", async () => {
    const slug = `probe-commit-${Date.now()}`;
    const id = await withTransaction(async (client) => {
      const result = await client.query<{ id: string }>(
        "insert into projects (name, slug, repo_url) values ($1, $2, $3) returning id",
        [slug, slug, "https://example.invalid/r.git"],
      );
      return result.rows[0]!.id;
    });
    const found = await pool.query("select 1 from projects where id = $1", [id]);
    expect(found.rowCount).toBe(1);
    await pool.query("delete from projects where id = $1", [id]);
  });
});

describe("loadDatabaseConfig", () => {
  it("fails with a message naming the missing variable", () => {
    // An injected env object, not process.env — the point of the reader
    // taking one is that this is testable without mutating the process.
    expect(() => loadDatabaseConfig({})).toThrow(ConfigError);
    expect(() => loadDatabaseConfig({})).toThrow(/DATABASE_URL/);
  });

  it("takes pool size and statement timeout from config, not hardcoded values", () => {
    const config = loadDatabaseConfig({
      DATABASE_URL: "postgresql://u:p@localhost:5432/db",
      DATABASE_POOL_SIZE: "7",
      DATABASE_STATEMENT_TIMEOUT_MS: "1234",
    });
    expect(config.poolSize).toBe(7);
    expect(config.statementTimeoutMs).toBe(1234);
  });

  it("rejects a non-integer pool size rather than silently defaulting", () => {
    expect(() =>
      loadDatabaseConfig({ DATABASE_URL: "postgresql://u:p@localhost:5432/db", DATABASE_POOL_SIZE: "lots" }),
    ).toThrow(/DATABASE_POOL_SIZE/);
  });
});
