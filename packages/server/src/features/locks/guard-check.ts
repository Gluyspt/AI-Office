// The PreToolUse ownership guard's decision: may this agent write this file?
//
// Ticket 020. The registry (015) refuses overlapping *claims*; this refuses
// overlapping *edits*. It is the last line between two agents and a git
// conflict, and the design's only mechanism that catches an agent editing a
// file outside its declared scope.
//
//
// THE SHAPE THAT BLOCKS, AND THE ONE THAT LOOKS LIKE IT DOES
// ----------------------------------------------------------
// Spike 001 §2b fired four response shapes at a live `PreToolUse` on build
// 2.1.278 and read the verdict off whether `PostToolUse` fired and what its
// `tool_response` held — the only trustworthy witness. The results, which
// overrule both the design ("hooks block by exiting with code 2") and this
// ticket's own earlier wording:
//
//   - `hookSpecificOutput.permissionDecision: "deny"` -> BLOCKS. The
//     documented contract, and the one that renders to the agent as a
//     permission denial rather than an error.
//   - top-level `decision: "block"` -> BLOCKS. The only shape that blocked
//     BOTH `PreToolUse` and `UserPromptSubmit`.
//   - `continue: false` -> DOES **NOT** BLOCK. The tool ran in full (the
//     file's whole text came back in `PostToolUse.tool_response`) and then
//     NO turn-end event fired at all. Tested twice, the second time against
//     a file the session had never read, to rule out the unchanged-file
//     cache. Using it as an ownership guard would leak exactly the content
//     the guard exists to protect, and hang the chat panel's spinner
//     forever. It is never emitted here and `buildDenyBody` has no path to
//     it.
//   - a 500 -> does not block. **Blocking is carried by the body of a 2xx,
//     not by the status code.** So this module's callers answer 200 even
//     when they are refusing, and 200 when they fail open.
//
// This module emits BOTH blocking fields at once. Belt and braces, for a
// stated reason: the two events do not share a blocking vocabulary
// (`permissionDecision` is inert on `UserPromptSubmit` and authoritative
// here), so a build that moved the mapping again would silently stop
// blocking if only one field were sent.
//
//
// WHAT THE ALLOW BODY MUST NOT SAY
// --------------------------------
// `permissionDecision: "allow"` is NOT the opposite of `"deny"` — it means
// "bypass the permission system for this call", which would auto-approve
// writes that the design wants a human to see through the `PermissionRequest`
// hook (the mode decision in docs/tasks/README.md exists precisely because
// modes that answer their own prompts make that hook never fire). So an
// allow from this guard carries NO `hookSpecificOutput` at all: it reports
// under an `office` key the hook client ignores, and leaves the permission
// system exactly as it found it.
//
//
// WHAT THIS GUARD CANNOT SEE — document the limit, do not claim the coverage
// -------------------------------------------------------------------------
//   - **`!` bash mode bypasses `PreToolUse` entirely** (spike 001 §8.4).
//     The guard constrains the agent, not the session: anyone with the tmux
//     pane can run shell commands it never sees.
//   - **`Bash` is not checkable.** Its `tool_input` carries a `command`, not
//     a path; `sed -i`, `>` and `git checkout` are all mutating file writes
//     with no file_path for the guard to read. It is deliberately absent
//     from CHECKED_TOOLS rather than guessed at.
//   - **A file outside the repo is allowed.** `cwd` is the only anchor a
//     hook payload gives (spike 001 §5: no branch, no repo, no task id), so
//     a path that is not under it cannot be made repo-relative and cannot be
//     compared with a lock pattern. This is the ticket's open question, left
//     open: currently allowed, recorded in the decision as
//     `outside_cwd`.
import type { PoolClient } from "pg";
import type { FileLockRecord } from "@office/shared/locks";
import type { ProjectId, TaskId } from "@office/shared/ids";
import { query } from "../../core/db/pool.ts";
import { loadGuardConfig } from "../../core/config.ts";
import { recordSystemEvent } from "../events/ingest.ts";
import { findSessionByClaudeSessionId } from "../chat/conversations.ts";
import { InvalidPatternError, normalisePattern, patternsOverlap } from "./overlap.ts";
import { heartbeat, listActiveLocks } from "./registry.ts";

