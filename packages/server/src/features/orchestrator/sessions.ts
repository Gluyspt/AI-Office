// The session registry: the lifecycle state machine, the durable message
// queue, and the five operations everything above this layer calls.
//
// Ticket 008. "Only the orchestrator starts sessions, through
// start_session(...)." Ticket 018 wraps these same functions as MCP tools
// for leads; the web app calls them over HTTP (./routes/sessions.ts).
//
// Four properties this file exists to hold:
//
//  1. **The row is written BEFORE tmux is spawned.** A spawn that crashes
//     still leaves a record, with `failed` and the reason attached. The
//     alternative — spawn, then record — loses the only evidence of the
//     failure in exactly the case where someone needs it.
//
//  2. **A session is not `running` until its hooks are proven to reach
//     ingest.** This is the most important thing in the file and the least
//     obvious. The https-everywhere decision means an agent launched
//     without `NODE_EXTRA_CA_CERTS` in its environment works *perfectly*
//     and is **completely invisible to the orchestrator**: every hook fails
//     its TLS handshake, no event arrives, and nothing crashes. A desk that
//     looks healthy and reports nothing is the worst failure shape in the
//     system. So `startSession` waits for the first event carrying its
//     chosen session id, and marks the row `failed` if none comes — a loud,
//     specific refusal at the only moment anyone is watching. The same
//     check catches a forgotten hook config, an expired certificate, and an
//     event server that is simply down.
//
//  3. **The orchestrator owns the mid-turn queue.** Decided 2026-10-07 on
//     the grounds that the alternative is unobservable rather than broken —
//     see the measurement note in db/migrations/0003_sessions.sql. The
//     consequence here is that `interruptSession` *discards pending
//     messages* instead of hoping tmux forgets them, because on the target
//     a message queued before Escape still ran in 17 of 19 trials and was
//     discarded in 2.
//
//  4. **Busy/idle never comes from the pane.** Spike 003 measured the
//     `esc to interrupt` marker clearing 148-342 ms after a message is
//     *submitted* while the turn runs on for seconds. Anything scraping it
//     reports a working agent as idle as soon as one message is queued. So
//     this module exposes no `isBusy()`; state comes from events, and the
//     watchdog is ticket 010's.
//
// What this file deliberately does NOT do: decide *who* may act.
// `requestedBy` is recorded, never checked — permissions are step 9, which
// matches how states.ts treats a task's actor. The design's "refuses
// start_session while paused" check is stubbed, naming ticket 028.
import type { PoolClient } from "pg";
import {
  type QueuedMessage,
  type SessionBackend,
  type SessionFailureKind,
  type SessionRecord,
  type SessionRole,
  type SessionStatus,
  SESSION_STATUSES,
  isTerminalSessionStatus,
} from "@office/shared/sessions";
import { asProjectId, asSessionId, type ProjectId, type SessionId } from "@office/shared/ids";
import { loadSessionsConfig } from "../../core/config.ts";
import { query, withTransaction } from "../../core/db/pool.ts";
import { ingestEmitter, recordSystemEvent, type StoredEventRow } from "../events/ingest.ts";
import { sessionName } from "./naming.ts";
import {
  SESSION_TOKEN_ENV_VAR,
  mintSessionToken,
  type MintedSessionToken,
} from "./session-token.ts";
import { getTmuxAdapter, type TmuxAdapter } from "./tmux.ts";

// --- The transition table -------------------------------------------------------
//
// Modelled on features/tasks/states.ts: the legal edges are DATA, not
// scattered ifs, and a table-driven test walks the whole matrix against
// them. Unlike tasks, these are not enforced by database triggers — tasks
// are mutated by many callers (MCP tools, the API, the board), whereas a
// `sessions` row is only ever written by this module, so a trigger would
// cost a migration's worth of complexity to defend a door with one key.
// What the database *does* hold is the invariants a constraint expresses
// better than code: the status vocabulary, `ended_at` matching the status,
// and one live desk per identity.

export interface SessionTransitionRule {
  readonly from: SessionStatus;
  readonly to: SessionStatus;
  readonly label: string;
}

export const SESSION_TRANSITIONS: readonly SessionTransitionRule[] = [
  // The spawn succeeded and the desk proved its hooks reach ingest.
  { from: "starting", to: "running", label: "hooks confirmed" },
  // The spawn failed, the composer never appeared, or no hook arrived.
  { from: "starting", to: "failed", label: "spawn or hook delivery failed" },
  // Killed by us, or SessionEnd arrived for a reason that really ends it.
  { from: "starting", to: "ended", label: "killed before it was running" },
  { from: "running", to: "ended", label: "killed or ended" },
  // A desk can fail after working — the pane dies, the login expires.
  { from: "running", to: "failed", label: "died while running" },
];

