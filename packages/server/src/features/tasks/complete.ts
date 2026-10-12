// `complete_task`: the coordination half, and a named seam where the git half
// will go.
//
// Ticket 017. The design's version "requires rebase onto current `main-dev`,
// pushes the branch, opens the PR, triggers CI" — **none of which exists
// before step 4**. So this file does the part step 2 can do, and the part it
// cannot is `gitDelivery()` below: a function that exists, is called on every
// completion, and says out loud that it did nothing. The alternative — leaving
// it out — is a tool that reports success while the work sits on a branch
// nobody pushed, which is the failure shape this repo keeps finding and
// naming.
//
// WHAT COMPLETION IS NOT: `done`. A dev calling `complete_task` moves the task
// to **ready for QA**, never `done` — the three test stages are the point, and
// `in_progress -> done` is not even in the transition table. That refusal is
// 012's; this file simply never asks for it.
import type { PoolClient } from "pg";
import type { TaskRecord } from "@office/shared/tasks";
import type { SessionRecord } from "@office/shared/sessions";
import type { TaskId } from "@office/shared/ids";
import { withTransaction } from "../../core/db/pool.ts";
import { releaseByTask } from "../locks/registry.ts";
import { getTask } from "./repo.ts";
import {
  ConcurrentTransitionError,
  announceTransition,
  transition,
  type TransitionResult,
} from "./states.ts";

export type CompleteRefusalKind =
  | "not_found"
  | "owner_mismatch"
  | "wrong_state"
  /** `summary` was absent, empty or whitespace. */
  | "summary_required"
  /** `learning` was absent, empty or whitespace. The design makes it mandatory. */
  | "learning_required";

export interface CompleteRefusal {
  readonly ok: false;
  readonly kind: CompleteRefusalKind;
  readonly message: string;
}

export interface CompleteSuccess {
  readonly ok: true;
  readonly task: TaskRecord;
  /** How many file locks the completion released. */
  readonly locksReleased: number;
  /** What the git half did. In step 2, nothing — and it says so. */
  readonly delivery: GitDeliveryOutcome;
}

export type CompleteResult = CompleteSuccess | CompleteRefusal;

export interface CompleteInput {
  readonly taskId: TaskId;
  /** The calling desk, proven by the transport. NOT a tool argument. */
  readonly session: SessionRecord;
  readonly summary?: string | null;
  readonly learning?: string | null;
}

// --- The git seam ---------------------------------------------------------------

export interface GitDeliveryOutcome {
  readonly implemented: boolean;
  /** Which build step owns the missing half. */
  readonly ownedByStep: number;
  /** Said to the agent verbatim, so it cannot believe its branch was pushed. */
  readonly message: string;
}

/**
 * Rebase onto `main-dev`, push the branch, open the PR, trigger CI.
 *
 * **Not implemented in step 2, deliberately and loudly.** Step 4 replaces this
 * body; until then every completion carries its message back to the agent, and
 * `complete_task`'s success text repeats it, because an agent that believes a
 * PR exists will report work as delivered that is sitting in a local branch.
 *
 * A test asserts this is reachable and that its message reaches the caller, so
 * step 4 cannot quietly ship without noticing the seam — the acceptance
 * criterion is "the seam is reachable", not "a comment mentions git".
 */
export function gitDelivery(task: TaskRecord): GitDeliveryOutcome {
  return {
    implemented: false,
    ownedByStep: 4,
    message:
      `The git half of completion is not implemented in step 2: nothing was rebased, pushed, or opened as a PR, and no CI was triggered${
        task.branch === null ? " (this task has no branch yet either — branch creation is step 4's)" : ` (branch ${task.branch} is untouched)`
      }. Your work is recorded as ready for QA and your file locks are released. Do not report it as delivered or merged.`,
  };
}

// --- Completion -----------------------------------------------------------------

const COMPLETABLE_FROM = "in_progress";

/**
 * A refusal, thrown rather than returned. Same reasoning as `ClaimRefused` in
 * ./claim.ts, and the same real bug on this side of it:
 * `withTransaction` commits what its callback RETURNS and rolls back only what
 * it THROWS, and a completion decides two of its refusals AFTER it has already
 * written — the learning entry stored, the locks released — if the transition
 * then loses a race.
 *
 * The case that makes it more than tidiness: a human pauses the task while a
 * completion is in flight. The transition is refused, correctly, but a
 * returned refusal would have committed the lock release — and a paused task
 * still owns its files, by 028's explicit rule. Throwing makes that impossible
 * rather than remembering to undo it.
 */
class CompleteRefused extends Error {
  constructor(readonly refusal: CompleteRefusal) {
    super(refusal.message);
    this.name = "CompleteRefused";
  }
}

function refuse(kind: CompleteRefusalKind, message: string): never {
  throw new CompleteRefused({ ok: false, kind, message });
}