// --- The checked tools, enumerated in ONE place --------------------------------

/**
 * The mutating tools this guard checks. The acceptance criterion is that the
 * list is "enumerated in one place", and this is that place: the hook
 * fragment's `matcher` is derived from it (`CHECKED_TOOLS.join("|")`, see
 * `GUARD_MATCHER`) and a test asserts the shipped fragment still equals that
 * string, so the two cannot drift.
 *
 * Read-only tools are absent and are therefore never blocked — `Read`,
 * `Grep`, `Glob`, `WebFetch` and the rest reach `isCheckedTool` as false and
 * the guard allows them without touching the database.
 *
 * `MultiEdit` is listed and is **not** known to exist on build 2.1.278 (the
 * spike found no `TodoWrite` either, so the tool set does move). A matcher
 * naming a tool that does not exist costs nothing; a tool that appears later
 * and is not named would edit unguarded, which is the expensive direction.
 */
export const CHECKED_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"] as const;

export type CheckedTool = (typeof CHECKED_TOOLS)[number];

/**
 * The `matcher` the hook fragment must carry.
 *
 * Deliberately UNANCHORED. Claude Code's matcher semantics (substring match
 * versus full match) are not something the spike measured, and the two
 * readings differ: anchored `^(Write|Edit)$` would miss `NotebookEdit` under
 * a substring reading of a shorter list, while an unanchored alternation
 * naming every tool in full is correct under both. The cost of being wrong
 * in this direction is an extra check on a tool whose name merely contains
 * one of these, and the server re-checks the name anyway.
 */
export const GUARD_MATCHER = CHECKED_TOOLS.join("|");

export function isCheckedTool(toolName: unknown): toolName is CheckedTool {
  return typeof toolName === "string" && (CHECKED_TOOLS as readonly string[]).includes(toolName);
}

// --- The payload, as little of it as possible ------------------------------------

/**
 * The fields of a `PreToolUse` payload this guard reads. Spike 001 §5: "this
 * is everything ticket 020's ownership guard needs and no more".
 *
 * `toolInput` is `unknown` on purpose. For a `Write` it carries the whole
 * file body in `content`, and nothing here may look at that — "the script
 * does not read or log file contents, only paths" is an acceptance criterion
 * and it applies to the server half too. `extractPaths` reads named path
 * fields and nothing else; no code in this module ever stringifies
 * `toolInput`.
 */
export interface GuardCheckInput {
  readonly sessionId: string | null;
  readonly toolName: string | null;
  readonly toolInput: unknown;
  readonly cwd: string | null;
  readonly toolUseId: string | null;
}

/** The named path fields of every checked tool, in the order they are read. */
const PATH_FIELDS = ["file_path", "notebook_path", "path"] as const;

/**
 * `events.session_id` and `file_locks.session_id` are `uuid` columns, and a
 * hook payload's `session_id` is only *syntactically* a uuid by convention
 * (005's ingest makes the same check for the same reason). A forged or
 * truncated value must become NULL rather than abort an insert — this runs on
 * the hot path of every tool call, and a 500 here is a hook error shown to
 * the agent.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function asUuidOrNull(value: unknown): string | null {
  return typeof value === "string" && UUID_RE.test(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Every file path a checked tool's input names, de-duplicated, order
 * preserved.
 *
 * `MultiEdit` nests per-edit paths under `edits[]`, so that array is walked
 * too — but only its `file_path` members. Nothing else in `tool_input` is
 * read: not `content`, not `new_string`, not `old_string`.
 */
export function extractPaths(toolInput: unknown): string[] {
  if (typeof toolInput !== "object" || toolInput === null || Array.isArray(toolInput)) return [];
  const record = toolInput as Record<string, unknown>;
  const found: string[] = [];
  const push = (value: unknown): void => {
    const path = stringOrNull(value);
    if (path !== null && !found.includes(path)) found.push(path);
  };
  for (const field of PATH_FIELDS) push(record[field]);
  const edits = record.edits;
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      if (typeof edit !== "object" || edit === null) continue;
      push((edit as Record<string, unknown>).file_path);
    }
  }
  return found;
}

