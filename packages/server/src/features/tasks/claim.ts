// `claim_task`: the three checks, one transaction.
//
// Ticket 017. "checks owner match, dependency state, and file-scope overlap,
// then locks."
//
// WHAT MAKES THIS THE INTERESTING FILE IN STEP 2: every refusal it returns is
// a prompt the model has to act on. An agent told *"src/app.ts is held by
// task 7b3…, owned by agent2"* can wait, order the two with a dependency, or
// take it to its lead. An agent told *"claim failed"* retries, and the
// refusal becomes a loop that burns tokens until a human notices. So each
// refusal below names what blocked it AND who owns the conflict, and reads as
// an instruction rather than a status line (spike 003 §4).
//
// IDENTITY IS NOT AN ARGUMENT. The owner check compares the task's owner with
// the authenticated session's, and `ClaimInput` has no field for either. An
// agent that passes `{"task_id":"…","owner":"agent2"}` changes nothing: the
// argument is not read, which is the property spike 003 set out to establish
// and the reason the office mints a per-session token at all (GLU-55).
//
// ATOMICITY, and why it is not merely tidy: without one transaction, a claim
// that fails at lock acquisition leaves a task `in_progress` that no agent is
// working on — a task in that state is invisible to every "what can I claim"
// query, so the work silently stops being available to anyone. One
// transaction means the failure leaves the task exactly as it was.
import type { PoolClient } from "pg";
import type { ScopeConflict } from "@office/shared/locks";
import type { TaskRecord } from "@office/shared/tasks";
import type { SessionRecord } from "@office/shared/sessions";
import type { TaskId } from "@office/shared/ids";
import { withTransaction } from "../../core/db/pool.ts";
import { acquireScope } from "../locks/registry.ts";
import { isClaimable } from "./dependencies.ts";
import { getTask } from "./repo.ts";
import {
  ConcurrentTransitionError,
  announceTransition,
  transition,
  type TransitionResult,
} from "./states.ts";

export type ClaimRefusalKind =
  /** No task with that id. */
  | "not_found"
  /** The task belongs to another agent account. */
  | "owner_mismatch"
  /** The task is not in a state a claim can move. */
  | "wrong_state"
  /** A dependency has not reached `delivered`. */
  | "blocked_by_dependency"
  /** Another live task holds one of the requested patterns. */
  | "scope_conflict"
  /** No file scope to lock — see `SCOPE_IS_REQUIRED_UNTIL_019`. */
  | "scope_required";

export interface ClaimRefusal {
  readonly ok: false;
  readonly kind: ClaimRefusalKind;
  /** Written for the model. Names the blocker and its owner, and says what to
   * do next. Never a code, never "denied". */
  readonly message: string;
  /** Populated for `scope_conflict`, so a UI can show both sides. */
  readonly conflicts?: readonly ScopeConflict[];
  /** Populated for `blocked_by_dependency`. */
  readonly blockedBy?: readonly TaskId[];
}

export interface ClaimSuccess {
  readonly ok: true;
  readonly task: TaskRecord;
  /** The patterns this task now holds. */
  readonly scope: readonly string[];
}

export type ClaimResult = ClaimSuccess | ClaimRefusal;

export interface ClaimInput {
  readonly taskId: TaskId;
  /** The calling desk, proven by the transport. NOT a tool argument. */
  readonly session: SessionRecord;
  /**
   * The files this task will edit.
   *
   * SCOPE_IS_REQUIRED_UNTIL_019, and this is an assumption stated rather than
   * a decision taken quietly. The design's signature is `claim_task(task_id)`
   * and says a task *has* a declared file scope — but **nothing stores one**:
   * 014 deliberately deferred `tasks.file_scope` to 019, and 014's
   * scope-ordering reads *acquired* scope from `file_locks`. So at claim time
   * there is no declared scope to read, and the only caller who knows the
   * answer is the agent.
   *
   * The two alternatives were worse. Claiming with no scope acquires no
   * locks, which makes 020's PreToolUse guard inert for that task — the guard
   * only refuses edits to files *another* task holds — so two agents would
   * edit the same file with the registry reporting no conflict, which is the
   * exact failure the registry exists to prevent. Inventing a default scope
   * (the whole repo, say) serialises the office.
   *
   * So: optional in the signature, refused when absent, with a message that
   * says what to pass. When 019 stores a declared scope, `claim_task` reads
   * it and this argument becomes a narrowing rather than a requirement — the
   * refusal is the seam that will be deleted, not a shape to build on.
   */
  readonly scope?: readonly string[];
  /** Overrides LOCK_TTL_SECONDS. For tests, like `acquireScope`'s. */
  readonly ttlSeconds?: number;
}