export function isLegalSessionTransition(from: SessionStatus, to: SessionStatus): boolean {
  return SESSION_TRANSITIONS.some((rule) => rule.from === from && rule.to === to);
}

export function legalSessionTargets(from: SessionStatus): readonly SessionStatus[] {
  return SESSION_TRANSITIONS.filter((rule) => rule.from === from).map((rule) => rule.to);
}

// --- Errors ---------------------------------------------------------------------
//
// Typed results for operational outcomes, exceptions only for programmer
// error — the same rule the tmux adapter follows, so a caller can switch on
// a kind instead of matching message strings.

export type SessionErrorKind =
  | "not_found"
  | "illegal_transition"
  /** The desk has ended; nothing can be delivered to it. HTTP 409. */
  | "session_ended"
  /** Another live session already holds this (project, role, dept, owner). */
  | "identity_conflict"
  /** A dialog is up. Delivering would answer it — see the hazard note. */
  | "blocked_by_dialog"
  /** tmux/sudo refused, the composer never came up, or hooks never arrived. */
  | "spawn_failed"
  | "invalid_request";

export class SessionError extends Error {
  readonly kind: SessionErrorKind;
  /** Set when a dialog refusal knows which tool call is pending. */
  readonly pendingToolCall?: string;

  constructor(kind: SessionErrorKind, message: string, pendingToolCall?: string) {
    super(message);
    this.name = "SessionError";
    this.kind = kind;
    if (pendingToolCall !== undefined) this.pendingToolCall = pendingToolCall;
  }
}

export class IllegalSessionTransitionError extends SessionError {
  constructor(
    readonly sessionId: SessionId,
    readonly from: SessionStatus,
    readonly to: SessionStatus,
  ) {
    const targets = legalSessionTargets(from);
    super(
      "illegal_transition",
      `session ${sessionId} is ${from}; ${from} -> ${to} is not a legal transition (legal: ${
        targets.length > 0 ? targets.join(", ") : "none, it is terminal"
      })`,
    );
    this.name = "IllegalSessionTransitionError";
  }
}

// --- Row mapping ----------------------------------------------------------------
//
// TIMESTAMP TRAP, the fifth sighting in this repo. `timestamptz` -> JS
// `Date` loses microseconds, so any timestamp that must *match* a stored
// value cannot round-trip through a Date. These columns are read as TEXT
// and kept as strings all the way to the client. The same comment appears
// in states.ts, events/ingest.ts and tasks/repo.ts.
export const SESSION_COLUMNS = `
  id,
  project_id,
  tmux_name,
  role,
  dept,
  owner,
  backend,
  model,
  model_reason,
  status,
  claude_session_id,
  failure_reason,
  started_at::text as started_at,
  ended_at::text as ended_at
`;

/**
 * Exported for ./session-auth.ts, which maps a row it selected by
 * `token_hash` (a column SESSION_COLUMNS deliberately omits) through
 * `sessionRowToRecord` rather than keeping a second mapping in step with
 * this one.
 */
export interface SessionRow {
  id: string;
  project_id: string;
  tmux_name: string;
  role: string;
  dept: string;
  owner: string;
  backend: string;
  model: string;
  model_reason: string;
  status: string;
  claude_session_id: string | null;
  failure_reason: string | null;
  started_at: string;
  ended_at: string | null;
}

/**
 * `failure_reason` stores "kind: detail" so the two halves the ticket wants
 * separated survive one column. One column rather than two because the kind
 * is never queried on — it is read by a human and switched on by the UI,
 * both of which get it from the parsed record.
 */
function splitFailure(raw: string | null): {
  kind: SessionFailureKind | null;
  reason: string | null;
} {
  if (raw === null) return { kind: null, reason: null };
  const at = raw.indexOf(": ");
  if (at <= 0) return { kind: "other", reason: raw };
  return { kind: raw.slice(0, at) as SessionFailureKind, reason: raw.slice(at + 2) };
}

function joinFailure(kind: SessionFailureKind, reason: string): string {
  return `${kind}: ${reason}`;
}