// --- Paths: absolute on the agent's box, repo-relative in the registry ----------

export type PathResolution =
  | { readonly ok: true; readonly raw: string; readonly relative: string }
  /** Why this path could not be compared with a lock pattern. */
  | { readonly ok: false; readonly raw: string; readonly skipped: string };

/**
 * An absolute tool path plus the agent's cwd, to the repo-relative POSIX form
 * `file_locks.path_pattern` is stored in.
 *
 * Both halves matter. Absolute paths are what a hook payload actually carries
 * (`/home/agent1/proj/src/a.ts`), and the registry compares normalised
 * repo-relative strings — `normalisePattern` rejects an absolute path
 * outright, so handing one straight to `patternsOverlap` would throw on every
 * real call. A relative path in `tool_input` is taken as already
 * repo-relative, which is how an agent usually spells one.
 *
 * A path that is not under `cwd` is REFUSED here rather than compared: see
 * the module header's "outside the repo" note. That is the ticket's open
 * question and it stays open — allowed, and recorded as skipped so the
 * decision says what it did not examine.
 */
export function resolveRepoRelative(raw: string, cwd: string | null): PathResolution {
  const path = raw.replace(/\\/g, "/");
  const isAbsolute = path.startsWith("/") || /^[A-Za-z]:\//.test(path);

  let candidate = path;
  if (isAbsolute) {
    if (cwd === null || cwd.trim() === "") {
      return { ok: false, raw, skipped: "absolute path and the payload carried no cwd" };
    }
    const base = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
    if (path === base) {
      return { ok: false, raw, skipped: "the path is the repository root itself" };
    }
    if (!path.startsWith(`${base}/`)) {
      return { ok: false, raw, skipped: "outside_cwd" };
    }
    candidate = path.slice(base.length + 1);
  }

  try {
    return { ok: true, raw, relative: normalisePattern(candidate) };
  } catch (error) {
    if (error instanceof InvalidPatternError) {
      return { ok: false, raw, skipped: error.message };
    }
    throw error;
  }
}

// --- Whose lock is it? ----------------------------------------------------------

/**
 * Does `lock` belong to the caller?
 *
 * **An open question answered by covering both readings rather than picking
 * one.** `file_locks.session_id` is written by `claim_task` (ticket 017,
 * unwritten), and nothing in the repo yet says whether it holds the
 * orchestrator's `sessions.id` or the Claude session id off the hook payload.
 * The migration's "NOT a foreign key" note implies the former; `releaseBySession`
 * is driven by the `SessionEnd` hook, which only ever has the latter. Both
 * are live possibilities.
 *
 * Getting it wrong in one direction blocks an agent from editing its OWN
 * declared scope — the failure that stops all work. Getting it wrong in the
 * other direction is impossible here, because the two id spaces do not
 * collide: a `sessions.id` is minted by the database and a Claude session id
 * by the CLI, so accepting either cannot grant ownership to a third party.
 * The asymmetry decides it: accept both, and record the question on the
 * ticket for 017 to close.
 */
export function lockBelongsToCaller(
  lock: FileLockRecord,
  claudeSessionId: string | null,
  sessionRowId: string | null,
): boolean {
  if (lock.sessionId === null) return false;
  if (claudeSessionId !== null && lock.sessionId === claudeSessionId) return true;
  return sessionRowId !== null && lock.sessionId === sessionRowId;
}

export interface CallerScope {
  /** The orchestrator's own row, when the Claude session id resolves to one. */
  readonly sessionRowId: string | null;
  readonly projectId: ProjectId | null;
  /** Tasks whose held locks are attributed to this caller. */
  readonly taskIds: readonly TaskId[];
  readonly locks: readonly FileLockRecord[];
}

