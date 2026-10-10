// What the guard could not stop: ingest a flushed buffer, work out
// retroactively whether any of it touched a file another active task owned,
// and flag those tasks for review.
//
// Ticket 020, the second half of its Decided section: "During an outage the
// protection degrades to `claim_task` alone; afterwards, the damage is
// enumerated rather than guessed at."
//
//
// WHAT "RETROACTIVELY" MEANS HERE, AND WHY IT IS NOT "CURRENTLY HELD"
// ------------------------------------------------------------------
// The obvious implementation checks each buffered path against the locks held
// *now*. That is wrong in the direction that matters: an outage is exactly
// when tasks complete and release their scope, so by the time the buffer is
// flushed the owner may have finished and the collision would vanish from the
// record. The check therefore asks whether a lock was held **at the moment of
// the edit** —
//
//     acquired_at <= attempted_at AND (released_at IS NULL OR released_at >= attempted_at)
//
// — which `file_locks` can answer because releasing sets a timestamp instead
// of deleting the row (015 made release idempotent precisely so the audit
// keeps saying when the files were let go).
//
// `attempted_at` comes off the AGENT'S clock, which is a different machine
// from this one, and the target host's wall clock was observed stepping
// backwards twice in one session. So the window is widened by
// `CLOCK_SKEW_GRACE` rather than trusted to the millisecond, and a missing
// `attempted_at` falls back to "held at any point" — the conservative branch,
// consistent with the registry's own conservative-resolution rule: a false
// flag costs a human a glance, a false clearance costs the git conflict the
// whole mechanism exists to prevent.
//
//
// WHAT A FLAG IS AND IS NOT
// -------------------------
// It flags for review; it cannot undo. Both tasks are flagged — the task that
// made the unguarded edit and the task that owned the file — because an
// operator needs to look at both sides of a possible collision, and the
// acceptance criterion says so in as many words ("confirm both tasks are
// flagged").
//
// Whether a flagged task should also be **paused** automatically is the
// ticket's open question and is deliberately NOT implemented: the signal is
// stale by construction (the check runs after the fact, when both agents may
// already have finished), and auto-pausing on a stale signal is its own
// failure mode.
import type { PoolClient } from "pg";
import type { ProjectId, TaskId } from "@office/shared/ids";
import { query, withTransaction } from "../../core/db/pool.ts";
import { loadGuardConfig } from "../../core/config.ts";
import { recordSystemEvent } from "../events/ingest.ts";
import { asUuidOrNull, callerScope, resolveRepoRelative } from "./guard-check.ts";
import { patternsOverlap } from "./overlap.ts";

/**
 * How far either side of `attempted_at` a lock still counts as held.
 *
 * Not tuning: the two clocks involved are on different machines and one of
 * them was measured stepping backwards (−494 ms and −100 ms in one session on
 * the target, 2026-10-07). Five minutes is far wider than any plausible skew
 * and costs only extra flags, which is the cheap direction.
 */
const CLOCK_SKEW_GRACE = "5 minutes";

// --- The wire shape the guard script sends --------------------------------------

/**
 * One buffered edit, as `hooks/pretooluse-guard.sh` writes it.
 *
 * Every field is optional except `edit_id`, because the buffer is written
 * while something is already broken: an agent box with no `jq` records the
 * attempt with no paths at all rather than guessing one out of file content,
 * and a payload the script could not read at all still produces a line. A
 * flush that rejected those rows would throw away the only evidence that
 * anything happened.
 */
export interface FlushedEdit {
  readonly edit_id?: unknown;
  readonly at?: unknown;
  readonly session_id?: unknown;
  readonly cwd?: unknown;
  readonly tool_name?: unknown;
  readonly tool_use_id?: unknown;
  readonly paths?: unknown;
  readonly reason?: unknown;
  readonly extract?: unknown;
}

export interface FlushRequest {
  readonly session_id?: unknown;
  readonly dropped?: unknown;
  readonly edits?: unknown;
}

export interface FlushedEditResult {
  readonly editId: string;
  /** False when this exact edit id was already on record — the idempotency
   *  path, and the one a second flush of the same spool takes for every row. */
  readonly accepted: boolean;
  readonly paths: readonly string[];
  readonly conflicts: number;
}