export function sessionRowToRecord(row: SessionRow): SessionRecord {
  const failure = splitFailure(row.failure_reason);
  return {
    id: asSessionId(row.id),
    projectId: asProjectId(row.project_id),
    tmuxName: row.tmux_name,
    role: row.role as SessionRole,
    dept: row.dept,
    owner: row.owner,
    backend: row.backend as SessionBackend,
    model: row.model,
    modelReason: row.model_reason,
    status: row.status as SessionStatus,
    claudeSessionId: row.claude_session_id,
    failureKind: failure.kind,
    failureReason: failure.reason,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

// --- Injectable dependencies ----------------------------------------------------
//
// The adapter and the clock are swappable so tests can drive the whole
// lifecycle without tmux, sudo or a real agent. Nothing else in the module
// reaches for them directly.

export interface SessionsDeps {
  readonly tmux: TmuxAdapter;
  /** Resolves when an event carrying `claudeSessionId` is ingested, or times out. */
  waitForFirstEvent(claudeSessionId: string, timeoutMs: number): Promise<StoredEventRow | null>;
  newClaudeSessionId(): string;
  /**
   * Overridable for the same reason `newClaudeSessionId` is: a test that
   * asserts the token reached the pane environment has to know what to look
   * for. Production never overrides it.
   */
  newSessionToken(): MintedSessionToken;
}

function defaultWaitForFirstEvent(
  claudeSessionId: string,
  timeoutMs: number,
): Promise<StoredEventRow | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: StoredEventRow | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ingestEmitter.off("event", onEvent);
      resolve(value);
    };
    const onEvent = (event: StoredEventRow): void => {
      if (event.sessionId === claudeSessionId) finish(event);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    // Do not hold the process open waiting for a hook that may never come.
    timer.unref?.();
    ingestEmitter.on("event", onEvent);
  });
}

let deps: SessionsDeps = {
  get tmux() {
    return getTmuxAdapter();
  },
  waitForFirstEvent: defaultWaitForFirstEvent,
  newClaudeSessionId: () => crypto.randomUUID(),
  newSessionToken: mintSessionToken,
};

/** Test seam. Partial override; anything omitted keeps the real behaviour. */
export function __setSessionsDeps(overrides: Partial<SessionsDeps>): void {
  deps = { ...deps, ...overrides };
}

export function __resetSessionsDeps(): void {
  deps = {
    get tmux() {
      return getTmuxAdapter();
    },
    waitForFirstEvent: defaultWaitForFirstEvent,
    newClaudeSessionId: () => crypto.randomUUID(),
    newSessionToken: mintSessionToken,
  };
}

// --- Reads ----------------------------------------------------------------------

export async function getSession(id: SessionId): Promise<SessionRecord | null> {
  const { rows } = await query<SessionRow>(
    `select ${SESSION_COLUMNS} from sessions where id = $1`,
    [id],
  );
  const row = rows[0];
  return row ? sessionRowToRecord(row) : null;
}

export interface ListSessionsFilter {
  readonly projectId?: ProjectId | null;
  readonly status?: SessionStatus | null;
  /** Default true: the UI almost always wants live desks only. */
  readonly liveOnly?: boolean;
}

export async function listSessions(
  filter: ListSessionsFilter = {},
): Promise<readonly SessionRecord[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.projectId) {
    params.push(filter.projectId);
    where.push(`project_id = $${params.length}`);
  }
  if (filter.status) {
    params.push(filter.status);
    where.push(`status = $${params.length}`);
  } else if (filter.liveOnly !== false) {
    where.push(`status in ('starting', 'running')`);
  }
  const { rows } = await query<SessionRow>(
    `select ${SESSION_COLUMNS} from sessions
     ${where.length > 0 ? `where ${where.join(" and ")}` : ""}
     order by started_at desc, id`,
    params,
  );
  return rows.map(sessionRowToRecord);
}

// --- Transitions ----------------------------------------------------------------

async function applyTransition(
  client: PoolClient,
  id: SessionId,
  to: SessionStatus,
  extra: { claudeSessionId?: string; failure?: { kind: SessionFailureKind; reason: string } } = {},
): Promise<SessionRecord> {
  // FOR UPDATE: two concurrent kills, or a kill racing a SessionEnd handler,
  // must not both think they moved the row.
  const current = await client.query<SessionRow>(
    `select ${SESSION_COLUMNS} from sessions where id = $1 for update`,
    [id],
  );
  const row = current.rows[0];
  if (!row) throw new SessionError("not_found", `no session ${id}`);
  const from = row.status as SessionStatus;
  if (from === to) return sessionRowToRecord(row); // idempotent by design
  if (!isLegalSessionTransition(from, to)) {
    throw new IllegalSessionTransitionError(id, from, to);
  }

  const terminal = isTerminalSessionStatus(to);
  const updated = await client.query<SessionRow>(
    `update sessions
        set status = $2,
            ended_at = case when $3::boolean then now() else ended_at end,
            claude_session_id = coalesce($4, claude_session_id),
            failure_reason = coalesce($5, failure_reason)
      where id = $1
      returning ${SESSION_COLUMNS}`,
    [
      id,
      to,
      terminal,
      extra.claudeSessionId ?? null,
      extra.failure ? joinFailure(extra.failure.kind, extra.failure.reason) : null,
    ],
  );
  return sessionRowToRecord(updated.rows[0] as SessionRow);
}