/**
 * Which tasks this Claude session is holding scope for, and in which project.
 *
 * Used by the decision below and by `handlers/tool.ts`'s heartbeat, so the
 * attribution rule lives in one function rather than two.
 *
 * Note it does NOT go through `sessions` to find the project when the session
 * is unregistered: an unresolvable session has no project, no locks and no
 * tasks, and the guard then allows (fail open) rather than refusing an agent
 * it cannot identify.
 */
export async function callerScope(rawSessionId: string | null): Promise<CallerScope> {
  const claudeSessionId = asUuidOrNull(rawSessionId);
  if (claudeSessionId === null) {
    return { sessionRowId: null, projectId: null, taskIds: [], locks: [] };
  }
  const session = await findSessionByClaudeSessionId(claudeSessionId);
  if (session === null) {
    // A lock may still be attributed directly to the Claude session id even
    // when no orchestrator row resolves (a desk deleted, a replayed id). Ask
    // the registry rather than assuming not.
    const direct = await listActiveLocks({ sessionId: claudeSessionId });
    return {
      sessionRowId: null,
      projectId: direct[0]?.projectId ?? null,
      taskIds: [...new Set(direct.map((lock) => lock.taskId))],
      locks: direct,
    };
  }
  const projectId = session.projectId as ProjectId;
  const held = await listActiveLocks({ projectId });
  const mine = held.filter((lock) => lockBelongsToCaller(lock, claudeSessionId, session.id));
  return {
    sessionRowId: session.id,
    projectId,
    taskIds: [...new Set(mine.map((lock) => lock.taskId))],
    locks: held,
  };
}

// --- The decision ---------------------------------------------------------------

export interface GuardConflict {
  readonly path: string;
  readonly rawPath: string;
  readonly heldPattern: string;
  readonly heldLockId: string;
  readonly ownerTaskId: TaskId;
  readonly ownerTaskTitle: string | null;
  readonly ownerTaskOwner: string | null;
  readonly ownerSessionId: string | null;
  readonly certain: boolean;
  readonly reason: string;
}

export interface GuardDecision {
  readonly outcome: "allow" | "deny";
  /** False when the tool is not a mutating one, or no path was found. */
  readonly checked: boolean;
  /** Human-readable, and on a deny this is what the agent is told. */
  readonly reason: string;
  readonly paths: readonly string[];
  readonly skipped: readonly { readonly path: string; readonly why: string }[];
  readonly conflicts: readonly GuardConflict[];
  /** Set when the guard could not complete its check and allowed anyway. */
  readonly degraded: boolean;
  readonly projectId: ProjectId | null;
  readonly ownTaskIds: readonly TaskId[];
  readonly elapsedMs: number;
}

function allow(
  reason: string,
  extra: Partial<GuardDecision> = {},
): GuardDecision {
  return {
    outcome: "allow",
    checked: true,
    reason,
    paths: [],
    skipped: [],
    conflicts: [],
    degraded: false,
    projectId: null,
    ownTaskIds: [],
    elapsedMs: 0,
    ...extra,
  };
}

interface TaskFacts {
  readonly title: string | null;
  readonly owner: string | null;
}

async function taskFacts(
  taskIds: readonly string[],
  client?: PoolClient,
): Promise<Map<string, TaskFacts>> {
  const facts = new Map<string, TaskFacts>();
  if (taskIds.length === 0) return facts;
  const sql = `select id, title, owner from tasks where id = any($1::uuid[])`;
  const result = client
    ? await client.query<{ id: string; title: string; owner: string }>(sql, [taskIds])
    : await query<{ id: string; title: string; owner: string }>(sql, [taskIds]);
  for (const row of result.rows) facts.set(row.id, { title: row.title, owner: row.owner });
  return facts;
}

/**
 * One line of feedback, written to be read by a model.
 *
 * Spike 001 §2b: "Both blocking shapes feed the reason straight into the
 * agent's context, and the agent handled it gracefully and did not retry — it
 * stopped and asked the human. The text the guard writes is read by the agent
 * as an explanation, so it should say what to do next, not just refuse."
 *
 * It also has to read sensibly behind a prefix: a `command` hook's refusal is
 * rendered as `PreToolUse operation blocked by hook: [<script path>]: <text>`.
 * So no leading capital-letter sentence that assumes it starts a line, and no
 * "Error:".
 */
