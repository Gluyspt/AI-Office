// The ownership registry: acquire, release, heartbeat, expire.
//
// "Keep agents from creating git conflicts, reliably" is one of the
// design's five goals, and this is the module behind it. `claim_task`
// (017) and the PreToolUse guard (020) are both thin callers of what is
// here; neither re-implements the overlap rule, which lives in overlap.ts
// and is tested as a table there.
//
//
// THREE RELEASE PATHS, because the design says no single one is reliable
// -----------------------------------------------------------------------
//   1. `releaseByTask`  — the normal path, on completion.
//   2. `releaseBySession` — the SessionEnd path. **Ignores `reason: "clear"`**:
//      SessionEnd fires when a user or agent runs `/clear`, and the agent
//      carries on working afterwards. Treating every SessionEnd as "this
//      session is finished" would free locks out from under a live agent,
//      which is precisely the git conflict this registry exists to prevent.
//      Observed reasons are `clear`, `other`, `prompt_input_exit`.
//   3. `expireLocks` — the TTL sweeper. Spike 003 measured SessionEnd
//      firing 8/8 on `kill-session`, so this is a backstop rather than the
//      primary path — but whether that still holds *through `sudo -u`* is
//      unmeasured, which is why LOCK_TTL_SECONDS is required config with no
//      default.
//
//
// HOW CONCURRENCY IS MADE SAFE
// -----------------------------
// Two mechanisms, covering different cases on purpose:
//
//   - A partial unique index on (project_id, path_pattern) where
//     released_at is null. This is the database-side guarantee for the
//     *identical pattern* race, and it holds regardless of application
//     code.
//   - A per-project transaction-scoped advisory lock around the
//     read-then-insert in `acquireScope`. Overlap between *different*
//     patterns (`src/` versus `src/a.ts`) is not something a unique index
//     can express, so the check and the insert have to be atomic with
//     respect to other acquisitions in the same project. Advisory rather
//     than row locks: there is no row to lock for a pattern nobody holds
//     yet.
import type { PoolClient } from "pg";
import type {
  AcquireScopeResult,
  FileLockRecord,
  ScopeConflict,
} from "@office/shared/locks";
import type { ProjectId, TaskId } from "@office/shared/ids";
import { asProjectId, asTaskId } from "@office/shared/ids";
import { query, withTransaction } from "../../core/db/pool.ts";
import { loadLocksConfig } from "../../core/config.ts";
import { recordSystemEvent } from "../events/ingest.ts";
import { normaliseScope, patternsOverlap } from "./overlap.ts";

interface LockRow {
  readonly id: string;
  readonly project_id: string;
  readonly task_id: string;
  readonly session_id: string | null;
  readonly path_pattern: string;
  readonly acquired_at: Date;
  readonly expires_at: Date;
  readonly paused: boolean;
  readonly released_at: Date | null;
}

const LOCK_COLUMNS =
  "id, project_id, task_id, session_id, path_pattern, acquired_at, expires_at, paused, released_at";

function rowToLock(row: LockRow): FileLockRecord {
  return {
    id: row.id,
    projectId: asProjectId(row.project_id),
    taskId: asTaskId(row.task_id),
    sessionId: row.session_id,
    pathPattern: row.path_pattern,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
    paused: row.paused,
    releasedAt: row.released_at,
  };
}

/**
 * Still held, for conflict purposes.
 *
 * A lock past its TTL does *not* block a new acquisition even before the
 * sweeper has run — otherwise a crashed agent's scope stays unusable for as
 * long as nobody happens to call the sweeper, which turns a backstop into a
 * deadline. Paused locks are exempt from expiry entirely: a paused task
 * still owns its files.
 */
const HELD = "released_at is null and (paused = true or expires_at > now())";

export interface AcquireScopeInput {
  readonly projectId: ProjectId;
  readonly taskId: TaskId;
  readonly sessionId?: string | null;
  /** Raw patterns; normalised here, so a caller never has to remember to. */
  readonly patterns: readonly string[];
  /** Overrides LOCK_TTL_SECONDS. Present for tests that need a lock to
   * expire inside a test run, not for production callers. */
  readonly ttlSeconds?: number;
}

/**
 * All-or-nothing acquisition of a whole declared scope.
 *
 * A scope where one of five patterns conflicts acquires none of them: a
 * partially-held scope is worse than a refused one, because the task
 * appears to own files it does not and the operator has nothing clean to
 * retry.
 */
