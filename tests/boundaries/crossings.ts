// The crossings list: every non-serialisable value allowed across a service
// boundary, and the ticket that justifies it.
//
// Ticket 033. Serialisable values — ids, records, refusals — cross freely.
// Anything that only means something inside one process does not, with the
// enumerated exceptions below.
//
// WHY THIS LIST EXISTS AT ALL. 033's import rule stops a *deep import*. It
// does not stop a contract from growing a method that takes a live pool
// client or a Fastify instance, and six months of those leaves every
// boundary formally intact while nothing can actually be moved. Nobody
// notices, because nothing fails — until somebody tries. So the values that
// may cross are written down, and a new one needs a ticket rather than a
// convenient signature.
//
// THE LIST MAY ONLY SHRINK, like the baseline. A fifth entry appearing
// without a ticket is the failure this file is here to catch.

/** Types that mean nothing outside the process that made them. */
export const NON_SERIALISABLE_TYPES: readonly string[] = [
  "PoolClient",
  "Pool",
  "FastifyInstance",
  "FastifyRequest",
  "FastifyReply",
  "WebSocket",
  "Socket",
  "Server",
  "AbortSignal",
  "EventEmitter",
];

export interface Crossing {
  /** The calling service. */
  readonly from: string;
  /** The services it reaches, in one transaction. */
  readonly to: readonly string[];
  /** The type that crosses. */
  readonly type: string;
  /** Where it happens, so a reader can go and look. */
  readonly site: string;
  /** The ticket that owns it. */
  readonly ticket: string;
  /** What breaks if this is split apart. One sentence, from the source. */
  readonly because: string;
}

/**
 * Four transactions span two services. This was established on 2026-10-12 by
 * counting them rather than recalling them — the boundaries design had
 * credited `claim_task` with being the only one, and it is not.
 *
 * The two `control` rows are why ticket 040 cannot move the control service
 * until 028 splits pause and resume along the line between "kill the agent"
 * and "move the task and mark its locks".
 */
export const CROSSINGS: readonly Crossing[] = [
  {
    from: "tasks",
    to: ["locks"],
    type: "PoolClient",
    site: "packages/server/src/features/tasks/claim.ts",
    ticket: "017",
    because:
      "A claim that fails at lock acquisition would leave a task in_progress that no agent is working on — invisible to every \"what can I claim\" query, so the work silently stops being available to anyone.",
  },
  {
    from: "tasks",
    to: ["locks"],
    type: "PoolClient",
    site: "packages/server/src/features/tasks/complete.ts",
    ticket: "017",
    because:
      "A completion that fails after releasing would leave a task holding file scope nobody owns, blocking the next claim for a full TTL for a reason no log explains.",
  },
  {
    from: "control",
    to: ["tasks", "locks"],
    type: "PoolClient",
    site: "packages/server/src/features/orchestrator/pause.ts",
    ticket: "028",
    because:
      "A paused task whose locks were never marked paused has its files swept out from under it while the work waits.",
  },
  {
    from: "control",
    to: ["tasks", "locks"],
    type: "PoolClient",
    site: "packages/server/src/features/orchestrator/resume.ts",
    ticket: "028",
    because:
      "resume.ts's own words: a paused lock's TTL has almost certainly expired while the work was paused, so clearing paused without restarting the clock hands the sweeper a live-but-expired lock and the task loses the files it was resumed to work on.",
  },
];