export interface FlushResult {
  readonly flushId: string;
  readonly received: number;
  readonly accepted: number;
  readonly duplicates: number;
  readonly conflicts: number;
  readonly flaggedTaskIds: readonly TaskId[];
  readonly edits: readonly FlushedEditResult[];
  /** Lines with no `edit_id` at all. Counted rather than dropped quietly:
   *  without an id there is no idempotency key, so the row cannot be stored
   *  safely — but an operator still needs to know the buffer held something
   *  unreadable. */
  readonly unusable: number;
  readonly droppedReported: number;
  /** Set when the request carried more edits than GUARD_FLUSH_MAX_EDITS. The
   *  overflow is refused, not silently truncated — see `ingestFlush`. */
  readonly refusedOverflow: number;
}

// --- Parsing --------------------------------------------------------------------

function text(value: unknown, max = 1024): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const path = text(item, 4096);
    if (path !== null && !out.includes(path)) out.push(path);
  }
  return out;
}

function timestamp(value: unknown): Date | null {
  const raw = text(value, 64);
  if (raw === null) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function nonNegativeInt(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return 0;
}

// --- Ingest ---------------------------------------------------------------------

interface PreparedEdit {
  readonly editId: string;
  readonly claudeSessionId: string | null;
  readonly cwd: string | null;
  readonly toolName: string | null;
  readonly toolUseId: string | null;
  readonly rawPaths: readonly string[];
  readonly relativePaths: readonly string[];
  readonly reason: string | null;
  readonly extractNote: string | null;
  readonly attemptedAt: Date | null;
}

function prepare(edit: FlushedEdit, fallbackSessionId: string | null): PreparedEdit | null {
  const editId = text(edit.edit_id, 200);
  // The ONE field with no fallback. Without it there is no idempotency key,
  // and a row that can be inserted twice turns "a flush that arrives twice
  // does not double-flag" into a coin toss.
  if (editId === null) return null;

  const cwd = text(edit.cwd, 4096);
  const rawPaths = stringArray(edit.paths);
  const relativePaths: string[] = [];
  const unresolved: string[] = [];
  for (const raw of rawPaths) {
    const resolution = resolveRepoRelative(raw, cwd);
    if (resolution.ok) {
      if (!relativePaths.includes(resolution.relative)) relativePaths.push(resolution.relative);
    } else {
      unresolved.push(`${raw}: ${resolution.skipped}`);
    }
  }

  const scriptNote = text(edit.extract, 200);
  const notes = [
    scriptNote,
    unresolved.length > 0 ? `not repo-relative — ${unresolved.join("; ")}` : null,
  ].filter((note): note is string => note !== null);

  return {
    editId,
    claudeSessionId: asUuidOrNull(edit.session_id) ?? fallbackSessionId,
    cwd,
    toolName: text(edit.tool_name, 200),
    toolUseId: text(edit.tool_use_id, 200),
    rawPaths,
    relativePaths,
    reason: text(edit.reason, 2048),
    extractNote: notes.length > 0 ? notes.join(" | ") : null,
    attemptedAt: timestamp(edit.at),
  };
}

interface LockRowAtTime {
  readonly id: string;
  readonly task_id: string;
  readonly path_pattern: string;
  readonly session_id: string | null;
  readonly title: string | null;
  readonly owner: string | null;
}

/**
 * Locks held at `attemptedAt`, in `projectId`, with their task's facts
 * denormalised in the same round trip.
 *
 * The join is a left join on purpose: `file_locks.task_id` cascades on task
 * delete, so a row whose task is gone cannot normally exist — but the
 * registry's own sweeper reports orphans for exactly the case where one
 * survives by some other route, and a flush that threw on one would lose the
 * whole outage's record.
 */
async function locksHeldAt(
  projectId: ProjectId,
  attemptedAt: Date | null,
  client?: PoolClient,
): Promise<readonly LockRowAtTime[]> {
  const sql = `
    select l.id, l.task_id, l.path_pattern, l.session_id, t.title, t.owner
      from file_locks l
      left join tasks t on t.id = l.task_id
     where l.project_id = $1
       and ($2::timestamptz is null
            or (l.acquired_at <= $2::timestamptz + interval '${CLOCK_SKEW_GRACE}'
                and (l.released_at is null
                     or l.released_at >= $2::timestamptz - interval '${CLOCK_SKEW_GRACE}')))`;
  const params = [projectId, attemptedAt];
  const result = client
    ? await client.query<LockRowAtTime>(sql, params)
    : await query<LockRowAtTime>(sql, params);
  return result.rows;
}

/**
 * Accepts a flushed buffer and runs the retroactive check over it.
 *
 * IDEMPOTENT BY EDIT ID. The insert is `on conflict (edit_id) do nothing` and
 * the retroactive check runs only for rows this call actually inserted, so a
 * flush that arrives twice flags nothing twice. The script does not delete its
 * spool until this returns 2xx, which is what makes a lost ack safe: it
 * re-sends, and the second attempt is a no-op that still acknowledges.
 */
export async function ingestFlush(request: FlushRequest): Promise<FlushResult> {
  const { flushMaxEdits } = loadGuardConfig();
  const fallbackSessionId = asUuidOrNull(request.session_id);
  const droppedReported = nonNegativeInt(request.dropped);

  const rawEdits = Array.isArray(request.edits) ? (request.edits as FlushedEdit[]) : [];
  // Refused, not truncated. The buffer is capped on the agent's box too, and
  // an overflow here means that cap was raised on a machine the orchestrator
  // does not control. Silently dropping the tail would make the record claim
  // completeness it does not have; refusing the overflow and reporting the
  // count leaves the script's spool intact for a second, smaller flush.
  const edits = rawEdits.slice(0, flushMaxEdits);
  const refusedOverflow = rawEdits.length - edits.length;

  const flushId = (await query<{ id: string }>(`select gen_random_uuid() as id`)).rows[0]!.id;

  const results: FlushedEditResult[] = [];
  const flagged = new Map<string, string>();
  let accepted = 0;
  let duplicates = 0;
  let unusable = 0;
  let conflicts = 0;
  let projectForEvent: ProjectId | null = null;
  let earliest: Date | null = null;
  let latest: Date | null = null;

  for (const raw of edits) {
    const edit = prepare(raw, fallbackSessionId);
    if (edit === null) {
      unusable += 1;
      continue;
    }
    if (edit.attemptedAt !== null) {
      if (earliest === null || edit.attemptedAt < earliest) earliest = edit.attemptedAt;
      if (latest === null || edit.attemptedAt > latest) latest = edit.attemptedAt;
    }

    // The editing session's own scope, resolved live. It is the best available
    // answer: nothing records which task a session was working on at a past
    // moment, and the locks a session holds are the only link the schema has
    // (there is no `sessions.task_id`). Stated rather than hidden — if the
    // session has since released everything, the offending task is unknown
    // and the row records null rather than a guess.
    const scope = await callerScope(edit.claudeSessionId);
    const offenderTaskId = scope.taskIds.length === 1 ? scope.taskIds[0]! : null;
    const projectId = scope.projectId;
    if (projectForEvent === null && projectId !== null) projectForEvent = projectId;

    const outcome = await withTransaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `insert into unguarded_edits
           (edit_id, flush_id, project_id, session_id, session_row_id, task_id,
            tool_name, tool_use_id, paths, raw_paths, cwd, reason, extract_note,
            attempted_at, buffer_dropped)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10::text[], $11, $12, $13, $14, $15)
         on conflict (edit_id) do nothing
         returning id`,
        [
          edit.editId,
          flushId,
          projectId,
          edit.claudeSessionId,
          scope.sessionRowId,
          offenderTaskId,
          edit.toolName,
          edit.toolUseId,
          edit.relativePaths,
          edit.rawPaths,
          edit.cwd,
          edit.reason,
          edit.extractNote,
          edit.attemptedAt,
          droppedReported,
        ],
      );
      const row = inserted.rows[0];
      if (!row) {
        return { accepted: false, conflicts: 0 as number };
      }

      if (projectId === null) {
        // Nothing to check against: no project means no lock table to search.
        // Still marked checked, so "accepted but never checked" keeps meaning
        // "the orchestrator crashed mid-flush".
        await client.query(`update unguarded_edits set checked_at = now() where id = $1`, [row.id]);
        return { accepted: true, conflicts: 0 as number };
      }

      const held = await locksHeldAt(projectId, edit.attemptedAt, client);
      const own = new Set<string>(scope.taskIds);
      let found = 0;

      for (const path of edit.relativePaths) {
        for (const lock of held) {
          if (own.has(lock.task_id)) continue;
          const verdict = patternsOverlap(path, lock.path_pattern);
          if (!verdict.overlaps) continue;
          const conflictInsert = await client.query(
            `insert into unguarded_edit_conflicts
               (unguarded_edit_id, path, owner_task_id, owner_task_title, owner_task_owner,
                held_pattern, held_lock_id, certain, reason)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             on conflict (unguarded_edit_id, path, owner_task_id) do nothing`,
            [
              row.id,
              path,
              lock.task_id,
              lock.title,
              lock.owner,
              lock.path_pattern,
              lock.id,
              verdict.certain,
              verdict.reason,
            ],
          );
          if ((conflictInsert.rowCount ?? 0) === 0) continue;
          found += 1;
          flagged.set(
            lock.task_id,
            `a file this task owned (${lock.path_pattern}) was edited by another agent while the ownership guard was unreachable`,
          );
          if (offenderTaskId !== null) {
            flagged.set(
              offenderTaskId,
              `this task edited ${path}, owned by another active task, while the ownership guard was unreachable`,
            );
          }
        }
      }

      await client.query(
        `update unguarded_edits set checked_at = now(), conflict_count = $2 where id = $1`,
        [row.id, found],
      );
      return { accepted: true, conflicts: found };
    });

    if (outcome.accepted) accepted += 1;
    else duplicates += 1;
    conflicts += outcome.conflicts;
    results.push({
      editId: edit.editId,
      accepted: outcome.accepted,
      paths: edit.relativePaths,
      conflicts: outcome.conflicts,
    });
  }

  const flaggedTaskIds = await flagTasks(flagged);

  // One event per flush, plus one per newly flagged task.
  //
  // The flush event IS the degradation record for an outage this process never
  // saw: the orchestrator was down, so `guard-check.ts`'s live
  // GuardDegraded/GuardRecovered pair could not fire. Emitting the pair here,
  // bracketing the buffered window, is what lets ticket 029 show the banner
  // and the listing for an outage that happened while the UI was also down.
  if (accepted > 0) {
    await recordSystemEvent(
      "GuardDegraded",
      {
        reason: "the guard buffered edits while the orchestrator was unreachable",
        source: "flush",
        flush_id: flushId,
        from: earliest?.toISOString() ?? null,
        to: latest?.toISOString() ?? null,
        unguarded_edits: accepted,
      },
      null,
      projectForEvent,
    );
  }
  await recordSystemEvent(
    "UnguardedEditsFlushed",
    {
      flush_id: flushId,
      received: edits.length,
      accepted,
      duplicates,
      unusable,
      conflicts,
      flagged_task_ids: flaggedTaskIds,
      buffer_dropped: droppedReported,
      refused_overflow: refusedOverflow,
      from: earliest?.toISOString() ?? null,
      to: latest?.toISOString() ?? null,
    },
    null,
    projectForEvent,
  );
  if (accepted > 0) {
    await recordSystemEvent(
      "GuardRecovered",
      { source: "flush", flush_id: flushId, unguarded_edits: accepted },
      null,
      projectForEvent,
    );
  }

  return {
    flushId,
    received: edits.length,
    accepted,
    duplicates,
    unusable,
    conflicts,
    flaggedTaskIds,
    edits: results,
    droppedReported,
    refusedOverflow,
  };
}

