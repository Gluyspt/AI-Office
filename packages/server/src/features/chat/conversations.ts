// Conversation and segment resolution: which continuous history a desk's
// traffic belongs to, and where one segment of it ends and the next begins.
//
// Ticket 010. The decision this file implements:
//
//   "A conversation belongs to a task or to a role slot; sessions are
//    segments within it. Role slots are first-class — leads never have
//    tasks. The human sees continuous history, the agent does not remember
//    it, and the UI must not imply otherwise."
//
// WHY SEGMENTS ARE FORCED, not chosen. A tmux session is not one claude
// session: ids are single-use (relaunching with one already seen exits 1,
// `already in use`) and `/clear` *ends* the claude session and rotates the
// id while the agent keeps working. 0003_sessions.sql keeps only the
// current id on the registry row and says explicitly that the succession is
// this ticket's to model. `/compact`, by contrast, does **not** rotate the
// id — so compaction is invisible here and a clear is a boundary.
// Source: docs/spikes/001-hook-payloads.md §3, §5.
//
// WHAT THIS FILE DELIBERATELY DOES NOT DO
//
//  * It does not decide who may read or write a conversation. Permissions
//    are step 9; `author` and `owner` are recorded and never checked, the
//    same way 0003 treats session_message_queue.requested_by.
//
//  * It does not discover a session's task. **Nothing in the schema links a
//    session to a task** — 0003 has no task_id column and `claim_task` is
//    ticket 017 — so a task id can only arrive from a caller that already
//    knows it (`taskId` on the input below; the HTTP routes accept it, and
//    018/017 can pass it when they exist). A worker desk whose task nobody
//    told us about therefore lands in its *desk's* role-slot conversation.
//    That is an honest gap, reported as one, not a model.
import type { PoolClient } from "pg";
import {
  type ConversationRecord,
  type ConversationSegmentRecord,
  type ConversationSubject,
  type SegmentEndReason,
  type SegmentStartReason,
  inferSegmentEndReason,
} from "@office/shared/chat";
import type { SessionRecord, SessionStatus } from "@office/shared/sessions";
import { asProjectId, asSessionId, asTaskId, type ProjectId, type TaskId } from "@office/shared/ids";
import { query, withTransaction } from "../../core/db/pool.ts";
import { recordSystemEvent } from "../events/ingest.ts";
import { SESSION_COLUMNS, sessionRowToRecord } from "@office/shared/sessions";

// --- Row mapping ----------------------------------------------------------------
//
// TIMESTAMP TRAP, the sixth sighting in this repo. `timestamptz` -> JS
// `Date` loses microseconds, so any timestamp that must *match* a stored
// value cannot round-trip through a Date. Every timestamp below is read as
// TEXT and kept as a string all the way to the client. The same comment is
// in tasks/states.ts, tasks/repo.ts, events/ingest.ts and
// orchestrator/sessions.ts — and in tasks/repo.ts it is attached to a paging
// cursor exactly like this ticket's. (This ticket's cursor sidesteps the
// trap by carrying no timestamp at all; see transcript.ts.)

export const CONVERSATION_COLUMNS = `
  id,
  project_id,
  subject_kind,
  task_id,
  dept,
  role,
  owner,
  created_at::text as created_at
`;

interface ConversationRow {
  id: string;
  project_id: string;
  subject_kind: string;
  task_id: string | null;
  dept: string | null;
  role: string | null;
  owner: string | null;
  created_at: string;
}

function toConversation(row: ConversationRow): ConversationRecord {
  return {
    id: row.id,
    projectId: asProjectId(row.project_id),
    subjectKind: row.subject_kind as ConversationRecord["subjectKind"],
    taskId: row.task_id === null ? null : asTaskId(row.task_id),
    dept: row.dept,
    role: row.role,
    owner: row.owner,
    createdAt: row.created_at,
  };
}

export const SEGMENT_COLUMNS = `
  id,
  conversation_id,
  session_id,
  claude_session_id,
  ordinal,
  owner,
  model,
  start_reason,
  end_reason,
  restored_from_handoff,
  started_at::text as started_at,
  ended_at::text as ended_at
`;