/**
 * Emit AFTER the transaction commits, never inside it.
 *
 * This is the trap 012 shipped with and had to fix: an event emitted inside
 * a caller's transaction survives that caller's ROLLBACK, so subscribers see
 * a transition that did not happen. Every caller here commits first and then
 * announces.
 */
async function announce(
  type: string,
  session: SessionRecord,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await recordSystemEvent(
    type,
    { session_id: session.id, tmux_name: session.tmuxName, status: session.status, ...payload },
    session.claudeSessionId,
    session.projectId,
  );
}

// --- startSession ---------------------------------------------------------------

export interface StartSessionInput {
  readonly projectId: ProjectId;
  readonly projectSlug: string;
  readonly role: SessionRole;
  readonly dept: string;
  readonly owner: string;
  readonly backend: SessionBackend;
  readonly model: string;
  readonly modelReason: string;
  /** The first message the desk receives. Optional: 018 sends a brief, the UI may not. */
  readonly brief?: string;
  readonly cwd: string;
  /** Extra pane environment. NODE_EXTRA_CA_CERTS belongs here — ticket 009 decides the contents. */
  readonly env?: Readonly<Record<string, string>>;
  readonly claudeBin: string;
  /**
   * Overrides SESSION_HOOK_ARRIVAL_TIMEOUT_MS. Present so a test can drive
   * the hook gate without a new required environment variable, the same way
   * the lock registry takes `ttlSeconds` as a parameter rather than reading
   * config at the call site. Production leaves it unset.
   */
  readonly hookArrivalTimeoutMs?: number;
}

export interface StartSessionResult {
  readonly session: SessionRecord;
}

/**
 * IDENTITY CONFLICT: this ticket chose **conflict**, not reuse.
 *
 * The criterion says pick one and state which. Reuse is the friendlier
 * behaviour and the wrong one: two callers both believing they started a
 * desk is a bug that reuse hides and conflict surfaces, and the caller that
 * "started" a session it did not start will attribute someone else's work
 * and someone else's token spend to its own brief. A lead in a retry loop
 * would also silently reuse a desk that is mid-task.
 *
 * The partial unique index `sessions_one_live_per_identity` makes this an
 * invariant rather than a check-then-act race between two concurrent POSTs,
 * so the conflict is raised even when both arrive in the same millisecond.
 */
