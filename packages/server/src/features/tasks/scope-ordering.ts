// Is an overlap between two tasks' file scopes safe?
//
// The rule, from docs/tasks/README.md: **overlap is allowed when a
// dependency orders it** — directly or transitively — because two tasks
// ordered by a dependency can never be active at the same time. Unordered
// overlap is refused, and the check re-runs on every later mutation of
// either scope or the dependency graph, since both can turn a safe overlap
// unsafe.
//
// Two layers, deliberately:
//
//   - `orderedOverlapProblems` is PURE. Scopes and edges in, problems out,
//     no database. Ticket 019 validates a whole draft batch that is not
//     stored yet, so the rule cannot live inside a query.
//   - `checkProjectScopeOrdering` is the database-backed caller, for the
//     mutation paths in this ticket's routes.
//
//
// WHERE A TASK'S SCOPE LIVES — an assumption, stated rather than buried
// ---------------------------------------------------------------------
// No table stores a task's *declared* file scope. `file_locks` (ticket 015)
// stores its *acquired* scope, keyed by task, and nothing in the ownership
// map gives any ticket a column for the declared one. This module therefore
// reads scope from `file_locks`, which is coherent — acquireScope does not
// check task state, so a task can hold its scope from draft onward — but it
// is an interpretation, not something the design states.
//
// The consequence to know: a task that has never acquired locks has an
// empty scope here and so can never conflict. Ticket 019, which produces
// draft batches with scopes before anything is claimed, is where this
// assumption either holds or has to be replaced with real storage. Recorded
// in this ticket's open questions.
import type { PoolClient } from "pg";
import type { ProjectId, TaskId } from "@office/shared/ids";
import { asTaskId } from "@office/shared/ids";
import { query } from "../../core/db/pool.ts";
import { findScopeOverlap } from "../locks/overlap.ts";
import { projectDependencyEdges } from "./dependencies.ts";

/** One task's scope, as this module reasons about it. */
export interface TaskScope {
  readonly taskId: TaskId;
  /** Already normalised — these come from file_locks, which stores
   * normalised patterns by construction. */
  readonly patterns: readonly string[];
}

export interface DependencyEdge {
  readonly taskId: TaskId;
  readonly blockedByTaskId: TaskId;
}

export interface ScopeOrderingProblem {
  readonly taskA: TaskId;
  readonly taskB: TaskId;
  readonly patternA: string;
  readonly patternB: string;
  /** False when the overlap itself was a conservative verdict rather than a
   * demonstrated collision — carried through from the overlap rule so a
   * refusal never overstates its certainty. */
  readonly certain: boolean;
  readonly detail: string;
}

/**
 * Transitive reachability over the blocked-by relation, computed once for
 * the whole edge set.
 *
 * Floyd–Warshall-ish closure by repeated relaxation rather than a walk per
 * pair: the caller is checking every overlapping pair on a board, and
 * re-walking the graph for each would be quadratic in queries as well as in
 * pairs.
 */
function reachability(edges: readonly DependencyEdge[]): Map<string, Set<string>> {
  const blockers = new Map<string, Set<string>>();
  for (const edge of edges) {
    const set = blockers.get(edge.taskId) ?? new Set<string>();
    set.add(edge.blockedByTaskId);
    blockers.set(edge.taskId, set);
  }

  // Expand until nothing new appears. The graph is acyclic (addDependency
  // refuses cycles), so this terminates.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [task, direct] of blockers) {
      for (const blocker of [...direct]) {
        for (const indirect of blockers.get(blocker) ?? []) {
          if (!direct.has(indirect)) {
            direct.add(indirect);
            changed = true;
          }
        }
      }
      blockers.set(task, direct);
    }
  }
  return blockers;
}

/** Does a dependency order these two, in either direction? */
function ordered(a: TaskId, b: TaskId, blockers: Map<string, Set<string>>): boolean {
  return Boolean(blockers.get(a)?.has(b)) || Boolean(blockers.get(b)?.has(a));
}

/**
 * Every overlapping pair that no dependency orders.
 *
 * Pure. An empty result means every overlap present is safely serialised.
 */
export function orderedOverlapProblems(
  scopes: readonly TaskScope[],
  edges: readonly DependencyEdge[],
): ScopeOrderingProblem[] {
  const blockers = reachability(edges);
  const problems: ScopeOrderingProblem[] = [];

  for (let i = 0; i < scopes.length; i += 1) {
    for (let j = i + 1; j < scopes.length; j += 1) {
      const a = scopes[i]!;
      const b = scopes[j]!;
      const clash = findScopeOverlap(a.patterns, b.patterns);
      if (!clash) continue;
      if (ordered(a.taskId, b.taskId, blockers)) continue;

      problems.push({
        taskA: a.taskId,
        taskB: b.taskId,
        patternA: clash.left,
        patternB: clash.right,
        certain: clash.verdict.certain,
        detail:
          `${a.taskId} (${clash.left}) and ${b.taskId} (${clash.right}) overlap with no ` +
          `dependency ordering them, so both could be active at once — ${clash.verdict.reason}`,
      });
    }
  }
  return problems;
}

// --- Database-backed -----------------------------------------------------------------

/**
 * Scopes of a project's not-yet-done tasks, read from the lock registry.
 *
 * `done` tasks are excluded: they cannot become active again, so an overlap
 * with one orders nothing and refusing it would serialise work against
 * history. Released locks are excluded for the same reason.
 */
export async function projectScopes(
  projectId: ProjectId,
  client?: PoolClient,
): Promise<TaskScope[]> {
  const sql = `select l.task_id, array_agg(l.path_pattern order by l.path_pattern) as patterns
                 from file_locks l
                 join tasks t on t.id = l.task_id
                where l.project_id = $1
                  and l.released_at is null
                  and t.state <> 'done'
                group by l.task_id`;
  const result = client
    ? await client.query<{ task_id: string; patterns: string[] }>(sql, [projectId])
    : await query<{ task_id: string; patterns: string[] }>(sql, [projectId]);
  return result.rows.map((row) => ({
    taskId: asTaskId(row.task_id),
    patterns: row.patterns,
  }));
}

export interface ScopeOrderingOptions {
  /** Pretend this edge is gone — used to answer "may I remove this
   * dependency?" before actually removing it. */
  readonly withoutEdge?: DependencyEdge;
  /** Pretend this task has this scope instead — used to answer "may I widen
   * this scope?" before writing it. */
  readonly withScope?: TaskScope;
}

/**
 * The whole project's ordering, optionally under a hypothetical change.
 *
 * Answering "would this be legal?" *before* applying it is the point: both
 * mutation paths this ticket owns (removing an edge, editing a scope) have
 * to refuse rather than apply-then-discover.
 */
export async function checkProjectScopeOrdering(
  projectId: ProjectId,
  options: ScopeOrderingOptions = {},
  client?: PoolClient,
): Promise<ScopeOrderingProblem[]> {
  let scopes = await projectScopes(projectId, client);
  let edges = await projectDependencyEdges(projectId, client);

  if (options.withoutEdge) {
    const { taskId, blockedByTaskId } = options.withoutEdge;
    edges = edges.filter(
      (edge) => !(edge.taskId === taskId && edge.blockedByTaskId === blockedByTaskId),
    );
  }

  if (options.withScope) {
    const replacement = options.withScope;
    scopes = scopes.filter((scope) => scope.taskId !== replacement.taskId);
    if (replacement.patterns.length > 0) scopes.push(replacement);
  }

  return orderedOverlapProblems(scopes, edges);
}