export async function acquireScope(
  input: AcquireScopeInput,
  client?: PoolClient,
): Promise<AcquireScopeResult> {
  const patterns = normaliseScope(input.patterns);
  const ttlSeconds = input.ttlSeconds ?? loadLocksConfig().ttlSeconds;

  const reclaimed: FileLockRecord[] = [];

  const run = async (db: PoolClient): Promise<AcquireScopeResult> => {
    // Serialise acquisitions within a project. Transaction-scoped, so it is
    // released at COMMIT or ROLLBACK and cannot leak across a pooled
    // connection.
    await db.query("select pg_advisory_xact_lock(hashtext($1))", [input.projectId]);

    // Reclaim this project's expired locks before looking at what is held.
    //
    // Not an optimisation — a correctness requirement. `HELD` treats an
    // expired lock as free, but the partial unique index keys on
    // `released_at is null` alone and so still considers it to occupy its
    // pattern. A partial index cannot say "unexpired": predicates must be
    // IMMUTABLE and now() is not. Without this the two definitions
    // disagree, and acquiring a pattern whose previous holder crashed fails
    // on the index instead of succeeding.
    //
    // Doing it here also makes "an expired lock stops blocking" true
    // without waiting for a sweeper to happen to run, and it is safe
    // because it happens under the advisory lock.
    const swept = await db.query<LockRow>(
      `update file_locks set released_at = now()
        where project_id = $1 and released_at is null
          and paused = false and expires_at <= now()
        returning ${LOCK_COLUMNS}`,
      [input.projectId],
    );
    reclaimed.push(...swept.rows.map(rowToLock));

    const held = await db.query<LockRow>(
      `select ${LOCK_COLUMNS} from file_locks where project_id = $1 and ${HELD}`,
      [input.projectId],
    );

    const conflicts: ScopeConflict[] = [];
    const alreadyOurs = new Set<string>();

    for (const pattern of patterns) {
      for (const row of held.rows) {
        if (row.task_id === input.taskId) {
          // A task re-declaring its own scope is not a conflict with
          // itself. The exact pattern is skipped on insert below; an
          // overlapping-but-different one is simply allowed.
          if (row.path_pattern === pattern) alreadyOurs.add(pattern);
          continue;
        }
        const verdict = patternsOverlap(pattern, row.path_pattern);
        if (verdict.overlaps) {
          conflicts.push({
            requested: pattern,
            heldPattern: row.path_pattern,
            heldByTaskId: asTaskId(row.task_id),
            heldBySessionId: row.session_id,
            certain: verdict.certain,
            reason: verdict.reason,
          });
        }
      }
    }

    if (conflicts.length > 0) {
      return { ok: false, conflicts };
    }

    const toInsert = patterns.filter((pattern) => !alreadyOurs.has(pattern));
    const locks: FileLockRecord[] = [];
    for (const pattern of toInsert) {
      const inserted = await db.query<LockRow>(
        `insert into file_locks (project_id, task_id, session_id, path_pattern, expires_at)
         values ($1, $2, $3, $4, now() + ($5::int * interval '1 second'))
         returning ${LOCK_COLUMNS}`,
        [input.projectId, input.taskId, input.sessionId ?? null, pattern, ttlSeconds],
      );
      locks.push(rowToLock(inserted.rows[0]!));
    }

    // Patterns this task already held come back too, so the caller's view
    // of "what I now own" is the whole scope rather than only the delta.
    for (const pattern of patterns) {
      if (!alreadyOurs.has(pattern)) continue;
      const existing = held.rows.find(
        (row) => row.task_id === input.taskId && row.path_pattern === pattern,
      );
      if (existing) locks.push(rowToLock(existing));
    }

    return { ok: true, locks };
  };

  const result = client ? await run(client) : await withTransaction(run);

  // Announced after the transaction, so the event describes a reclaim that
  // actually committed. Same reasoning as the sweeper's: a reclaimed lock
  // means some agent lost its files without asking, and that has to be
  // visible rather than inferred from a task that mysteriously stops
  // conflicting.
  if (reclaimed.length > 0) {
    await recordSystemEvent("FileLocksSwept", {
      trigger: "acquire",
      expired: reclaimed.map((lock) => ({
        lock_id: lock.id,
        project_id: lock.projectId,
        task_id: lock.taskId,
        session_id: lock.sessionId,
        path_pattern: lock.pathPattern,
      })),
      orphaned: [],
    });
  }

  return result;
}

// --- Release paths ---------------------------------------------------------------

/** Normal release, on completion. Idempotent: releasing an already-released
 * lock leaves its original timestamp alone rather than moving it, so the
 * audit keeps saying when the files were actually let go. */
export async function releaseByTask(taskId: TaskId, client?: PoolClient): Promise<number> {
  const sql = `update file_locks set released_at = now()
               where task_id = $1 and released_at is null`;
  const result = client ? await client.query(sql, [taskId]) : await query(sql, [taskId]);
  return result.rowCount ?? 0;
}

/**
 * The SessionEnd path.
 *
 * `reason` is the SessionEnd payload's own field. **`clear` releases
 * nothing** — see the module header: `/clear` ends a session while the
 * agent keeps working, and freeing its locks there is the exact failure the
 * registry exists to prevent. Returning 0 rather than throwing, because a
 * `/clear` is perfectly normal and the handler calling this has nothing to
 * report.
 */