export async function startSession(input: StartSessionInput): Promise<StartSessionResult> {
  if (input.modelReason.trim() === "") {
    // Rejected here as well as by the column constraint: the design's Spawn
    // feed shows this reason next to every spawn, and a blank one would make
    // that feed lie about why an expensive model was chosen.
    throw new SessionError("invalid_request", "model_reason is required and must not be blank");
  }

  // TICKET 028 stub: the design says "the orchestrator refuses start_session
  // while paused". The pause flag does not exist until 028, so there is
  // nothing to read yet. 028 adds the check here; it is named rather than
  // silently absent.

  const hookArrivalTimeoutMs =
    input.hookArrivalTimeoutMs ?? loadSessionsConfig().hookArrivalTimeoutMs;
  const claudeSessionId = deps.newClaudeSessionId();

  // THE PER-SESSION CREDENTIAL (GLU-55). Minted here, in the same breath as
  // the claude session id, for the same reason: this is the one place that
  // knows a desk is being created, and the token has to exist before the
  // spawn because it travels in the pane environment.
  //
  // It is not built by `agentLaunchSpec` even though that function is "the
  // single source of truth for how an agent session is launched", and the
  // exception is worth stating: that spec is built once per *role* at
  // provisioning time, before any session exists, while this value is per
  // *session*. Spike 003 §6 proposed adding it to the spec's inputs; doing so
  // would mean rebuilding the spec at every spawn and giving provisioning a
  // token it must not have. So the spec declares the launch environment a
  // role shares, this merges the one variable only a spawn can know, and
  // `SESSION_TOKEN_ENV_VAR` keeps the two spellings from drifting.
  //
  // Only the hash is stored. Only the token is handed out, once, to one
  // process. Neither is ever logged — the announce calls below carry the
  // session record, which does not include it.
  const sessionToken = deps.newSessionToken();
  const tmuxName = sessionName({
    project: input.projectSlug,
    role: input.role,
    department: input.dept,
    owner: input.owner,
  });

  // 1. The row FIRST, so a crashed spawn still leaves evidence.
  let session: SessionRecord;
  try {
    const { rows } = await query<SessionRow>(
      `insert into sessions
         (project_id, tmux_name, role, dept, owner, backend, model, model_reason, claude_session_id, token_hash)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       returning ${SESSION_COLUMNS}`,
      [
        input.projectId,
        tmuxName,
        input.role,
        input.dept,
        input.owner,
        input.backend,
        input.model,
        input.modelReason,
        claudeSessionId,
        sessionToken.hash,
      ],
    );
    session = sessionRowToRecord(rows[0] as SessionRow);
  } catch (error) {
    // WHICH constraint fired matters, and an earlier version of this lost
    // that: it mapped every unique violation to `identity_conflict`, so a
    // tmux-name collision reported "that role is already staffed" and sent
    // the reader to the wrong place. The two are genuinely different:
    //
    //   one_live_per_identity  -> that (project, role, dept, owner) already
    //                             has a live desk. The caller asked for a
    //                             second one.
    //   one_live_per_tmux_name -> a live desk already answers to this
    //                             deterministic name. Since the name is
    //                             derived from the project SLUG rather than
    //                             its id, this is reachable when two
    //                             projects share a slug — which `projects`
    //                             makes unique, so in practice it means the
    //                             naming inputs collided and the second
    //                             desk's messages would have landed in the
    //                             first.
    const constraint = constraintOf(error);
    if (constraint === "sessions_one_live_per_identity") {
      throw new SessionError(
        "identity_conflict",
        `a live session already exists for (${input.projectId}, ${input.role}, ${input.dept}, ${input.owner}) — this ticket refuses rather than reusing it`,
      );
    }
    if (constraint === "sessions_one_live_per_tmux_name") {
      throw new SessionError(
        "identity_conflict",
        `a live session already answers to the tmux name ${tmuxName}. The name is derived from (project slug, role, dept, owner), so two desks would share a mailbox and messages for one would reach the other.`,
      );
    }
    throw error;
  }
  await announce("SessionRegistered", session, { role: input.role, model: input.model });

  // 2. Spawn. The session id is chosen by us and passed to the CLI, which is
  //    what makes correlation direct rather than a cwd heuristic (spike 001).
  //    The token goes in LAST and wins over anything the caller passed under
  //    the same name. A caller supplying its own OFFICE_SESSION_TOKEN is
  //    either confused or testing a forgery, and in both cases the desk must
  //    present the credential this row actually stores — otherwise the token
  //    in the pane and the hash in the database disagree and every tool call
  //    the desk makes is refused as `unknown`, which reads like a broken MCP
  //    server rather than a bad caller.
  const spawn = await deps.tmux.newSession({
    user: input.owner,
    name: tmuxName,
    cwd: input.cwd,
    command: [input.claudeBin, "--session-id", claudeSessionId],
    env: { ...input.env, [SESSION_TOKEN_ENV_VAR]: sessionToken.token },
  });
  if (!spawn.ok) {
    const failed = await fail(
      session.id,
      spawn.kind === "not_ready" ? "not_ready" : "spawn_failed",
      `${spawn.kind}: ${spawn.message}`,
    );
    return { session: failed };
  }

  // 3. THE HOOK GATE. Not running until an event proves hooks reach ingest.
  //    See property 2 in this file's header for why this is the important
  //    part: without it, an agent with no NODE_EXTRA_CA_CERTS looks healthy
  //    forever and reports nothing.
  const first = await deps.waitForFirstEvent(claudeSessionId, hookArrivalTimeoutMs);
  if (!first) {
    const kind = await diagnoseMissingHooks(session.startedAt);
    const failed = await fail(
      session.id,
      kind,
      kind === "hooks_handshake_rejected"
        ? `no event for session ${claudeSessionId} within ${hookArrivalTimeoutMs}ms, and a TLS handshake was rejected while this session was starting — most likely the agent's NODE_EXTRA_CA_CERTS is unset, or the certificate needs reissuing. The rejection cannot be attributed to this session directly: a failed handshake carries no session id.`
        : `no event for session ${claudeSessionId} within ${hookArrivalTimeoutMs}ms — hooks are not reaching ingest at all. Check the hook config was provisioned and the event server is up.`,
    );
    // The desk is alive but mute, and a mute desk is worse than none: it
    // would spend tokens nobody can see. Kill it.
    await deps.tmux.killSession(input.owner, tmuxName);
    return { session: failed };
  }

  const running = await withTransaction((client) =>
    applyTransition(client, session.id, "running", { claudeSessionId }),
  );
  await announce("SessionRunning", running, { ready_ms: spawn.value.readyMs });

  if (input.brief !== undefined && input.brief !== "") {
    await messageSession(running.id, input.brief, "orchestrator:brief");
  }
  return { session: (await getSession(running.id)) ?? running };
}

