// File-scope lock vocabulary: what a scope is, what a lock row looks like,
// and what a refusal says.
//
// Shared because three consumers read it — the registry (015), `claim_task`
// (017) and the PreToolUse guard (020) — and later the Tasks page, which
// shows owned files on the card.
//
// No barrel re-export, matching ids.ts/events.ts/tasks.ts: import it as
// `@office/shared/locks`.

import type { ProjectId, TaskId } from "./ids.ts";

/**
 * A declared file scope: a list of patterns, each of which may be a literal
 * file, a directory prefix, or a glob.
 *
 * The design's two examples are a review-comment task owning one file and a
 * dev task owning a directory, so both shapes have to be expressible
 * without Management enumerating every path at planning time — see the
 * decision in docs/tasks/README.md.
 *
 * Patterns are repo-relative and POSIX-separated once normalised. The
 * normaliser in packages/server/src/features/locks/overlap.ts is the only
 * thing that decides what "the same path" means; a scope that has not been
 * through it must never be compared.
 */
export type FileScope = readonly string[];

/** One row of `file_locks`, camelCased. */
export interface FileLockRecord {
  readonly id: string;
  readonly projectId: ProjectId;
  readonly taskId: TaskId;
  /** The session holding it, when one is known. Null for a lock acquired
   * outside a session (a lead reserving scope during planning). Not a
   * foreign key — the sessions table is ticket 008's and does not exist
   * yet; see the migration's header for the ordering hazard that forces
   * this. */
  readonly sessionId: string | null;
  readonly pathPattern: string;
  readonly acquiredAt: Date;
  /** TTL backstop. A lock past this moment is reclaimable by the sweeper
   * unless it is paused. */
  readonly expiresAt: Date;
  /** Paused locks are exempt from TTL expiry and are not reclaimable: a
   * paused task still owns its files, and the whole point of Pause is that
   * the work resumes later on the same scope. */
  readonly paused: boolean;
  readonly releasedAt: Date | null;
}

/**
 * Why an acquisition was refused.
 *
 * `certain` is the load-bearing field. Glob-versus-glob disjointness is
 * undecidable in general, and the decision recorded in
 * docs/tasks/README.md is to resolve conservatively: when the algorithm
 * cannot *prove* two patterns disjoint it reports a conflict. A false
 * conflict serialises one task; a false clearance produces the git conflict
 * the registry exists to prevent. `certain: false` says the refusal was the
 * conservative branch rather than a demonstrated collision, so a human
 * reading it knows whether to argue with it.
 */
export interface ScopeConflict {
  /** The pattern the caller asked for. */
  readonly requested: string;
  /** The already-held pattern it collides with. */
  readonly heldPattern: string;
  readonly heldByTaskId: TaskId;
  readonly heldBySessionId: string | null;
  readonly certain: boolean;
  readonly reason: string;
}

export interface AcquireScopeSuccess {
  readonly ok: true;
  readonly locks: readonly FileLockRecord[];
}

export interface AcquireScopeFailure {
  readonly ok: false;
  /** Every collision found, not just the first: a scope of five files with
   * three conflicts should be fixable in one edit. */
  readonly conflicts: readonly ScopeConflict[];
}

export type AcquireScopeResult = AcquireScopeSuccess | AcquireScopeFailure;
