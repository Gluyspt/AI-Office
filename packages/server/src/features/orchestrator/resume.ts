// Resume: one task, or every paused task in a project.
//
// Ticket 028. "Both keep locks and move tasks to `paused`, so a single
// Resume recovers every kind of interruption." That sentence is the whole
// specification of this file, and it is a stronger claim than it looks:
// manual pause, a crashed agent, a tripped circuit breaker and a rate-limit
// backoff all land a task in exactly one state — `paused`, with its locks
// kept and marked, and a history row saying what interrupted it. So Resume
// does not need to know which of the four happened. There is one recovery
// path because there is one resting state, and that is a property of ticket
// 012's state machine rather than of this code.
//
// Four properties this file exists to hold.
//
//  1. **A task returns to the state it was paused FROM, and nowhere else.**
//     Ticket 012's guard, read through `pausedOriginState` rather than
//     reimplemented: without it `paused` would be a wormhole from any state
//     to any other — pause an in-progress task, resume it into `delivered`.
//
//  2. **Unpausing a lock and restarting its TTL happen in ONE transaction.**
//     This is the subtle one. A paused lock is exempt from expiry (015), so
//     its `expires_at` is almost certainly in the past by the time anyone
//     resumes — a pause lasts minutes or days, the TTL is minutes. Clearing
//     `paused` without pushing the deadline out hands the sweeper a lock
//     that is simultaneously live and expired, and the task silently loses
//     the files it was resumed to keep working on. The symptom would be a
//     git conflict days later, not an error now.
//
//  3. **Idempotent, and safe to retry after a partial failure.** Every step
//     is a no-op when it has already happened: a task that is not `paused`
//     is skipped, a lift of an already-lifted pause finds nothing, and a
//     respawn whose desk is already live is reported as `already_running`
//     rather than starting a second agent. A project half-resumed and then
//     resumed again ends fully resumed with no duplicate sessions.
//
//  4. **Nothing is restored that does not exist.** The handoff node is build
//     step 5. Resume respawns with the task brief *and a sentence saying no
//     handoff was restored*, which is the honest version of the design's
//     "Full context" and the thing ticket 029 must show.
//
// WHAT RESUME DOES NOT DECIDE: where an agent's working directory and Claude
// binary come from. Nothing persists them — 008 takes `cwd` and `claudeBin`
// as arguments and stores neither, and `projects` has a `repo_url` but no
// checkout path. PROJECT_ROOT in .env.example documents "one subdirectory
// per project, that agent sessions are spawned inside", so that plus the
// project slug is the assumption this file proceeds under, overridable per
// call and reported out loud when it is unconfigured. Spawn policy proper is
// ticket 018's and 019's.
import path from "node:path";
import type { PoolClient } from "pg";
import {
  HANDOFF_UNAVAILABLE_NOTICE,
  WIP_COMMIT_UNVERIFIED_NOTICE,
  type PauseRecord,
  type RespawnOutcome,
  type RespawnSkipReason,
  type ResumeResult,
  type ResumeSkipReason,
  type ResumeTaskOutcome,
} from "@office/shared/control";
import { asSessionId, asTaskId, type ProjectId, type SessionId, type TaskId } from "@office/shared/ids";
import {
  isSessionBackend,
  isSessionRole,
  type SessionBackend,
  type SessionRole,
} from "@office/shared/sessions";
import type { TaskActorKind, TaskRecord, TaskState } from "@office/shared/tasks";
import { ConfigError, loadResumeSpawnConfig } from "../../core/config.ts";
import { query, withTransaction } from "../../core/db/pool.ts";
import { recordSystemEvent } from "../events/ingest.ts";
import { heartbeat, setLocksPaused } from "../locks/registry.ts";
import { isClaimable } from "../tasks/dependencies.ts";
import {
  TASK_COLUMNS,
  TaskTransitionError,
  type TaskRow,
  announceTransition,
  pausedOriginState,
  taskRowToRecord,
  transition,
} from "../tasks/states.ts";
import {
  ControlError,
  activePauseFor,
  isPauseRefusal,
  liftPausesFor,
} from "./pause.ts";
import { SessionError, listSessions, startSession } from "./sessions.ts";