/** The state a claim moves a task out of. */
const CLAIMABLE_FROM = "pending";

/**
 * A refusal, thrown rather than returned — and this is the fix to a real bug
 * rather than a style choice.
 *
 * `withTransaction` commits whatever its callback RETURNS and rolls back only
 * what it THROWS. A refusal decided after something has already been written
 * — the scope acquired, and then the transition refused because another desk
 * won the race — therefore used to commit the locks of a claim that failed.
 * The task stayed `pending`, correctly, while holding a scope nobody owned,
 * which blocks the next claim for a full TTL for a reason no log explains.
 *
 * Found by the concurrency test for two claims declaring DIFFERENT scopes:
 * those never collide inside `acquireScope`'s advisory lock, so both reach
 * the transition and the loser is refused with its inserts already made. The
 * same-scope race never showed it, because there the refusal happens before
 * any write.
 *
 * Throwing is what makes "a failure leaves no locks held" true by
 * construction instead of by remembering to undo each write.
 */
class ClaimRefused extends Error {
  constructor(readonly refusal: ClaimRefusal) {
    super(refusal.message);
    this.name = "ClaimRefused";
  }
}

function refuse(
  kind: ClaimRefusalKind,
  message: string,
  extra: Partial<ClaimRefusal> = {},
): never {
  throw new ClaimRefused({ ok: false, kind, message, ...extra });
}

/**
 * One claim, atomically.
 *
 * The order of the checks is deliberate and is cheapest-and-most-decisive
 * first: a task that is not yours stays not yours however its dependencies
 * look, and saying so before mentioning locks keeps the refusal to one
 * actionable sentence instead of three.
 */