/**
 * Which hook failure this is. The remedies differ — a missing env var in
 * provisioning versus a certificate that needs reissuing — so the ticket
 * asks for them to be distinguished wherever 005's TLS logging makes that
 * possible. It does: 005 records a `TlsHandshakeRejected` system event.
 */
// SCOPED TO THIS SESSION'S OWN WINDOW, and that is not a detail. A rejected
// handshake carries no session id — it fails before any payload is read — so
// the only attribution available is time. The first version of this asked
// the whole `events` table for any rejection in the last five minutes, which
// is the global-state trap this repo keeps hitting: on a live box with
// several desks, one unrelated rejection would make every later session
// failure report "handshake rejected", including desks whose hooks were
// simply never provisioned. A confidently wrong diagnosis is worse than "no
// event arrived", because it sends someone to reissue a certificate that is
// fine. Caught by a test that found a rejection left behind by an earlier
// suite.
//
// Narrowing to "at or after this session started" still cannot prove the
// rejection was *this* desk's, so the message says a handshake was rejected
// *while this session was starting* rather than claiming it was ours. The
// inference is stated, not hidden.
async function diagnoseMissingHooks(startedAt: string): Promise<SessionFailureKind> {
  const { rows } = await query<{ count: string }>(
    `select count(*)::text as count
       from events
      where type = 'TlsHandshakeRejected'
        and received_at >= $1::timestamptz`,
    [startedAt],
  );
  return Number(rows[0]?.count ?? "0") > 0 ? "hooks_handshake_rejected" : "hooks_never_arrived";
}

async function fail(
  id: SessionId,
  kind: SessionFailureKind,
  reason: string,
): Promise<SessionRecord> {
  const failed = await withTransaction((client) =>
    applyTransition(client, id, "failed", { failure: { kind, reason } }),
  );
  await announce("SessionFailed", failed, { failure_kind: kind, failure_reason: reason });
  return failed;
}

/** The violated constraint's name, for a Postgres unique violation (23505). */
function constraintOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const pg = error as { code?: string; constraint?: string };
  if (pg.code !== "23505") return null;
  return pg.constraint ?? "";
}

// --- messageSession -------------------------------------------------------------

export interface MessageSessionResult {
  readonly delivered: boolean;
  readonly queuedMessageId: string;
  readonly byteLength: number | null;
}

/**
 * Queue durably, then try to drain. Both halves matter:
 *
 * The queue is durable because a restart between "the human pressed send"
 * and "the agent received it" must not silently lose the instruction, and
 * because `interruptSession` can only *discard* a pending message if the
 * message is somewhere we control.
 *
 * The drain refuses to deliver into a permission dialog. Spike 003 measured
 * the alternative and it is the worst finding in the spike: an ordinary chat
 * message delivered into a waiting dialog **approves it** — confirmed on the
 * target host 20/20, with the approved command's file left on disk. The
 * dialog ignores the text and the trailing Enter selects the highlighted
 * "1. Yes". That is the outcome the design's "do not build keystroke
 * injection to answer permission prompts" rule exists to prevent, reached
 * through the ordinary chat path with no injection feature anywhere.
 *
 * A refused message stays `pending`, so it goes out when the dialog clears
 * rather than being lost.
 */