export async function releaseBySession(
  sessionId: string,
  reason: string,
  client?: PoolClient,
): Promise<number> {
  if (reason === "clear") return 0;
  const sql = `update file_locks set released_at = now()
               where session_id = $1 and released_at is null`;
  const result = client ? await client.query(sql, [sessionId]) : await query(sql, [sessionId]);
  return result.rowCount ?? 0;
}

// --- Heartbeat and pause ----------------------------------------------------------

/**
 * Pushes a task's locks out by a fresh TTL.
 *
 * Paused locks are skipped: they are exempt from expiry already, and
 * moving their deadline would be meaningless.
 *
 * OPEN, and not this ticket's to settle: what *triggers* a heartbeat. The
 * design implies `PostToolUse`, which spike 002 never observed firing and
 * which is absent from the design's own hook block. The endpoint exists
 * here; ticket 020 decides what calls it.
 */
export async function heartbeat(
  taskId: TaskId,
  ttlSeconds?: number,
  client?: PoolClient,
): Promise<number> {
  const ttl = ttlSeconds ?? loadLocksConfig().ttlSeconds;
  const sql = `update file_locks
                  set expires_at = now() + ($2::int * interval '1 second')
                where task_id = $1 and released_at is null and paused = false`;
  const result = client
    ? await client.query(sql, [taskId, ttl])
    : await query(sql, [taskId, ttl]);
  return result.rowCount ?? 0;
}

/** Marks a task's locks paused or unpaused. Ticket 028's Pause calls this;
 * exposed here because the exemption it produces is this module's rule. */
export async function setLocksPaused(
  taskId: TaskId,
  paused: boolean,
  client?: PoolClient,
): Promise<number> {
  const sql = `update file_locks set paused = $2
               where task_id = $1 and released_at is null`;
  const result = client
    ? await client.query(sql, [taskId, paused])
    : await query(sql, [taskId, paused]);
  return result.rowCount ?? 0;
}

// --- The sweeper -------------------------------------------------------------------

export interface SweepResult {
  readonly expired: readonly FileLockRecord[];
  /**
   * Locks whose task no longer exists.
   *
   * With `on delete cascade` on task_id this should always be empty, and it
   * is checked anyway: the criterion is that such a lock is *reported*
   * rather than left forever, and a defensive check that stays at zero is
   * how a future schema change that drops the cascade gets noticed.
   */
  readonly orphaned: readonly FileLockRecord[];
}

/**
 * Releases every held, unpaused lock past its TTL and announces it.
 *
 * The event matters as much as the release: a reclaimed lock means some
 * agent lost its files without asking, and that has to be visible rather
 * than inferred from a task that mysteriously starts conflicting.
 */
export async function expireLocks(client?: PoolClient): Promise<SweepResult> {
  const expireSql = `update file_locks set released_at = now()
                      where released_at is null and paused = false and expires_at <= now()
                      returning ${LOCK_COLUMNS}`;
  const orphanSql = `select ${LOCK_COLUMNS} from file_locks l
                      where l.released_at is null
                        and not exists (select 1 from tasks t where t.id = l.task_id)`;

  const expiredResult = client
    ? await client.query<LockRow>(expireSql)
    : await query<LockRow>(expireSql);
  const orphanResult = client
    ? await client.query<LockRow>(orphanSql)
    : await query<LockRow>(orphanSql);

  const expired = expiredResult.rows.map(rowToLock);
  const orphaned = orphanResult.rows.map(rowToLock);

  if (expired.length > 0 || orphaned.length > 0) {
    await recordSystemEvent("FileLocksSwept", {
      trigger: "sweeper",
      expired: expired.map((lock) => ({
        lock_id: lock.id,
        project_id: lock.projectId,
        task_id: lock.taskId,
        session_id: lock.sessionId,
        path_pattern: lock.pathPattern,
      })),
      orphaned: orphaned.map((lock) => ({
        lock_id: lock.id,
        task_id: lock.taskId,
        path_pattern: lock.pathPattern,
      })),
    });
  }

  return { expired, orphaned };
}

// --- Read ----------------------------------------------------------------------------

export interface ListLocksFilters {
  readonly projectId?: ProjectId | null;
  readonly taskId?: TaskId | null;
  readonly sessionId?: string | null;
}

export async function listActiveLocks(
  filters: ListLocksFilters = {},
  client?: PoolClient,
): Promise<FileLockRecord[]> {
  const sql = `select ${LOCK_COLUMNS} from file_locks
                where ${HELD}
                  and ($1::uuid is null or project_id = $1)
                  and ($2::uuid is null or task_id = $2)
                  and ($3::uuid is null or session_id = $3)
                order by acquired_at asc, id asc`;
  const params = [filters.projectId ?? null, filters.taskId ?? null, filters.sessionId ?? null];
  const result = client
    ? await client.query<LockRow>(sql, params)
    : await query<LockRow>(sql, params);
  return result.rows.map(rowToLock);
}