export async function claimTask(input: ClaimInput): Promise<ClaimResult> {
  const scope = (input.scope ?? []).filter((pattern) => pattern.trim() !== "");

  let outcome: { committed: TransitionResult; scope: string[] };
  try {
    outcome = await withTransaction(async (client: PoolClient) => {
      const task = await getTask(input.taskId, client);
      if (!task) {
        refuse(
          "not_found",
          `There is no task ${input.taskId}. Check the id against your task list — a task that was deleted while you were working is a thing that happens, and the board is the source of truth.`,
        );
      }

      // 1. OWNER MATCH. From the transport, never from an argument.
      if (task.owner !== input.session.owner) {
        refuse(
          "owner_mismatch",
          `Task ${task.id} ("${task.title}") is owned by ${task.owner}, and this desk runs as ${input.session.owner}. You claim only tasks owned by this account. Ask your lead to reassign it if it should be yours — moving work between owners is a decision for a human or a lead, not something a claim can do.`,
        );
      }

      // 2. STATE. Before dependencies, because "already in progress" is the
      //    common case when an agent retries, and it needs its own answer
      //    rather than a dependency list it cannot act on.
      if (task.state !== CLAIMABLE_FROM) {
        const extra =
          task.state === "in_progress"
            ? " It is already in progress — if that was you, carry on; if it was not, something else is working on it and claiming again would be a second agent in one file scope."
            : task.state === "paused"
              ? " It is paused. A human resumes it; resuming one task under an office-wide pause is refused on purpose."
              : "";
        refuse(
          "wrong_state",
          `Task ${task.id} is ${task.state}, and a claim moves a task from ${CLAIMABLE_FROM}.${extra}`,
        );
      }

      // 3. DEPENDENCIES. Direct only, which is not a shortcut: an undelivered
      //    transitive blocker necessarily leaves its direct blocker
      //    undelivered too.
      const claimability = await isClaimable(input.taskId, client);
      if (!claimability.claimable) {
        refuse(
          "blocked_by_dependency",
          `Task ${task.id} is blocked by ${claimability.blockedBy.length === 1 ? "a dependency that has" : "dependencies that have"} not been delivered yet: ${claimability.blockedBy.join(", ")}. Dependents unblock at **delivered** — the point the code exists in the shared branch — not when a task is finally closed, so this is the machinery working rather than something to retry. Pick another task or ask your lead whether the ordering is right.`,
          { blockedBy: claimability.blockedBy },
        );
      }

      // 4. SCOPE. See SCOPE_IS_REQUIRED_UNTIL_019 on ClaimInput.
      if (scope.length === 0) {
        refuse(
          "scope_required",
          `Task ${task.id} cannot be claimed without a file scope. Pass \`file_scope\` as the list of paths or path prefixes this task will edit — for example ["packages/server/src/features/tasks/claim.ts", "db/migrations/"]. Declaring it is what makes the ownership guard able to refuse somebody else's edit to your files, so a claim with no scope would leave both of you editing the same file with nothing noticing. Declare wider than you need rather than narrower: over-declaring serialises work, under-declaring produces the git conflict the registry exists to prevent.`,
        );
      }

      const acquired = await acquireScope(
        {
          projectId: task.projectId,
          taskId: input.taskId,
          sessionId: input.session.id,
          patterns: scope,
          ...(input.ttlSeconds === undefined ? {} : { ttlSeconds: input.ttlSeconds }),
        },
        client,
      );
      if (!acquired.ok) {
        // Every collision, not just the first — a scope of five files with two
        // conflicts should produce one refusal naming both, so the agent can
        // decide once.
        const lines = acquired.conflicts.map(
          (conflict) =>
            `  • ${conflict.requested} overlaps ${conflict.heldPattern}, held by task ${conflict.heldByTaskId}${
              conflict.certain ? "" : " (possible overlap, not certain — resolved conservatively)"
            }`,
        );
        refuse(
          "scope_conflict",
          `Task ${task.id} cannot take its file scope: another active task already holds ${acquired.conflicts.length === 1 ? "part of it" : "parts of it"}.\n${lines.join("\n")}\nA refused scope is information, not an obstacle: it means another task is live in those files. Wait for it, order the two with a dependency, or take it to your lead. Do not narrow your declared scope to get around this — that produces the conflict the registry exists to prevent.`,
          { conflicts: acquired.conflicts },
        );
      }

      // 5. The transition, with the caller's client so the whole claim is one
      //    unit. `transition()` deliberately does not emit on this path — an
      //    event emitted inside a transaction survives its ROLLBACK — so the
      //    announcement happens after the commit, below.
      //
      //    `expectedFrom` closes the window between step 2's read and here.
      //    Two desks claiming the same task with the SAME scope collide at the
      //    advisory lock inside `acquireScope` and the loser gets
      //    `scope_conflict`; two claiming it with DIFFERENT scopes do not
      //    collide there at all, and the loser arrives here with a task that
      //    is already `in_progress`. Without this, the second claim would
      //    apply a second `pending -> in_progress` edge — two desks each
      //    believing they own the task, each holding part of its files, which
      //    is the exact outcome the registry exists to prevent.
      let committed: TransitionResult;
      try {
        committed = await transition(
          {
            taskId: input.taskId,
            to: "in_progress",
            actor: input.session.owner,
            actorKind: "agent",
            expectedFrom: CLAIMABLE_FROM,
          },
          client,
        );
      } catch (error) {
        if (error instanceof ConcurrentTransitionError) {
          // A refusal, not a thrown error: a race the agent lost is an ordinary
          // outcome in an office with several desks per account, and surfacing
          // it as an internal failure would tell the model its tool is broken
          // rather than that somebody else got there first.
          refuse(
            "wrong_state",
            `Task ${task.id} was claimed by another desk while this claim was being checked — it is ${error.actual} now, not ${CLAIMABLE_FROM}. Nothing of yours was left behind: your file scope was not taken. Pick another task.`,
          );
        }
        throw error;
      }

      return { committed, scope: acquired.locks.map((lock) => lock.pathPattern) };
    });
  } catch (error) {
    // The transaction has already rolled back by the time this runs — that is
    // the whole point of throwing. See ClaimRefused.
    if (error instanceof ClaimRefused) return error.refusal;
    throw error;
  }

  // THE INHERITED REQUIREMENT (017's "Inherited requirement" section). Without
  // this the board does not move the card when an agent claims work, and the
  // whole point of the Lobby is that a human can see what is happening.
  await announceTransition(outcome.committed);

  return { ok: true, task: outcome.committed.task, scope: outcome.scope };
}