// --- What "an agent was working on this" means ----------------------------------

/**
 * The only pause origin that means a desk was actively working the task, and
 * therefore the only one that respawns an agent.
 *
 * A task paused from `ready_for_qa`, `ci`, `qa_review`, `lead_approval` or
 * `delivered` was sitting in a pipeline stage with nobody on it; restoring it
 * restores a queue position, not a worker. A task paused from `pending` had
 * not been claimed yet. Spawning an agent for any of those would invent work
 * the pause never interrupted.
 */
const AGENT_WORK_STATES: readonly TaskState[] = ["in_progress"];

/**
 * THE DEPENDENCY RULE, and the reading behind it.
 *
 * The criterion is "a task whose dependency is still paused does not start",
 * via ticket 014. The question it leaves open is what "start" means for a
 * task that was paused from a state other than `in_progress`.
 *
 * ASSUMPTION, stated rather than quietly picked: the gate applies where
 * resuming would actually put an agent to work — `in_progress` — and nowhere
 * else. Returning a task to `pending` while its blocker is undelivered does
 * not start anything: nothing spawns for a pending task, and ticket 017's
 * `claim_task` already refuses to claim one whose dependencies are not
 * satisfied. `pending` plus an unsatisfied blocker is a state the board
 * already renders (014's blocked banner), so restoring it is *more* accurate
 * than leaving the card in `paused`.
 *
 * Gating every origin was the first version and it was worse in a way worth
 * recording: it made a project-wide resume order-dependent. A `pending` task
 * B blocked by a `delivered`-but-paused task A would be resumed if A happened
 * to be processed first and skipped if it did not, so the same Resume pressed
 * twice gave different boards. The ordering below mitigates that for the
 * `in_progress` case; narrowing the gate removes it for the rest.
 */
function needsDependencyCheck(origin: TaskState): boolean {
  return origin === "in_progress";
}

// --- Input ----------------------------------------------------------------------

/** Where to spawn a resumed agent. See the note at the top of this file for
 * why this is an argument rather than something read out of a row. */
export interface ResumeSpawnTarget {
  readonly cwd: string;
  readonly claudeBin: string;
  /**
   * Pane environment. `NODE_EXTRA_CA_CERTS` belongs here (ticket 009 decides
   * the contents), and leaving it out is not silently broken: a desk whose
   * hooks cannot complete a TLS handshake never reaches `running`, so 008's
   * hook gate marks the row `failed` and kills the pane rather than leaving
   * an invisible agent spending tokens. Resume reports that as
   * `spawn_failed` with 008's reason attached.
   */
  readonly env?: Readonly<Record<string, string>>;
}

export interface ResumeInput {
  /** The project to resume, or null/undefined with no `taskId` for the whole
   * office. Ignored when `taskId` is given. */
  readonly projectId?: ProjectId | null;
  /** Resume exactly one task. */
  readonly taskId?: TaskId | null;
  /** Who pressed it. Recorded, never checked. */
  readonly requestedBy: string;
  /** Default true. False recovers task state and locks without starting any
   * agent — useful when the host is under memory pressure and the operator
   * wants the board back before the desks. */
  readonly respawn?: boolean;
  readonly spawn?: ResumeSpawnTarget;
  /** Defaults to `human`; a crash-recovery caller passes `system`. */
  readonly requestedByKind?: TaskActorKind;
}

export const RESUME_NOTICES: readonly string[] = [
  HANDOFF_UNAVAILABLE_NOTICE,
  WIP_COMMIT_UNVERIFIED_NOTICE,
];

// --- Events ---------------------------------------------------------------------

/** After the commit, never inside it, and always with the project as a
 * COLUMN — ticket 006's bus filters subscriptions on `events.project_id`, so
 * an event without it reaches no board. Same rule as pause.ts. */