export function denyMessage(conflicts: readonly GuardConflict[]): string {
  const first = conflicts[0]!;
  const who = [
    `task ${first.ownerTaskId}`,
    first.ownerTaskTitle ? `"${first.ownerTaskTitle}"` : null,
    first.ownerTaskOwner ? `owner ${first.ownerTaskOwner}` : null,
  ]
    .filter((part) => part !== null)
    .join(" ");
  const more =
    conflicts.length > 1 ? ` (and ${conflicts.length - 1} more path(s) in this call)` : "";
  const hedge = first.certain
    ? ""
    : " The overlap could not be proved disjoint rather than demonstrated, so this refusal is the conservative one.";
  return (
    `${first.path} is owned by ${who}, which holds the file scope ${JSON.stringify(first.heldPattern)}${more}. ` +
    `Do not edit it: ask that task's owner to make the change, or work on a file inside your own declared scope.${hedge}`
  );
}

/**
 * The guard's answer for one `PreToolUse`.
 *
 * Fails OPEN on every internal problem — a database error, a pattern it
 * cannot parse, its own deadline. An unreachable or wedged orchestrator must
 * not freeze every agent on the box, so the edit proceeds and
 * `degraded: true` says the protection was not applied. During that window
 * the protection degrades to `claim_task` alone, exactly as the ticket's
 * Decided section says.
 */