/**
 * Raises the review flag, stickily.
 *
 * `review_flagged_at` moves only on the FIRST flag (`coalesce`), and the
 * reason is written only when there is none: "when did this task first need
 * looking at" is the question an operator asks, and a later outage
 * overwriting it loses the answer. The detail of every finding is in
 * `unguarded_edit_conflicts` regardless.
 *
 * Returns only the tasks this call actually moved, so the event stream does
 * not re-announce a task that was already flagged — which is the other half
 * of "a flush that arrives twice does not double-flag".
 */
async function flagTasks(reasons: ReadonlyMap<string, string>): Promise<TaskId[]> {
  const moved: TaskId[] = [];
  for (const [taskId, reason] of reasons) {
    const result = await query<{ id: string; project_id: string }>(
      `update tasks
          set review_flagged = true,
              review_flagged_at = coalesce(review_flagged_at, now()),
              review_flagged_reason = coalesce(review_flagged_reason, $2)
        where id = $1 and review_flagged = false
        returning id, project_id`,
      [taskId, reason],
    );
    const row = result.rows[0];
    if (!row) continue;
    moved.push(row.id as TaskId);
    await recordSystemEvent(
      "TaskFlaggedForReview",
      { task_id: row.id, reason, source: "unguarded_edit" },
      null,
      row.project_id,
    );
  }
  return moved;
}