interface SegmentRow {
  id: string;
  conversation_id: string;
  session_id: string;
  claude_session_id: string | null;
  ordinal: number;
  owner: string;
  model: string | null;
  start_reason: string;
  end_reason: string | null;
  restored_from_handoff: boolean;
  started_at: string;
  ended_at: string | null;
  /** Only present on the listing query, which derives it with `lag()`. */
  previous_end_reason?: string | null;
}

function toSegment(row: SegmentRow): ConversationSegmentRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    sessionId: asSessionId(row.session_id),
    claudeSessionId: row.claude_session_id,
    ordinal: row.ordinal,
    owner: row.owner,
    model: row.model,
    startReason: row.start_reason as SegmentStartReason,
    endReason: row.end_reason as SegmentEndReason | null,
    previousEndReason: (row.previous_end_reason ?? null) as SegmentEndReason | null,
    restoredFromHandoff: row.restored_from_handoff,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

/** Structurally compatible with the (unexported) SessionRow in
 *  orchestrator/sessions.ts, so `sessionRowToRecord` can be reused rather
 *  than this file growing a second copy of that mapping. */
interface SessionRowShape {
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

// --- Correlation ------------------------------------------------------------------

/**
 * The desk a hook payload belongs to, found by the claude session id on the
 * payload.
 *
 * **No status filter**, unlike 008's `onSessionStart` / `onSessionEnd`.
 * Those two are driving a lifecycle and must only move a live row; this is
 * attributing a *message*, and a `Stop` that arrives after the desk ended
 * still has somewhere it belongs. Dropping it because the row is already
 * `ended` would lose the last thing the agent said, which is usually the
 * most interesting thing it said.
 *
 * `order by started_at desc` because 0003 deliberately has no unique index
 * on `claude_session_id`: "two rows could legitimately have held the same id
 * at different times if one is replayed from history". The newest wins.
 */
export async function findSessionByClaudeSessionId(
  claudeSessionId: string,
): Promise<SessionRecord | null> {
  const { rows } = await query<SessionRowShape>(
    `select ${SESSION_COLUMNS} from sessions
      where claude_session_id = $1
      order by started_at desc, id
      limit 1`,
    [claudeSessionId],
  );
  const row = rows[0];
  return row ? sessionRowToRecord(row) : null;
}

// --- Subjects ----------------------------------------------------------------------

/**
 * Which conversation a desk's traffic belongs to.
 *
 * A task id, when the caller has one, always wins — that is the criterion
 * "resolves by task id where the session has a task". Otherwise the desk's
 * role slot, which for a lead is the design's "project + department + role"
 * and here also carries `owner`; see the long comment in
 * db/migrations/0004_conversations.sql for why the fourth column is there
 * and why it changes nothing for the case the decision is about.
 */
export function conversationSubjectForSession(
  session: SessionRecord,
  taskId: TaskId | null = null,
): ConversationSubject {
  if (taskId !== null) {
    return { kind: "task", projectId: session.projectId, taskId };
  }
  return {
    kind: "role_slot",
    projectId: session.projectId,
    dept: session.dept,
    role: session.role,
    owner: session.owner,
  };
}

/**
 * Resolve or create the conversation for a subject.
 *
 * `on conflict do nothing` plus a re-select, rather than check-then-insert:
 * hooks registered in one group fire *concurrently* (measured — in 19 of 20
 * samples an http hook's POST arrived before a command hook had even
 * started), so two events racing to create the same conversation is the
 * normal case under load, not a rare interleaving. The two partial unique
 * indexes in 0004 are what make this safe; this function only has to not
 * fight them.
 */
export async function resolveConversation(
  subject: ConversationSubject,
): Promise<ConversationRecord> {
  const values =
    subject.kind === "task"
      ? [subject.projectId, "task", subject.taskId, null, null, null]
      : [subject.projectId, "role_slot", null, subject.dept, subject.role, subject.owner];

  const inserted = await query<ConversationRow>(
    `insert into conversations (project_id, subject_kind, task_id, dept, role, owner)
     values ($1, $2, $3, $4, $5, $6)
     on conflict do nothing
     returning ${CONVERSATION_COLUMNS}`,
    values,
  );
  const row = inserted.rows[0];
  if (row) return toConversation(row);

  const existing = await findConversationBySubject(subject);
  if (!existing) {
    // Reachable only if the insert was refused by a constraint that is not
    // one of the two uniqueness rules — say the subject-shape check. A loud
    // error beats returning a conversation that is not the asked-for one.
    throw new Error(
      `conversation for ${JSON.stringify(subject)} could neither be created nor found`,
    );
  }
  return existing;
}

export async function findConversationBySubject(
  subject: ConversationSubject,
): Promise<ConversationRecord | null> {
  const { rows } =
    subject.kind === "task"
      ? await query<ConversationRow>(
          `select ${CONVERSATION_COLUMNS} from conversations
            where subject_kind = 'task' and task_id = $1`,
          [subject.taskId],
        )
      : await query<ConversationRow>(
          `select ${CONVERSATION_COLUMNS} from conversations
            where subject_kind = 'role_slot'
              and project_id = $1 and dept = $2 and role = $3 and owner = $4`,
          [subject.projectId, subject.dept, subject.role, subject.owner],
        );
  const row = rows[0];
  return row ? toConversation(row) : null;
}

export async function getConversation(id: string): Promise<ConversationRecord | null> {
  const { rows } = await query<ConversationRow>(
    `select ${CONVERSATION_COLUMNS} from conversations where id = $1`,
    [id],
  );
  const row = rows[0];
  return row ? toConversation(row) : null;
}

// --- Segments -----------------------------------------------------------------------

export interface OpenSegmentInput {
  readonly session: SessionRecord;
  /** The claude session this segment is. Null when a human speaks before the
   *  desk has reported any hook event carrying an id. */
  readonly claudeSessionId: string | null;
  readonly startReason?: SegmentStartReason;
  /** Supplied by a caller that knows the task; see the file header's gap note. */
  readonly taskId?: TaskId | null;
  /** Always false in steps 1-3 — handoffs are steps 4 and 5. */
  readonly restoredFromHandoff?: boolean;
  /** `SessionEnd.reason` for the segment this one replaces, when it is known. */
  readonly previousReportedReason?: string | null;
}

export interface ResolvedSegment {
  readonly conversation: ConversationRecord;
  readonly segment: ConversationSegmentRecord;
  /** False when an existing segment was reused or adopted. */
  readonly created: boolean;
}

/**
 * Find the segment for this claude session, or open a new one — closing the
 * conversation's previous segment if one is still open.
 *
 * MUST NOT be called inside a caller's transaction. It opens its own, and it
 * emits its events *after* that transaction commits. An event emitted inside
 * a caller's transaction survives the caller's ROLLBACK, so subscribers
 * would see a segment boundary that did not happen — the bug ticket 012
 * shipped with and 008 documents the fix for.
 */
export async function openOrResumeSegment(input: OpenSegmentInput): Promise<ResolvedSegment> {
  // Fast path, outside any transaction: the overwhelmingly common case is a
  // segment that already exists, because every event of a turn arrives
  // under the same claude session id.
  if (input.claudeSessionId !== null) {
    const found = await findSegmentByClaudeSessionId(input.claudeSessionId);
    if (found) {
      const conversation = await getConversation(found.conversationId);
      if (conversation) return { conversation, segment: found, created: false };
    }
  }

  const conversation = await resolveConversation(
    conversationSubjectForSession(input.session, input.taskId ?? null),
  );

  const outcome = await withTransaction(async (client) => {
    // Serialise segment creation per conversation. The partial unique index
    // `conversation_segments_one_open` would catch a double-open anyway, but
    // it would catch it as a constraint violation inside a hook handler —
    // and this path has to be reliable, not merely safe.
    await client.query(`select id from conversations where id = $1 for update`, [conversation.id]);

    if (input.claudeSessionId !== null) {
      const again = await selectSegment(
        client,
        `claude_session_id = $1`,
        [input.claudeSessionId],
      );
      if (again) return { segment: again, created: false, closed: null };
    }

    const open = await selectSegment(
      client,
      `conversation_id = $1 and end_reason is null`,
      [conversation.id],
    );

    if (open) {
      const sameDesk = open.sessionId === input.session.id;

      // The human spoke first and the desk has now reported its id: adopt
      // the segment rather than opening a second one, or the first message
      // of a conversation would sit in a segment of its own forever.
      if (sameDesk && open.claudeSessionId === null && input.claudeSessionId !== null) {
        const adopted = await adoptSegment(client, open.id, {
          claudeSessionId: input.claudeSessionId,
          startReason: input.startReason ?? open.startReason,
          model: input.session.model,
        });
        return { segment: adopted, created: false, closed: null };
      }

      // Same desk, no new id to attach: this *is* the live segment.
      if (sameDesk && input.claudeSessionId === null) {
        return { segment: open, created: false, closed: null };
      }

      const previousSessionStatus = await statusOfSession(client, open.sessionId);
      const reason = inferSegmentEndReason({
        sameDesk,
        previousSessionStatus,
        previousModel: open.model,
        newModel: input.session.model,
        reportedReason: input.previousReportedReason ?? null,
      });
      const closed = await closeSegmentIn(client, open.id, reason);
      const segment = await insertSegment(client, conversation.id, input);
      return { segment, created: true, closed };
    }

    const segment = await insertSegment(client, conversation.id, input);
    return { segment, created: true, closed: null };
  });

  // After the commit, never inside it.
  if (outcome.closed) {
    await announceSegment("ConversationSegmentClosed", conversation, outcome.closed, {
      end_reason: outcome.closed.endReason,
    });
  }
  if (outcome.created) {
    await announceSegment("ConversationSegmentOpened", conversation, outcome.segment, {
      ordinal: outcome.segment.ordinal,
      start_reason: outcome.segment.startReason,
      previous_end_reason: outcome.closed?.endReason ?? null,
      restored_from_handoff: outcome.segment.restoredFromHandoff,
    });
  }

  return { conversation, segment: outcome.segment, created: outcome.created };
}

async function selectSegment(
  client: PoolClient,
  where: string,
  params: readonly unknown[],
): Promise<ConversationSegmentRecord | null> {
  const { rows } = await client.query<SegmentRow>(
    `select ${SEGMENT_COLUMNS} from conversation_segments where ${where} limit 1`,
    params as unknown[],
  );
  const row = rows[0];
  return row ? toSegment(row) : null;
}

export async function findSegmentByClaudeSessionId(
  claudeSessionId: string,
): Promise<ConversationSegmentRecord | null> {
  const { rows } = await query<SegmentRow>(
    `select ${SEGMENT_COLUMNS} from conversation_segments
      where claude_session_id = $1`,
    [claudeSessionId],
  );
  const row = rows[0];
  return row ? toSegment(row) : null;
}

async function statusOfSession(client: PoolClient, sessionId: string): Promise<SessionStatus> {
  const { rows } = await client.query<{ status: string }>(
    `select status from sessions where id = $1`,
    [sessionId],
  );
  // A missing row cannot happen (the FK cascades), but `running` is the
  // conservative default: it yields `replaced` rather than claiming a crash.
  return (rows[0]?.status ?? "running") as SessionStatus;
}

async function insertSegment(
  client: PoolClient,
  conversationId: string,
  input: OpenSegmentInput,
): Promise<ConversationSegmentRecord> {
  const { rows } = await client.query<SegmentRow>(
    `insert into conversation_segments
       (conversation_id, session_id, claude_session_id, ordinal, owner, model,
        start_reason, restored_from_handoff)
     values ($1, $2, $3,
             (select coalesce(max(ordinal), 0) + 1 from conversation_segments where conversation_id = $1),
             $4, $5, $6, $7)
     returning ${SEGMENT_COLUMNS}`,
    [
      conversationId,
      input.session.id,
      input.claudeSessionId,
      input.session.owner,
      input.session.model,
      input.startReason ?? "unknown",
      input.restoredFromHandoff ?? false,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error("insert into conversation_segments returned no row");
  return toSegment(row);
}

async function adoptSegment(
  client: PoolClient,
  segmentId: string,
  patch: { claudeSessionId: string; startReason: SegmentStartReason; model: string | null },
): Promise<ConversationSegmentRecord> {
  const { rows } = await client.query<SegmentRow>(
    `update conversation_segments
        set claude_session_id = $2,
            start_reason = $3,
            model = coalesce(model, $4)
      where id = $1
      returning ${SEGMENT_COLUMNS}`,
    [segmentId, patch.claudeSessionId, patch.startReason, patch.model],
  );
  const row = rows[0];
  if (!row) throw new Error(`segment ${segmentId} vanished while being adopted`);
  return toSegment(row);
}

async function closeSegmentIn(
  client: PoolClient,
  segmentId: string,
  reason: SegmentEndReason,
): Promise<ConversationSegmentRecord | null> {
  const { rows } = await client.query<SegmentRow>(
    `update conversation_segments
        set end_reason = $2, ended_at = now()
      where id = $1 and end_reason is null
      returning ${SEGMENT_COLUMNS}`,
    [segmentId, reason],
  );
  const row = rows[0];
  return row ? toSegment(row) : null;
}

/**
 * Close a segment with a reason the caller knows.
 *
 * The seam ticket 028 (pause: `paused`) and ticket 017 (task completion:
 * `completed`) call, so the divider can say something better than
 * `unknown`. Idempotent: closing an already-closed segment returns null
 * rather than overwriting the first reason, because the first reason is the
 * true one.
 */
export async function closeSegment(
  segmentId: string,
  reason: SegmentEndReason,
): Promise<ConversationSegmentRecord | null> {
  const { rows } = await query<SegmentRow>(
    `update conversation_segments
        set end_reason = $2, ended_at = now()
      where id = $1 and end_reason is null
      returning ${SEGMENT_COLUMNS}`,
    [segmentId, reason],
  );
  const row = rows[0];
  if (!row) return null;
  const segment = toSegment(row);
  const conversation = await getConversation(segment.conversationId);
  if (conversation) {
    await announceSegment("ConversationSegmentClosed", conversation, segment, {
      end_reason: reason,
    });
  }
  return segment;
}

/**
 * Every segment of a conversation, oldest first, each carrying why the one
 * before it ended.
 *
 * `previous_end_reason` is derived with `lag()` rather than stored on the
 * successor: one source of truth, so the divider cannot disagree with the
 * segment it describes.
 */
export async function listSegments(
  conversationId: string,
): Promise<readonly ConversationSegmentRecord[]> {
  const { rows } = await query<SegmentRow>(
    `select ${SEGMENT_COLUMNS},
            lag(end_reason) over (partition by conversation_id order by ordinal)
              as previous_end_reason
       from conversation_segments
      where conversation_id = $1
      order by ordinal`,
    [conversationId],
  );
  return rows.map(toSegment);
}

/** The conversation's open segment, if it has one. */
export async function currentSegment(
  conversationId: string,
): Promise<ConversationSegmentRecord | null> {
  const { rows } = await query<SegmentRow>(
    `select ${SEGMENT_COLUMNS} from conversation_segments
      where conversation_id = $1 and end_reason is null`,
    [conversationId],
  );
  const row = rows[0];
  return row ? toSegment(row) : null;
}

/** The newest segment of a conversation, open or closed. What an outbound
 *  message falls back to when the caller named no session. */
export async function latestSegment(
  conversationId: string,
): Promise<ConversationSegmentRecord | null> {
  const { rows } = await query<SegmentRow>(
    `select ${SEGMENT_COLUMNS} from conversation_segments
      where conversation_id = $1
      order by ordinal desc
      limit 1`,
    [conversationId],
  );
  const row = rows[0];
  return row ? toSegment(row) : null;
}

// --- Announcing -------------------------------------------------------------------

/**
 * `project_id` is load-bearing and is passed on every call.
 *
 * Ticket 006's bus filters subscriptions on that column, so an event without
 * it reaches no board and no chat panel — a gap that cost ticket 013 a
 * TaskCreated event invisible to exactly the subscriber it existed for. The
 * session id passed is the CLAUDE session id, because that is what
 * `events.session_id` holds and therefore what a session-scoped subscription
 * matches on.
 */
async function announceSegment(
  type: string,
  conversation: ConversationRecord,
  segment: ConversationSegmentRecord,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await recordSystemEvent(
    type,
    {
      conversation_id: conversation.id,
      segment_id: segment.id,
      session_id: segment.sessionId,
      claude_session_id: segment.claudeSessionId,
      subject_kind: conversation.subjectKind,
      ...extra,
    },
    segment.claudeSessionId,
    conversation.projectId satisfies ProjectId,
  );
}