export async function guardCheck(input: GuardCheckInput): Promise<GuardDecision> {
  const startedAt = process.hrtime.bigint();
  const elapsed = (): number => Number(process.hrtime.bigint() - startedAt) / 1e6;

  if (!isCheckedTool(input.toolName)) {
    return allow(`${input.toolName ?? "(no tool name)"} is not a mutating tool`, {
      checked: false,
      elapsedMs: elapsed(),
    });
  }

  const rawPaths = extractPaths(input.toolInput);
  if (rawPaths.length === 0) {
    return allow(`${input.toolName} carried no file path to check`, {
      checked: false,
      elapsedMs: elapsed(),
    });
  }

  const resolutions = rawPaths.map((raw) => resolveRepoRelative(raw, input.cwd));
  const skipped = resolutions
    .filter((resolution): resolution is Extract<PathResolution, { ok: false }> => !resolution.ok)
    .map((resolution) => ({ path: resolution.raw, why: resolution.skipped }));
  const resolved = resolutions.filter(
    (resolution): resolution is Extract<PathResolution, { ok: true }> => resolution.ok,
  );

  if (resolved.length === 0) {
    return allow("no path in this call could be made repo-relative", {
      checked: false,
      paths: [],
      skipped,
      elapsedMs: elapsed(),
    });
  }

  // Its own deadline, so a stalled database answers "allow" here rather than
  // letting the hook client time out. A client timeout is indistinguishable
  // from an unreachable orchestrator and loses the chance to say why.
  const { checkTimeoutMs } = loadGuardConfig();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), checkTimeoutMs);
    timer.unref?.();
  });

  try {
    const work = (async () => {
      const scope = await callerScope(input.sessionId);
      const own = new Set<string>(scope.taskIds);

      const conflicts: GuardConflict[] = [];
      const theirs = scope.locks.filter((lock) => !own.has(lock.taskId));
      const facts = await taskFacts([...new Set(theirs.map((lock) => lock.taskId))]);

      for (const resolution of resolved) {
        for (const lock of theirs) {
          const verdict = patternsOverlap(resolution.relative, lock.pathPattern);
          if (!verdict.overlaps) continue;
          const fact = facts.get(lock.taskId);
          conflicts.push({
            path: resolution.relative,
            rawPath: resolution.raw,
            heldPattern: lock.pathPattern,
            heldLockId: lock.id,
            ownerTaskId: lock.taskId,
            ownerTaskTitle: fact?.title ?? null,
            ownerTaskOwner: fact?.owner ?? null,
            ownerSessionId: lock.sessionId,
            certain: verdict.certain,
            reason: verdict.reason,
          });
        }
      }

      const base = {
        checked: true,
        paths: resolved.map((resolution) => resolution.relative),
        skipped,
        projectId: scope.projectId,
        ownTaskIds: scope.taskIds,
      };

      if (conflicts.length === 0) {
        return {
          ...allow(
            scope.taskIds.length > 0
              ? "every path in this call is inside this session's own declared scope, or unowned"
              : "no active task owns any path in this call",
            base,
          ),
          elapsedMs: elapsed(),
        };
      }

      return {
        outcome: "deny" as const,
        ...base,
        reason: denyMessage(conflicts),
        conflicts,
        degraded: false,
        elapsedMs: elapsed(),
      };
    })();

    const result = await Promise.race([work, deadline]);
    if (result === "timeout") {
      await noteDegraded(
        `the ownership check exceeded its ${checkTimeoutMs}ms budget`,
        null,
      );
      return allow(`the ownership check exceeded its ${checkTimeoutMs}ms budget — failing open`, {
        checked: false,
        degraded: true,
        paths: resolved.map((resolution) => resolution.relative),
        skipped,
        elapsedMs: elapsed(),
      });
    }
    await noteHealthy();
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await noteDegraded(message, null);
    return allow(`the ownership check failed (${message}) — failing open`, {
      checked: false,
      degraded: true,
      skipped,
      elapsedMs: elapsed(),
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// --- Degradation and recovery, as events ----------------------------------------
//
// "Guard degradation and recovery are emitted as events, so the UI can show a
// degraded-guard banner while checks are failing and list the unguarded edits
// afterwards."
//
// TWO DIFFERENT OUTAGES, AND ONLY ONE OF THEM CAN BE REPORTED LIVE.
//
//   1. The orchestrator is UP but its check is failing — a wedged database,
//      its own deadline. That is this pair of events, emitted here, live. It
//      is also the only one that CAN be live: the web app is served by this
//      same process, so an orchestrator that cannot answer a guard check
//      cannot push a banner either.
//   2. The orchestrator is UNREACHABLE. Nothing here runs at all; the guard
//      script buffers to disk and `unguarded-edits.ts` emits the degradation
//      window retroactively when the buffer is flushed. The banner then shows
//      after the fact, with the edits enumerated.
//
// Debounced on an in-process edge, not written per call: a degraded guard
// fails on EVERY tool call of every agent, and one event per call would bury
// the board under thousands of identical rows during the outage it is meant
// to report. The durable record is the event pair plus `unguarded_edits`; the
// flag itself is deliberately not durable, because a restarted orchestrator
// has no idea whether the condition still holds and should discover that from
// its next check rather than from a stale row.

let degradedReason: string | null = null;

/** Test seam: the module-level edge flag, reset between cases. */
export function __resetGuardHealth(): void {
  degradedReason = null;
}

export function guardIsDegraded(): boolean {
  return degradedReason !== null;
}

async function noteDegraded(reason: string, projectId: ProjectId | null): Promise<void> {
  if (degradedReason !== null) return;
  degradedReason = reason;
  await recordSystemEvent("GuardDegraded", { reason, source: "check" }, null, projectId);
}

async function noteHealthy(): Promise<void> {
  if (degradedReason === null) return;
  const previous = degradedReason;
  degradedReason = null;
  await recordSystemEvent("GuardRecovered", { previous_reason: previous, source: "check" }, null, null);
}

// --- The heartbeat --------------------------------------------------------------

/**
 * Pushes out the TTL on every lock this session holds.
 *
 * THE OPEN QUESTION THIS ANSWERS, AND WHY NOT THE WAY THE TICKET PROPOSED.
 * The design names `PostToolUse` as the heartbeat trigger but leaves it out
 * of its own hook-config block, and this ticket's open question says to
 * register it. It is registered on **`PreToolUse`** instead, which the base
 * template already delivers to `/events/tool` for every tool with no matcher
 * — so the heartbeat needs no new hook entry at all. Three reasons, in order
 * of weight:
 *
 *  1. **`PostToolUse.tool_response` carries the tool's entire output** — for
 *     a `Read`, the whole file body; for a `Write`, everything written
 *     (spike 001 §5). Registering it would push a copy of every source file
 *     an agent touches into the `events` table, which the spike flags as a
 *     real size *and* confidentiality question. `PreToolUse` already flows
 *     there and adding a second copy buys nothing.
 *  2. **It is strictly more frequent.** `PreToolUse` fires before every tool
 *     call including read-only ones, and before a call that is then denied —
 *     all of which are proof the agent is alive, which is the only thing a
 *     heartbeat asserts. A turn that halts *at* a tool call fires no
 *     `PostToolUse` and no `Stop` either (§2b, §4b).
 *  3. **It cannot be dropped by a block.** The guard's own refusals stop
 *     `PostToolUse` from firing; a heartbeat hanging off it would go quiet
 *     for a task that is being refused repeatedly, and the TTL would then
 *     expire the locks of an agent that is demonstrably still working.
 *
 * Returns the number of locks refreshed, which is zero for a lead with no
 * task — the normal case and not an error.
 */
export async function heartbeatForSession(rawSessionId: string | null): Promise<number> {
  const claudeSessionId = asUuidOrNull(rawSessionId);
  if (claudeSessionId === null) return 0;
  const direct = await listActiveLocks({ sessionId: claudeSessionId });
  let locks = direct;
  if (locks.length === 0) {
    const session = await findSessionByClaudeSessionId(claudeSessionId);
    if (session === null) return 0;
    locks = await listActiveLocks({ sessionId: session.id });
  }
  let refreshed = 0;
  for (const taskId of new Set(locks.map((lock) => lock.taskId))) {
    refreshed += await heartbeat(taskId);
  }
  return refreshed;
}

// --- Response bodies ------------------------------------------------------------

export interface GuardDenyBody {
  readonly hookSpecificOutput: {
    readonly hookEventName: "PreToolUse";
    readonly permissionDecision: "deny";
    readonly permissionDecisionReason: string;
  };
  readonly decision: "block";
  readonly reason: string;
}

export interface GuardAllowBody {
  /**
   * Reported under a key the hook client ignores. There is NO
   * `hookSpecificOutput` here on purpose — see the module header: an explicit
   * `"allow"` means "bypass the permission system", not "proceed normally".
   */
  readonly office: {
    readonly outcome: "allow";
    readonly checked: boolean;
    readonly degraded: boolean;
    readonly reason: string;
    readonly paths: readonly string[];
    readonly skipped: readonly { readonly path: string; readonly why: string }[];
    readonly elapsed_ms: number;
  };
}

export function buildDenyBody(decision: GuardDecision): GuardDenyBody {
  return {
    // Both blocking fields, deliberately. See the module header.
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: decision.reason,
    },
    decision: "block",
    reason: decision.reason,
  };
}

export function buildAllowBody(decision: GuardDecision): GuardAllowBody {
  return {
    office: {
      outcome: "allow",
      checked: decision.checked,
      degraded: decision.degraded,
      reason: decision.reason,
      paths: decision.paths,
      skipped: decision.skipped,
      elapsed_ms: Math.round(decision.elapsedMs * 1000) / 1000,
    },
  };
}

/** Emitted on a refusal only. Never on an allow: one event per allowed tool
 *  call would double the event store's volume for no reader. */
export async function recordBlocked(
  input: GuardCheckInput,
  decision: GuardDecision,
): Promise<void> {
  await recordSystemEvent(
    "GuardEditBlocked",
    {
      session_id: input.sessionId,
      tool_name: input.toolName,
      tool_use_id: input.toolUseId,
      cwd: input.cwd,
      paths: decision.paths,
      own_task_ids: decision.ownTaskIds,
      reason: decision.reason,
      conflicts: decision.conflicts.map((conflict) => ({
        path: conflict.path,
        held_pattern: conflict.heldPattern,
        owner_task_id: conflict.ownerTaskId,
        owner_task_owner: conflict.ownerTaskOwner,
        certain: conflict.certain,
      })),
      elapsed_ms: decision.elapsedMs,
    },
    asUuidOrNull(input.sessionId),
    decision.projectId,
  );
}