// --- Read ------------------------------------------------------------------------

export interface UnguardedEditSummary {
  readonly id: string;
  readonly editId: string;
  readonly flushId: string;
  readonly projectId: string | null;
  readonly sessionId: string | null;
  readonly taskId: string | null;
  readonly toolName: string | null;
  readonly paths: readonly string[];
  readonly reason: string | null;
  readonly extractNote: string | null;
  /** Text, not a Date. `timestamptz` -> JS `Date` loses microseconds, and a
   *  caller comparing this against a stored value would silently never
   *  match — a mistake this repo has made four times. */
  readonly attemptedAt: string | null;
  readonly receivedAt: string;
  readonly checkedAt: string | null;
  readonly conflictCount: number;
  readonly bufferDropped: number;
}

export interface ListUnguardedEditsFilters {
  readonly projectId?: string | null;
  readonly flushId?: string | null;
  readonly limit?: number;
}

export async function listUnguardedEdits(
  filters: ListUnguardedEditsFilters = {},
): Promise<UnguardedEditSummary[]> {
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
  const result = await query<{
    id: string;
    edit_id: string;
    flush_id: string;
    project_id: string | null;
    session_id: string | null;
    task_id: string | null;
    tool_name: string | null;
    paths: string[];
    reason: string | null;
    extract_note: string | null;
    attempted_at: string | null;
    received_at: string;
    checked_at: string | null;
    conflict_count: number;
    buffer_dropped: number;
  }>(
    `select id, edit_id, flush_id, project_id, session_id, task_id, tool_name, paths,
            reason, extract_note,
            attempted_at::text as attempted_at,
            received_at::text as received_at,
            checked_at::text as checked_at,
            conflict_count, buffer_dropped
       from unguarded_edits
      where ($1::uuid is null or project_id = $1)
        and ($2::uuid is null or flush_id = $2)
      order by received_at desc, id desc
      limit $3`,
    [filters.projectId ?? null, filters.flushId ?? null, limit],
  );
  return result.rows.map((row) => ({
    id: row.id,
    editId: row.edit_id,
    flushId: row.flush_id,
    projectId: row.project_id,
    sessionId: row.session_id,
    taskId: row.task_id,
    toolName: row.tool_name,
    paths: row.paths,
    reason: row.reason,
    extractNote: row.extract_note,
    attemptedAt: row.attempted_at,
    receivedAt: row.received_at,
    checkedAt: row.checked_at,
    conflictCount: Number(row.conflict_count),
    bufferDropped: Number(row.buffer_dropped),
  }));
}

/** Exported for tests and for ticket 029's listing: the findings of one edit. */
export async function listConflictsForEdit(unguardedEditId: string): Promise<
  readonly {
    readonly path: string;
    readonly ownerTaskId: string | null;
    readonly ownerTaskTitle: string | null;
    readonly ownerTaskOwner: string | null;
    readonly heldPattern: string;
    readonly certain: boolean;
    readonly reason: string;
  }[]
> {
  const result = await query<{
    path: string;
    owner_task_id: string | null;
    owner_task_title: string | null;
    owner_task_owner: string | null;
    held_pattern: string;
    certain: boolean;
    reason: string;
  }>(
    `select path, owner_task_id, owner_task_title, owner_task_owner, held_pattern, certain, reason
       from unguarded_edit_conflicts
      where unguarded_edit_id = $1
      order by path, owner_task_id`,
    [unguardedEditId],
  );
  return result.rows.map((row) => ({
    path: row.path,
    ownerTaskId: row.owner_task_id,
    ownerTaskTitle: row.owner_task_title,
    ownerTaskOwner: row.owner_task_owner,
    heldPattern: row.held_pattern,
    certain: row.certain,
    reason: row.reason,
  }));
}