async function announce(
  type: string,
  projectId: ProjectId | string | null,
  payload: Record<string, unknown>,
): Promise<void> {
  await recordSystemEvent(type, payload, null, projectId);
}

// --- Finding the desk that was working a task -----------------------------------

interface PriorDesk {
  readonly sessionId: SessionId;
  readonly role: string;
  readonly dept: string;
  readonly owner: string;
  readonly backend: string;
  readonly model: string;
  readonly handoffRef: string | null;
  readonly projectSlug: string;
}

/**
 * The desk that was last working this task.
 *
 * `file_locks.session_id` is the ONLY link between a task and a session in
 * the schema: `sessions` (0003) carries no task reference, because when that
 * migration was written `tasks` might not have existed yet on a fresh
 * database — see its ordering-hazard header. So the registry of who held the
 * files doubles as the registry of who was at the desk.
 *
 * Released locks count. A task that reached `paused` from a later pipeline
 * stage may have let its files go, and the identity of the desk that did the
 * work is still the right one to recreate.
 */
async function priorDeskFor(taskId: TaskId): Promise<PriorDesk | null> {
  const { rows } = await query<{
    id: string;
    role: string;
    dept: string;
    owner: string;
    backend: string;
    model: string;
    handoff_ref: string | null;
    slug: string;
  }>(
    `select s.id, s.role, s.dept, s.owner, s.backend, s.model, s.handoff_ref, p.slug
       from file_locks l
       join sessions s on s.id = l.session_id
       join projects p on p.id = s.project_id
      where l.task_id = $1 and l.session_id is not null
      order by l.acquired_at desc, l.id desc
      limit 1`,
    [taskId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    sessionId: asSessionId(row.id),
    role: row.role,
    dept: row.dept,
    owner: row.owner,
    backend: row.backend,
    model: row.model,
    handoffRef: row.handoff_ref,
    projectSlug: row.slug,
  };
}

// --- The brief a resumed agent receives -----------------------------------------

/**
 * What the respawned desk is told.
 *
 * The handoff sentence is not decoration. An agent handed a task brief with
 * no explanation will reasonably assume it is starting fresh, start again
 * from the top, and redo or undo whatever the killed desk had half-finished.
 * Saying "this task is partly done and you cannot see what was done" is the
 * only honest instruction available until build step 5, and it is also the
 * one that produces the least damage.
 *
 * Length: ticket 007 measured tmux refusing a `send-keys` whose whole command
 * exceeds ~16.3 KB, so a very long brief is refused loudly by the adapter
 * rather than truncated. Nothing is trimmed here; a refusal surfaces as a
 * `spawn_failed` outcome with the adapter's own message.
 */
export function resumeBrief(task: TaskRecord, handoffRef: string | null): string {
  const lines = [
    `You are resuming task ${task.id} after a pause: "${task.title}".`,
    "",
    task.brief === "" ? "(The task has no written brief.)" : task.brief,
    "",
    "--",
  ];
  if (handoffRef === null) {
    lines.push(HANDOFF_UNAVAILABLE_NOTICE);
  } else {
    // Unreachable until build step 5. Written this way so the step that fills
    // the seam changes `requestHandoffNode` and this line, and nothing else.
    lines.push(`A handoff was restored: ${handoffRef}`);
  }
  lines.push(
    "",
    "Check the current state of the files in your scope before changing anything — some of " +
      "the work may already be done, and some may be half done.",
  );
  return lines.join("\n");
}

// --- Respawn --------------------------------------------------------------------

function respawnSkip(
  reason: RespawnSkipReason,
  detail: string | null = null,
  sessionId: SessionId | null = null,
): RespawnOutcome {
  return { spawned: false, sessionId, reason, detail };
}

/**
 * Where to spawn, when the caller did not say.
 *
 * `PROJECT_ROOT/<project slug>` is the assumption, and it is the one
 * .env.example already documents: "the directory holding checked-out managed
 * project repos, one subdirectory per project, that agent sessions are
 * spawned inside". A missing PROJECT_ROOT or CLAUDE_BIN is reported as
 * `no_spawn_target` on the task's outcome rather than throwing, because the
 * state-machine half of a resume — task back in its origin state, locks
 * unpaused, TTL restarted — is the half that must not be blocked by a
 * configuration gap in the half that spawns processes.
 */
function configuredSpawnTarget(
  projectSlug: string,
): { readonly target: ResumeSpawnTarget } | { readonly error: string } {
  try {
    const config = loadResumeSpawnConfig();
    return {
      target: {
        // posix: the agent host is Linux, and this path is handed to
        // `tmux new-session -c` there, not resolved on whatever platform the
        // orchestrator happens to be developed on.
        cwd: path.posix.join(config.projectRoot, projectSlug),
        claudeBin: config.claudeBin,
      },
    };
  } catch (error) {
    if (error instanceof ConfigError) return { error: error.message };
    throw error;
  }
}

async function respawnFor(
  task: TaskRecord,
  origin: TaskState,
  input: ResumeInput,
): Promise<RespawnOutcome> {
  if (!AGENT_WORK_STATES.includes(origin)) {
    return respawnSkip(
      "not_a_work_state",
      `the task was paused from ${origin}, where no agent was working on it`,
    );
  }
  if (input.respawn === false) return respawnSkip("not_requested");

  const prior = await priorDeskFor(task.id);
  if (!prior) {
    return respawnSkip(
      "no_prior_session",
      "nothing records which desk was working this task (no file lock carries a session id), " +
        "so there is no desk identity to recreate. Resume does not invent one.",
    );
  }
  if (!isSessionRole(prior.role) || !isSessionBackend(prior.backend)) {
    return respawnSkip(
      "spawn_failed",
      `the previous desk's role (${prior.role}) or backend (${prior.backend}) is not a value this build understands`,
      prior.sessionId,
    );
  }

  // Already running? This is the half-resumed-then-retried case, and the
  // reason it is checked here as well as being enforced by 008's partial
  // unique index: the index would make the second resume *fail*, and a retry
  // that reports a conflict is indistinguishable to an operator from a retry
  // that broke something.
  const live = await listSessions({ projectId: task.projectId, liveOnly: true });
  const existing = live.find(
    (session) =>
      session.role === prior.role && session.dept === prior.dept && session.owner === prior.owner,
  );
  if (existing) {
    return respawnSkip(
      "already_running",
      `${existing.tmuxName} is already live for this role; no second desk was started`,
      existing.id,
    );
  }

  const resolved = input.spawn
    ? { target: input.spawn }
    : configuredSpawnTarget(prior.projectSlug);
  if ("error" in resolved) {
    return respawnSkip(
      "no_spawn_target",
      `no working directory or Claude binary is configured, and the caller supplied none, so no agent was started: ${resolved.error}`,
    );
  }

  try {
    const result = await startSession({
      projectId: task.projectId,
      projectSlug: prior.projectSlug,
      role: prior.role as SessionRole,
      dept: prior.dept,
      owner: prior.owner,
      backend: prior.backend as SessionBackend,
      model: prior.model,
      modelReason: `resumed after a pause with the same model the previous desk ran (task ${task.id})`,
      brief: resumeBrief(task, prior.handoffRef),
      cwd: resolved.target.cwd,
      claudeBin: resolved.target.claudeBin,
      ...(resolved.target.env ? { env: resolved.target.env } : {}),
    });
    if (result.session.status === "failed") {
      // 008 returns the row rather than throwing when a spawn fails, because
      // the row is the evidence. Pass its own diagnosis through unchanged —
      // "hooks never arrived" and "handshake rejected" have different
      // remedies and this is not the place to flatten them.
      return respawnSkip(
        "spawn_failed",
        `${result.session.failureKind ?? "unknown"}: ${result.session.failureReason ?? "no reason recorded"}`,
        result.session.id,
      );
    }
    return { spawned: true, sessionId: result.session.id, reason: null, detail: null };
  } catch (error) {
    if (isPauseRefusal(error)) {
      // The `sessions` insert trigger refused it: a pause is still in effect
      // over this project. Reachable when a pause is opened between the lift
      // and this spawn.
      return respawnSkip("project_paused", "a pause is in effect, so the spawn was refused");
    }
    if (error instanceof SessionError) {
      if (error.kind === "identity_conflict") {
        return respawnSkip("already_running", error.message);
      }
      return respawnSkip("spawn_failed", `${error.kind}: ${error.message}`);
    }
    throw error;
  }
}

// --- Resuming one task ----------------------------------------------------------

function taskSkip(
  taskId: TaskId,
  reason: ResumeSkipReason,
  detail: string | null,
  blockedBy: readonly TaskId[] = [],
): ResumeTaskOutcome {
  return {
    taskId,
    resumed: false,
    detail,
    resumedTo: null,
    skipReason: reason,
    blockedBy,
    locksUnpaused: 0,
    respawn: respawnSkip("not_requested", "the task was not resumed"),
  };
}

async function resumeOneTask(task: TaskRecord, input: ResumeInput): Promise<ResumeTaskOutcome> {
  if (task.state !== "paused") {
    // The ordinary idempotent case: a retry after a partial failure finds the
    // tasks the first attempt got to already resumed.
    return taskSkip(task.id, "not_paused", `the task is ${task.state}, not paused`);
  }

  const origin = await pausedOriginState(task.id);
  if (origin === undefined) {
    // 012's guard would refuse the transition anyway; refusing here means the
    // operator gets a sentence instead of a stack trace.
    return taskSkip(
      task.id,
      "no_pause_origin",
      "the task is paused but no history row records what it was paused from, so resume has no origin to return it to",
    );
  }

  if (needsDependencyCheck(origin)) {
    const claim = await isClaimable(task.id);
    if (!claim.claimable) {
      return taskSkip(
        task.id,
        "blocked_by_dependency",
        `a dependency has not reached delivered, so resuming this task would start work the dependency graph says cannot start`,
        claim.blockedBy,
      );
    }
  }

  const actor = input.requestedBy.trim();
  let moved;
  let locksUnpaused = 0;
  try {
    const result = await withTransaction(async (client: PoolClient) => {
      const transitioned = await transition(
        {
          taskId: task.id,
          to: origin,
          actor,
          actorKind: input.requestedByKind ?? "human",
          expectedFrom: "paused",
        },
        client,
      );
      // BOTH of these, in this transaction, for the reason in property 2 at
      // the top of the file: a paused lock's TTL has almost certainly expired
      // while the work was paused, so clearing `paused` without restarting
      // the clock hands the sweeper a live-but-expired lock and the task
      // loses the files it was resumed to work on.
      const unpaused = await setLocksPaused(task.id, false, client);
      await heartbeat(task.id, undefined, client);
      return { transitioned, unpaused };
    });
    moved = result.transitioned;
    locksUnpaused = result.unpaused;
  } catch (error) {
    if (error instanceof TaskTransitionError) {
      // It moved under us — another resume, or a concurrent transition.
      return taskSkip(task.id, "not_paused", error.message);
    }
    throw error;
  }

  // After the commit. See `announce`.
  await announceTransition(moved);

  const respawn = await respawnFor(moved.task, origin, input);

  await announce("ResumeTaskResumed", task.projectId, {
    task_id: task.id,
    resumed_to: origin,
    requested_by: actor,
    locks_unpaused: locksUnpaused,
    respawned: respawn.spawned,
    session_id: respawn.sessionId,
    respawn_skip_reason: respawn.reason,
    handoff_notice: HANDOFF_UNAVAILABLE_NOTICE,
  });
  await announce(
    respawn.spawned ? "ResumeAgentRespawned" : "ResumeAgentRespawnSkipped",
    task.projectId,
    {
      task_id: task.id,
      session_id: respawn.sessionId,
      reason: respawn.reason,
      detail: respawn.detail,
    },
  );

  return {
    taskId: task.id,
    resumed: true,
    detail: null,
    resumedTo: origin,
    skipReason: null,
    blockedBy: [],
    locksUnpaused,
    respawn,
  };
}

// --- Entry points ---------------------------------------------------------------

async function loadTask(taskId: TaskId): Promise<TaskRecord> {
  const { rows } = await query<TaskRow>(`select ${TASK_COLUMNS} from tasks where id = $1`, [taskId]);
  const row = rows[0];
  if (!row) throw new ControlError("not_found", `no task ${taskId}`);
  return taskRowToRecord(row);
}

function requireActor(requestedBy: string): string {
  if (requestedBy.trim() === "") {
    throw new ControlError("invalid_request", "requested_by is required and must not be blank");
  }
  return requestedBy.trim();
}

/**
 * Resume one task.
 *
 * REFUSED WHILE A PAUSE COVERS THE PROJECT, on purpose. A pause is a
 * statement that nothing runs here; starting one agent inside it would
 * quietly contradict what the human asked for, and the `sessions` insert
 * trigger would refuse the spawn anyway — leaving a task in `in_progress`
 * with nobody on it, which is the one outcome worse than not resuming.
 *
 * The path that is NOT refused is the one this is mostly for: a task that
 * was paused on its own by a crash, a rate limit or a circuit breaker, with
 * no office-wide pause behind it. There is no pause row to lift, so there is
 * nothing in the way.
 */
export async function resumeTask(input: ResumeInput & { taskId: TaskId }): Promise<ResumeResult> {
  const actor = requireActor(input.requestedBy);
  const task = await loadTask(input.taskId);

  const pause = await activePauseFor(task.projectId);
  if (pause) {
    throw new ControlError(
      "project_paused",
      `project ${task.projectId} is paused, so task ${task.id} cannot be resumed on its own; resume the project instead`,
      `${pause.kind} pause ${pause.id}${pause.projectId === null ? " (global)" : ""} started by ${pause.initiatedBy} at ${pause.startedAt}`,
    );
  }

  await announce("ResumeStarted", task.projectId, {
    scope: "task",
    task_id: task.id,
    requested_by: actor,
  });

  const outcome = await resumeOneTask(task, { ...input, requestedBy: actor });
  if (!outcome.resumed) {
    await announce("ResumeTaskSkipped", task.projectId, {
      task_id: task.id,
      reason: outcome.skipReason,
      detail: outcome.detail,
      blocked_by: outcome.blockedBy,
    });
  }

  await announce("ResumeCompleted", task.projectId, {
    scope: "task",
    task_id: task.id,
    requested_by: actor,
    resumed: outcome.resumed ? 1 : 0,
    skipped: outcome.resumed ? 0 : 1,
    notices: RESUME_NOTICES,
  });

  return {
    scope: { projectId: task.projectId, taskId: task.id },
    requestedBy: actor,
    liftedPause: null,
    tasks: [outcome],
    notices: RESUME_NOTICES,
  };
}

/**
 * Resume every paused task in a project — or, with no project, in the whole
 * office.
 *
 * ORDER MATTERS, and this is the only reason it is not a plain loop. A task
 * paused from `in_progress` may only be resumed when its dependencies are
 * delivered (014), and a blocker that is itself paused *from* `delivered`
 * only becomes delivered again when this very call resumes it. Processing in
 * reverse lifecycle order — the furthest-along origins first — means a
 * blocker is back in `delivered` before anything that waits on it is asked
 * whether it may start. Without it, the same Resume pressed twice could give
 * two different boards depending on the order of task ids.
 *
 * THE LIFT COMES FIRST, before any task is touched. The `sessions` insert
 * trigger refuses a spawn while a pause is in effect, so a resume that moved
 * tasks before lifting its own pause would be blocked by itself. If the
 * process dies between the lift and the tasks, the pause is gone and the
 * tasks are still paused — which is exactly the state a second Resume
 * recovers from, and it is the safe direction to fail in: nothing starts on
 * its own.
 */
export async function resumeProject(input: ResumeInput): Promise<ResumeResult> {
  const actor = requireActor(input.requestedBy);
  const scope = input.projectId ?? null;

  const liftedPause: PauseRecord | null = await liftPausesFor(scope, actor);

  const { rows } = await query<TaskRow>(
    `select ${TASK_COLUMNS} from tasks
      where ($1::uuid is null or project_id = $1::uuid) and state = 'paused'
      order by id`,
    [scope],
  );
  const tasks = rows.map(taskRowToRecord);

  // One `pausedOriginState` per task rather than a bulk query, deliberately:
  // it is a LIMIT 1 on an index (012 built it that way for exactly this
  // caller), and a second copy of "the newest history row whose to_state is
  // paused" is a second place for that rule to drift. Resume is a rare,
  // human-triggered operation; N indexed lookups are the right trade.
  const origins = new Map<string, TaskState | undefined>();
  for (const task of tasks) {
    origins.set(task.id, await pausedOriginState(task.id));
  }
  const ordered = [...tasks].sort((a, b) => stageRank(origins.get(b.id)) - stageRank(origins.get(a.id)));

  const projectIds = new Set<string>(tasks.map((task) => task.projectId));
  if (scope !== null) projectIds.add(scope);

  for (const projectId of projectIds) {
    await announce("ResumeStarted", projectId, {
      scope: scope === null ? "global" : "project",
      project_id: scope,
      requested_by: actor,
      lifted_pause: liftedPause?.id ?? null,
      paused_tasks: tasks.filter((task) => task.projectId === projectId).length,
    });
  }

  const outcomes: ResumeTaskOutcome[] = [];
  for (const task of ordered) {
    // Sequential, not concurrent, and that is the point: a later task's
    // dependency check has to see an earlier task's resume. Resume is not on
    // any hot path.
    const outcome = await resumeOneTask(task, { ...input, requestedBy: actor });
    outcomes.push(outcome);
    if (!outcome.resumed) {
      await announce("ResumeTaskSkipped", task.projectId, {
        task_id: task.id,
        reason: outcome.skipReason,
        detail: outcome.detail,
        blocked_by: outcome.blockedBy,
      });
    }
  }

  for (const projectId of projectIds) {
    const mine = outcomes.filter((outcome) =>
      tasks.some((task) => task.id === outcome.taskId && task.projectId === projectId),
    );
    await announce("ResumeCompleted", projectId, {
      scope: scope === null ? "global" : "project",
      project_id: scope,
      requested_by: actor,
      lifted_pause: liftedPause?.id ?? null,
      resumed: mine.filter((outcome) => outcome.resumed).length,
      skipped: mine.filter((outcome) => !outcome.resumed).length,
      respawned: mine.filter((outcome) => outcome.respawn.spawned).length,
      notices: RESUME_NOTICES,
    });
  }

  return {
    scope: { projectId: scope, taskId: null },
    requestedBy: actor,
    liftedPause,
    tasks: outcomes,
    notices: RESUME_NOTICES,
  };
}

/** Lifecycle position, used only to order a project-wide resume. An unknown
 * origin sorts last, which puts the tasks that cannot be resumed at all at
 * the end rather than in the middle. */
function stageRank(state: TaskState | undefined): number {
  if (state === undefined) return -1;
  const order: readonly TaskState[] = [
    "pending",
    "in_progress",
    "ready_for_qa",
    "ci",
    "qa_review",
    "lead_approval",
    "delivered",
  ];
  return order.indexOf(state);
}

/** One entry point for the route: a task id resumes one task, anything else
 * resumes a scope. */
export async function resume(input: ResumeInput): Promise<ResumeResult> {
  if (input.taskId) return resumeTask({ ...input, taskId: asTaskId(input.taskId) });
  return resumeProject(input);
}