export async function messageSession(
  id: SessionId,
  body: string,
  requestedBy: string,
): Promise<MessageSessionResult> {
  if (body === "") throw new SessionError("invalid_request", "message body is empty");

  const session = await getSession(id);
  if (!session) throw new SessionError("not_found", `no session ${id}`);
  if (isTerminalSessionStatus(session.status)) {
    throw new SessionError(
      "session_ended",
      `session ${id} is ${session.status}; nothing can be delivered to it`,
    );
  }

  const queued = await query<{ id: string }>(
    `insert into session_message_queue (session_id, body, requested_by)
     values ($1, $2, $3) returning id`,
    [id, body, requestedBy],
  );
  const queuedMessageId = (queued.rows[0] as { id: string }).id;
  await announce("SessionMessageQueued", session, {
    queued_message_id: queuedMessageId,
    requested_by: requestedBy,
    bytes: Buffer.byteLength(body, "utf8"),
  });

  const sent = await deps.tmux.sendMessage(session.owner, session.tmuxName, body);
  if (!sent.ok) {
    if (sent.kind === "blocked_by_dialog") {
      // Left `pending` deliberately: it goes out when the dialog clears.
      await announce("SessionMessageRefused", session, {
        queued_message_id: queuedMessageId,
        reason: sent.message,
      });
      throw new SessionError(
        "blocked_by_dialog",
        `a permission dialog is open on ${session.tmuxName}; delivering this message would answer it. The message is queued and will go out when the dialog clears.`,
        sent.message,
      );
    }
    await markDiscarded(queuedMessageId, `send failed: ${sent.kind}`);
    await announce("SessionMessageDiscarded", session, {
      queued_message_id: queuedMessageId,
      reason: sent.kind,
    });
    throw new SessionError("spawn_failed", `${sent.kind}: ${sent.message}`);
  }

  await query(
    `update session_message_queue set status = 'sent', sent_at = now() where id = $1`,
    [queuedMessageId],
  );
  await announce("SessionMessageSent", session, {
    queued_message_id: queuedMessageId,
    bytes: sent.value.byteLength,
  });
  return { delivered: true, queuedMessageId, byteLength: sent.value.byteLength };
}

async function markDiscarded(queuedMessageId: string, reason: string): Promise<void> {
  await query(
    `update session_message_queue
        set status = 'discarded', discard_reason = $2
      where id = $1 and status = 'pending'`,
    [queuedMessageId, reason],
  );
}

export async function pendingMessages(id: SessionId): Promise<readonly QueuedMessage[]> {
  const { rows } = await query<{
    id: string;
    session_id: string;
    body: string;
    requested_by: string;
    status: string;
    discard_reason: string | null;
    queued_at: string;
    sent_at: string | null;
  }>(
    `select id, session_id, body, requested_by, status, discard_reason,
            queued_at::text as queued_at, sent_at::text as sent_at
       from session_message_queue
      where session_id = $1 and status = 'pending'
      order by queued_at, id`,
    [id],
  );
  return rows.map((row) => ({
    id: row.id,
    sessionId: asSessionId(row.session_id),
    body: row.body,
    requestedBy: row.requested_by,
    status: row.status as QueuedMessage["status"],
    discardReason: row.discard_reason,
    queuedAt: row.queued_at,
    sentAt: row.sent_at,
  }));
}

// --- interruptSession -----------------------------------------------------------

export interface InterruptSessionResult {
  readonly session: SessionRecord;
  /** How many pending messages were dropped so the interrupt actually stops things. */
  readonly discarded: number;
}

/**
 * Escape the current turn, and DISCARD anything still pending.
 *
 * The discard is the point. Measured on the target 2026-10-07: a message
 * queued before Escape **still ran in 17 of 19 trials** and was discarded in
 * 2 — same host, same command, two behaviours. An interrupt that leaves a
 * ~90% chance of the next instruction executing anyway is not an interrupt,
 * and a UI reporting "stopped" while the queued message runs is worse than
 * one that admits what it does. Because this module owns the queue,
 * interrupting can mean *not sending*.
 *
 * The session stays `running`: Escape halts a turn, it does not end a
 * session. Verified on the target, 20/20, session alive every time.
 */
export async function interruptSession(
  id: SessionId,
  requestedBy: string,
): Promise<InterruptSessionResult> {
  const session = await getSession(id);
  if (!session) throw new SessionError("not_found", `no session ${id}`);
  if (isTerminalSessionStatus(session.status)) {
    throw new SessionError(
      "session_ended",
      `session ${id} is ${session.status}; there is nothing to interrupt`,
    );
  }

  const { rows: dropped } = await query<{ id: string }>(
    `update session_message_queue
        set status = 'discarded', discard_reason = $2
      where session_id = $1 and status = 'pending'
      returning id`,
    [id, `interrupted by ${requestedBy}`],
  );

  const escaped = await deps.tmux.sendEscape(session.owner, session.tmuxName);
  if (!escaped.ok) {
    throw new SessionError("spawn_failed", `${escaped.kind}: ${escaped.message}`);
  }

  await announce("SessionInterrupted", session, {
    requested_by: requestedBy,
    discarded_messages: dropped.length,
  });
  for (const row of dropped) {
    await announce("SessionMessageDiscarded", session, {
      queued_message_id: row.id,
      reason: "interrupted",
    });
  }
  return { session, discarded: dropped.length };
}

