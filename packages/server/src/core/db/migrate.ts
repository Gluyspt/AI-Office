// Migration runner. Reads db/migrations/*.sql, sorts by filename (never by
// directory listing order — readdir's return order is not guaranteed to
// match filename order on every platform/filesystem), and applies whichever
// haven't run yet, each in its own transaction, recording it as it goes.
//
// schema_migrations is created by 0001_core.sql itself, not by this runner
// — so "does schema_migrations exist yet" doubles as "has any migration
// ever run" on a brand-new database. See appliedMigrations() below.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool, withTransaction } from "./pool.ts";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

// packages/server/src/core/db -> repo root is five levels up. This count is
// tied to this file's depth — it was four before db/ moved under src/core/,
// and getting it wrong fails as ENOENT on a directory one level short of
// the repo root, which reads like a missing db/ rather than a bad path.
export const migrationsDir = path.resolve(moduleDir, "../../../../../db/migrations");

async function schemaMigrationsTableExists(): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `select exists (
       select 1 from information_schema.tables
       where table_schema = 'public' and table_name = 'schema_migrations'
     ) as exists`,
  );
  return result.rows[0]?.exists ?? false;
}

async function appliedMigrations(): Promise<Set<string>> {
  if (!(await schemaMigrationsTableExists())) {
    return new Set();
  }
  const result = await pool.query<{ filename: string }>("select filename from schema_migrations");
  return new Set(result.rows.map((row) => row.filename));
}

async function pendingMigrationFiles(dir: string, applied: ReadonlySet<string>): Promise<string[]> {
  const entries = await readdir(dir);
  return entries
    .filter((name) => name.endsWith(".sql"))
    .sort() // filename order — load-bearing, see module comment above
    .filter((name) => !applied.has(name));
}

/**
 * Warns when a pending migration is numbered BELOW one already applied.
 *
 * This runner applies *pending* files in filename order, so filename order
 * equals application order only on a database that starts empty. A file
 * added later with a lower number therefore runs after its numeric
 * successors, and any dependency it has on them is satisfied by accident of
 * history rather than by design.
 *
 * It is not an error — it has happened twice here on purpose and was safe
 * both times (0005_tasks.sql documented the hazard; 0006_task_dependencies
 * landed after 0007_file_locks and referenced only lower-numbered tables).
 * But "safe" was established by a human reading the file, and the condition
 * was previously invisible. This makes it say so out loud, once, naming the
 * files involved.
 */
function warnOnOutOfOrder(pending: readonly string[], applied: ReadonlySet<string>): void {
  if (applied.size === 0) return; // a fresh database applies everything in order
  const highestApplied = [...applied].sort().at(-1)!;
  const outOfOrder = pending.filter((name) => name < highestApplied);
  if (outOfOrder.length === 0) return;

  const lines = [
    `WARNING: ${outOfOrder.length} pending migration(s) numbered below ${highestApplied}, ` +
      "which has already been applied:",
    ...outOfOrder.map((name) => `  - ${name}`),
    "  They will run AFTER it, not before. That is fine as long as none of them depends",
    "  on a table a higher-numbered migration created — check before trusting this run",
    "  on a database that is not empty.",
  ];
  console.warn(lines.join("\n"));
}

/**
 * Applies every pending migration in `dir`, in filename order, one
 * transaction per file. Returns the filenames applied, in the order they
 * ran. A file that throws leaves that file's changes rolled back and
 * unrecorded; files applied before it stay applied.
 */
export async function runMigrations(dir: string = migrationsDir): Promise<string[]> {
  const applied = await appliedMigrations();
  const pending = await pendingMigrationFiles(dir, applied);
  warnOnOutOfOrder(pending, applied);
  const appliedNow: string[] = [];

  for (const filename of pending) {
    const sql = await readFile(path.join(dir, filename), "utf8");
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query("insert into schema_migrations (filename) values ($1)", [filename]);
    });
    console.log(`Applied ${filename}`);
    appliedNow.push(filename);
  }

  return appliedNow;
}

async function main(): Promise<void> {
  try {
    const applied = await runMigrations();
    if (applied.length === 0) {
      console.log("No pending migrations.");
    }
  } catch (error) {
    console.error(`Migration failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  await main();
}