/**
 * One completion, atomically: the learning entry, the lock release and the
 * transition commit together or not at all.
 *
 * Partial completion is the thing to avoid here. A release that committed
 * without the transition would free the files while the task still reads
 * `in_progress`, so another task could claim the same scope while this one
 * looks live; a transition without the release would move the card and keep
 * the files locked until the TTL expired, blocking the next task for an hour
 * for no reason anybody could see.
 */
export async function completeTask(input: CompleteInput): Promise<CompleteResult> {
  const summary = (input.summary ?? "").trim();
  const learning = (input.learning ?? "").trim();

  let outcome: { committed: TransitionResult; locksReleased: number };
  try {
    outcome = await withTransaction(
      async (
        client: PoolClient,
      ): Promise<{ committed: TransitionResult; locksReleased: number }> => {
        const task = await getTask(input.taskId, client);
        if (!task) {
          refuse(
            "not_found",
            `There is no task ${input.taskId}, so there is nothing to complete. Check the id against your task list.`,
          );
        }

        if (task.owner !== input.session.owner) {
          refuse(
            "owner_mismatch",
            `Task ${task.id} ("${task.title}") is owned by ${task.owner}, and this desk runs as ${input.session.owner}. Only the account that owns a task completes it — otherwise one agent closes another's work and the second agent carries on editing files the first just released.`,
          );
        }

        if (task.state !== COMPLETABLE_FROM) {
          refuse(
            "wrong_state",
            `Task ${task.id} is ${task.state}, and completion moves a task from ${COMPLETABLE_FROM}. ${
              task.state === "ready_for_qa"
                ? "It is already ready for QA — if you completed it a moment ago, it worked."
                : task.state === "pending"
                  ? "Claim it first: claim_task takes the file scope and the locks that make the ownership guard work."
                  : "Check the board before retrying."
            }`,
          );
        }

        // The two required arguments, checked in the order a caller supplies
        // them so a tool call missing both is told about the first.
        if (summary === "") {
          refuse(
            "summary_required",
            `complete_task needs a \`summary\`: what you actually did, in a few sentences, for the human who reviews this at the QA gate. It is the first thing they read and the only thing they have if your diff is large.`,
          );
        }

        if (learning === "") {
          // THE DESIGN IS EXPLICIT that a completion without a learning entry
          // is refused, and the reason is worth repeating to the agent rather
          // than enforcing silently: the entry is what makes the next task
          // cheaper, and an office that skips it relearns the same thing every
          // time.
          refuse(
            "learning_required",
            `complete_task needs a \`learning\`: one thing this task taught that the next one should not have to rediscover — a trap, a constraint, a decision and why, something the code does not say for itself. A completion without one is refused on purpose. "Nothing to report" is not a learning entry; if the task genuinely taught you nothing, say what you verified and why it was already known.`,
          );
        }

        // The interim home for the entry. Step 5 reads these into the knowledge
        // graph as facts sourced to the task and drops the column — see
        // db/migrations/0014_task_learning.sql, which says so in as many words
        // because it is a one-way door.
        await client.query("update tasks set learning = $2 where id = $1", [
          input.taskId,
          learning,
        ]);

        // Release before the transition, so the two cannot be observed out of
        // order by anything reading in between — there is nothing in between,
        // because this is one transaction.
        const locksReleased = await releaseByTask(input.taskId, client);

        // Same race as a claim's, from the other end: two completions of one
        // task, or a completion arriving while a human pauses it. A thrown
        // error here would tell the agent its tool is broken; what actually
        // happened is that the task moved.
        let committed: TransitionResult;
        try {
          committed = await transition(
            {
              taskId: input.taskId,
              to: "ready_for_qa",
              actor: input.session.owner,
              actorKind: "agent",
              reason: summary,
              expectedFrom: COMPLETABLE_FROM,
            },
            client,
          );
        } catch (error) {
          if (error instanceof ConcurrentTransitionError) {
            refuse(
              "wrong_state",
              `Task ${task.id} moved while this completion was being checked — it is ${error.actual} now, not ${COMPLETABLE_FROM}. Check the board before retrying; if a human paused or reassigned it, that is a decision you do not override.`,
            );
          }
          throw error;
        }

        return { committed, locksReleased };
      },
    );
  } catch (error) {
    // Rolled back already, which is the point: a refused completion has
    // released no locks and stored no learning entry. See CompleteRefused.
    if (error instanceof CompleteRefused) return error.refusal;
    throw error;
  }

  // After the commit, for the reason in announceTransition: an event emitted
  // inside the caller's transaction survives its ROLLBACK and announces a
  // change that never happened.
  await announceTransition(outcome.committed);

  return {
    ok: true,
    task: outcome.committed.task,
    locksReleased: outcome.locksReleased,
    delivery: gitDelivery(outcome.committed.task),
  };
}