// --- killSession ----------------------------------------------------------------

/**
 * Kill tmux and mark the row `ended`. Idempotent: a second call returns the
 * already-ended row rather than failing, because the caller's intent —
 * "this desk should not be running" — is satisfied either way, and the UI
 * must not show an error for succeeding twice.
 */
export async function killSession(id: SessionId, requestedBy: string): Promise<SessionRecord> {
  const session = await getSession(id);
  if (!session) throw new SessionError("not_found", `no session ${id}`);
  if (isTerminalSessionStatus(session.status)) return session;

  await query(
    `update session_message_queue
        set status = 'discarded', discard_reason = $2
      where session_id = $1 and status = 'pending'`,
    [id, `session killed by ${requestedBy}`],
  );

  // A tmux session that is already gone is success, not failure — someone
  // may have run `tmux kill-session` by hand, which is the case the
  // SessionEnd handler below also covers.
  const killed = await deps.tmux.killSession(session.owner, session.tmuxName);
  if (!killed.ok && killed.kind !== "not_found" && killed.kind !== "no_server") {
    throw new SessionError("spawn_failed", `${killed.kind}: ${killed.message}`);
  }

  const ended = await withTransaction((client) => applyTransition(client, id, "ended"));
  await announce("SessionEnded", ended, { requested_by: requestedBy, reason: "killed" });
  return ended;
}

// --- Correlation, called by the event handler -----------------------------------

/**
 * A SessionStart arrived. Attach the id and, if the desk was still
 * `starting`, this is the proof its hooks work.
 *
 * Note a tmux session is not one claude session: ids are single-use and
 * `/clear` rotates them, so this runs more than once per row and must
 * tolerate a succession. The row keeps the *current* id; ticket 010 models
 * the history.
 */
export async function onSessionStart(claudeSessionId: string): Promise<SessionRecord | null> {
  const { rows } = await query<SessionRow>(
    `select ${SESSION_COLUMNS} from sessions
      where claude_session_id = $1 and status in ('starting', 'running')
      limit 1`,
    [claudeSessionId],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.status === "running") return sessionRowToRecord(row);
  const running = await withTransaction((client) =>
    applyTransition(client, asSessionId(row.id), "running", { claudeSessionId }),
  );
  await announce("SessionRunning", running, { via: "SessionStart" });
  return running;
}

/**
 * A SessionEnd arrived.
 *
 * **`reason: "clear"` must NOT end the row.** SessionEnd does not mean the
 * agent stopped: it fires on `/clear` while the agent keeps working, and
 * ending the record there would kill a live desk's row and leave an orphan
 * tmux session nobody is tracking. Observed reasons: `clear`, `other`,
 * `prompt_input_exit`. Source: docs/spikes/001-hook-payloads.md.
 *
 * This is also the path that catches a kill from outside the orchestrator —
 * someone running `tmux kill-session` by hand.
 */
export const SESSION_END_REASONS_THAT_DO_NOT_END = ["clear"] as const;

export async function onSessionEnd(
  claudeSessionId: string,
  reason: string | null,
): Promise<SessionRecord | null> {
  if (reason !== null && (SESSION_END_REASONS_THAT_DO_NOT_END as readonly string[]).includes(reason)) {
    return null;
  }
  const { rows } = await query<SessionRow>(
    `select ${SESSION_COLUMNS} from sessions
      where claude_session_id = $1 and status in ('starting', 'running')
      limit 1`,
    [claudeSessionId],
  );
  const row = rows[0];
  if (!row) return null;

  await query(
    `update session_message_queue
        set status = 'discarded', discard_reason = $2
      where session_id = $1 and status = 'pending'`,
    [row.id, `session ended (${reason ?? "unknown"})`],
  );
  const ended = await withTransaction((client) =>
    applyTransition(client, asSessionId(row.id), "ended"),
  );
  await announce("SessionEnded", ended, { reason: reason ?? "unknown", via: "SessionEnd" });
  return ended;
}

/** Asserted against the SQL check constraint by a test. */
export const SESSION_STATUS_VOCABULARY = SESSION_STATUSES;
