// The transcript itself: append, mark delivery, read backwards with paging,
// and keep what could not be attributed.
//
// Ticket 010.
//
// ORDERING COMES FROM A SEQUENCE, NOT FROM THE CLOCK. The target host's
// wall clock was observed stepping *backwards* twice in one session (two
// measured durations of -494 ms and -100 ms, impossible by construction),
// and `now()` is transaction-start time, so two rows written in one
// transaction share it exactly. A transcript ordered by `created_at` would
// therefore reorder itself across a clock step, and the criterion "50
// interleaved inbound and outbound writes read back in send order" would be
// a coin flip. `chat_messages.seq` is a bigserial: monotonic in assignment
// order, clock-independent.
//
// THE PAGING CURSOR, AND THE TRAP IT AVOIDS BY CONSTRUCTION. This repo has
// hit `timestamptz` -> JS `Date` microsecond loss five times, and one of the
// casualties was a paging cursor exactly like this one (see the comment on
// `listTasks` in features/tasks/repo.ts: Postgres keeps microseconds,
// `Date` keeps milliseconds, so feeding a truncated value back as
// `created_at > $1` re-matches the row it came from). The fix those took was
// to read the column as text. This cursor does something stronger: it
// carries **no timestamp at all**. `seq` is an integer, there is nothing to
// truncate, and no tiebreaker column is needed because a sequence value is
// already unique. `created_at` is read as `::text` anyway — house style, and
// the client renders it — but nothing orders or pages on it.
//
// One pg detail that matters: `bigserial` is `int8`, and node-postgres hands
// `int8` back as a **string** to avoid silent precision loss. Every read
// below converts explicitly; nothing relies on `==`.
import {
  type ChatDirection,
  type ChatMessageRecord,
  type OutboundDeliveryStatus,
  type TranscriptPage,
} from "@office/shared/chat";
import { asSessionId, type ProjectId, type SessionId } from "@office/shared/ids";
import { query } from "../../core/db/pool.ts";
import { recordSystemEvent } from "../events/ingest.ts";

// --- Row mapping ----------------------------------------------------------------

export const MESSAGE_COLUMNS = `
  id,
  conversation_id,
  session_id,
  segment_id,
  direction,
  author,
  body,
  turn_id,
  delivery_status,
  delivery_detail,
  queued_message_id,
  seq::text as seq,
  created_at::text as created_at
`;

interface MessageRow {
  id: string;
  conversation_id: string;
  session_id: string;
  segment_id: string;
  direction: string;
  author: string;
  body: string;
  turn_id: string | null;
  delivery_status: string | null;
  delivery_detail: string | null;
  queued_message_id: string | null;
  /** `seq::text` — int8 arrives as a string from node-postgres anyway; the
   *  cast makes that explicit rather than depending on driver behaviour. */
  seq: string;
  created_at: string;
}

function toMessage(row: MessageRow): ChatMessageRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    sessionId: asSessionId(row.session_id),
    segmentId: row.segment_id,
    direction: row.direction as ChatDirection,
    author: row.author,
    body: row.body,
    turnId: row.turn_id,
    deliveryStatus: row.delivery_status as OutboundDeliveryStatus | null,
    deliveryDetail: row.delivery_detail,
    queuedMessageId: row.queued_message_id,
    seq: Number(row.seq),
    createdAt: row.created_at,
  };
}

// --- Cursor ---------------------------------------------------------------------
//
// base64url, matching the house style of features/tasks/repo.ts so a client
// treats it as opaque and nothing ends up parsing it. The payload is just
// the sequence number — see the header for why that is the whole point.

const CURSOR_PREFIX = "seq:";

export function encodeCursor(seq: number | string): string {
  return Buffer.from(`${CURSOR_PREFIX}${seq}`, "utf8").toString("base64url");
}

/** Returns the decimal sequence value as a string (it is an int8; it is
 *  never arithmetic here), or null when the cursor is not one of ours. */
export function decodeCursor(raw: string): string | null {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (!decoded.startsWith(CURSOR_PREFIX)) return null;
  const seq = decoded.slice(CURSOR_PREFIX.length);
  return /^\d+$/.test(seq) ? seq : null;
}

export class TranscriptCursorError extends Error {
  constructor(raw: string) {
    super(
      `before is not a valid cursor: ${JSON.stringify(raw)} — pass back the ` +
        `next_before value from a previous page, unmodified`,
    );
    this.name = "TranscriptCursorError";
  }
}

// --- Append -----------------------------------------------------------------------

export interface AppendMessageInput {
  readonly conversationId: string;
  readonly segmentId: string;
  /** The desk (ticket 008's registry row id). */
  readonly sessionId: SessionId;
  /** Needed for the event, not for the row: ticket 006's bus filters on it. */
  readonly projectId: ProjectId;
  /** The claude session id of the segment — what `events.session_id` holds. */
  readonly claudeSessionId: string | null;
  readonly direction: ChatDirection;
  readonly author: string;
  readonly body: string;
  readonly turnId: string | null;
  /** Required for `outbound`, must be null for `inbound` (SQL enforces it). */
  readonly deliveryStatus?: OutboundDeliveryStatus | null;
  readonly deliveryDetail?: string | null;
  readonly queuedMessageId?: string | null;
}

export interface AppendMessageResult {
  readonly message: ChatMessageRecord;
  /**
   * False when the row already existed. Only one case produces it: a second
   * `Stop` for a turn that already has a reply, which the partial unique
   * index `chat_messages_one_reply_per_turn` refuses. Nothing dedupes hook
   * POSTs — a `command` hook is a shell script a human could re-run — so
   * the criterion "appends exactly one inbound message" needs the index,
   * and the caller needs to know the second call was a no-op so it does not
   * announce the same message twice.
   */
  readonly inserted: boolean;
}

/**
 * Append one message and announce it.
 *
 * Takes no `PoolClient` on purpose. The announcement must happen *after* the
 * write commits, and an event emitted inside a caller's transaction survives
 * that caller's ROLLBACK — subscribers would see a message that does not
 * exist. That is the bug ticket 012 shipped with; 008 documents the fix and
 * this file follows it by making the in-a-transaction call impossible rather
 * than merely discouraged.
 */
export async function appendMessage(input: AppendMessageInput): Promise<AppendMessageResult> {
  const { rows } = await query<MessageRow>(
    `insert into chat_messages
       (conversation_id, session_id, segment_id, direction, author, body, turn_id,
        delivery_status, delivery_detail, queued_message_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict do nothing
     returning ${MESSAGE_COLUMNS}`,
    [
      input.conversationId,
      input.sessionId,
      input.segmentId,
      input.direction,
      input.author,
      input.body,
      input.turnId,
      input.deliveryStatus ?? null,
      input.deliveryDetail ?? null,
      input.queuedMessageId ?? null,
    ],
  );

  const row = rows[0];
  if (!row) {
    const existing = await findReplyForTurn(input.segmentId, input.turnId);
    if (!existing) {
      // The insert was refused by something other than the one-reply-per-turn
      // index — a check constraint, most likely an empty body or a delivery
      // status that does not match the direction. Loud, because silently
      // dropping a message is the one thing this ticket must not do.
      throw new Error(
        `chat message for conversation ${input.conversationId} was neither inserted nor found; ` +
          `direction=${input.direction} turn_id=${String(input.turnId)}`,
      );
    }
    return { message: existing, inserted: false };
  }

  const message = toMessage(row);
  await announce("ChatMessageAppended", message, input.projectId, input.claudeSessionId);
  return { message, inserted: true };
}

async function findReplyForTurn(
  segmentId: string,
  turnId: string | null,
): Promise<ChatMessageRecord | null> {
  if (turnId === null) return null;
  const { rows } = await query<MessageRow>(
    `select ${MESSAGE_COLUMNS} from chat_messages
      where segment_id = $1 and turn_id = $2 and direction = 'inbound'`,
    [segmentId, turnId],
  );
  const row = rows[0];
  return row ? toMessage(row) : null;
}

// --- Delivery ---------------------------------------------------------------------

/**
 * Update an outbound message's delivery marker.
 *
 * The outbound flow is: record `pending` -> attempt delivery -> mark the
 * outcome. That order is the criterion — "recorded **before** delivery, so a
 * message that fails to deliver is still visible in the transcript with a
 * failed marker" — and it is also the only order that survives the server
 * dying mid-send.
 */
export async function markOutboundDelivery(
  messageId: string,
  status: OutboundDeliveryStatus,
  options: {
    readonly detail?: string | null;
    readonly queuedMessageId?: string | null;
    readonly projectId: ProjectId;
    readonly claudeSessionId: string | null;
  },
): Promise<ChatMessageRecord | null> {
  const { rows } = await query<MessageRow>(
    `update chat_messages
        set delivery_status = $2,
            delivery_detail = $3,
            queued_message_id = coalesce($4, queued_message_id)
      where id = $1 and direction = 'outbound'
      returning ${MESSAGE_COLUMNS}`,
    [messageId, status, options.detail ?? null, options.queuedMessageId ?? null],
  );
  const row = rows[0];
  if (!row) return null;
  const message = toMessage(row);
  await announce("ChatMessageDelivery", message, options.projectId, options.claudeSessionId);
  return message;
}

// --- Read -------------------------------------------------------------------------

export interface ReadMessagesParams {
  readonly conversationId: string;
  /** Opaque cursor from a previous page's `nextBefore`. Omit for the newest page. */
  readonly before?: string | null;
  readonly limit: number;
}

/**
 * One page of a conversation, newest page first, walking backwards.
 *
 * Segment boundaries are irrelevant to the paging: `seq` is
 * conversation-wide, so "pages backwards across segment boundaries without
 * gaps or duplicates" is a property of the key, not of a join. Each page is
 * returned oldest-first, because that is the order the panel renders.
 */
export async function readMessages(params: ReadMessagesParams): Promise<TranscriptPage> {
  let before: string | null = null;
  if (params.before !== undefined && params.before !== null && params.before !== "") {
    before = decodeCursor(params.before);
    if (before === null) throw new TranscriptCursorError(params.before);
  }

  const { rows } = await query<MessageRow>(
    `select ${MESSAGE_COLUMNS} from chat_messages
      where conversation_id = $1
        and ($2::bigint is null or seq < $2::bigint)
      order by seq desc
      limit $3`,
    [params.conversationId, before, params.limit],
  );

  // Newest-first off the index, reversed in memory for display. Reversing a
  // page of <= `limit` rows is cheaper than a subquery, and keeps the index
  // scan (conversation_id, seq desc) exactly as 0004 declares it.
  const newestFirst = rows.map(toMessage);
  const messages = [...newestFirst].reverse();
  const oldest = newestFirst[newestFirst.length - 1];
  const nextBefore =
    oldest !== undefined && rows.length === params.limit ? encodeCursor(oldest.seq) : null;
  return { messages, nextBefore };
}

/** Every message of a conversation, oldest first. For tests and for the
 *  spine verification; the panel always pages. */
export async function readAllMessages(
  conversationId: string,
): Promise<readonly ChatMessageRecord[]> {
  const { rows } = await query<MessageRow>(
    `select ${MESSAGE_COLUMNS} from chat_messages
      where conversation_id = $1
      order by seq asc`,
    [conversationId],
  );
  return rows.map(toMessage);
}

export async function getMessage(id: string): Promise<ChatMessageRecord | null> {
  const { rows } = await query<MessageRow>(
    `select ${MESSAGE_COLUMNS} from chat_messages where id = $1`,
    [id],
  );
  const row = rows[0];
  return row ? toMessage(row) : null;
}

// --- Orphans ------------------------------------------------------------------------

export interface OrphanedReplyInput {
  /** The `events` row ingest already persisted — the payload is intact there too. */
  readonly eventId: string;
  readonly claudeSessionId: string | null;
  readonly payload: unknown;
  /** The extracted reply text, when the payload had one. */
  readonly body: string | null;
  readonly reason: string;
}

export interface OrphanedReplyRecord {
  readonly id: string;
  readonly eventId: string;
  readonly claudeSessionId: string | null;
  readonly body: string | null;
  readonly reason: string;
  readonly receivedAt: string;
}

/**
 * Keep a reply that matched no desk — "stored as orphaned with its payload
 * intact, and logged — never dropped, never crashed on".
 *
 * Logged twice on purpose, to two different audiences: `console.warn` for
 * whoever is tailing the server, and a `ChatReplyOrphaned` event for the UI.
 * The event carries a **null project id**, unavoidably: without a desk there
 * is no project to attribute it to, so a project-scoped subscriber will not
 * see it. That is a real limitation of the orphan path rather than the
 * `project_id`-is-load-bearing mistake — there is genuinely no project to
 * put there.
 */
export async function recordOrphanedReply(
  input: OrphanedReplyInput,
): Promise<OrphanedReplyRecord | null> {
  console.warn(
    `[chat] orphaned reply: ${input.reason} ` +
      `(claude_session_id=${String(input.claudeSessionId)}, event=${input.eventId})`,
  );
  // Two independent best-effort steps, not one. The row and the event are
  // different audiences (an operator reading the table, a UI reading the
  // bus), and losing one must not cost the other. The orphan path is the
  // last line of defence; it must not be the thing that throws. The payload
  // survives in `events` regardless, which is why losing either of these is
  // survivable and crashing ingest would not be.
  let stored: OrphanedReplyRecord | null = null;
  try {
    const { rows } = await query<{
      id: string;
      event_id: string;
      claude_session_id: string | null;
      body: string | null;
      reason: string;
      received_at: string;
    }>(
      `insert into orphaned_replies (event_id, claude_session_id, payload, body, reason)
       values ($1, $2, $3::jsonb, $4, $5)
       returning id, event_id, claude_session_id, body, reason,
                 received_at::text as received_at`,
      [
        input.eventId,
        input.claudeSessionId,
        JSON.stringify(input.payload ?? null),
        input.body,
        input.reason,
      ],
    );
    const row = rows[0];
    if (row) {
      stored = {
        id: row.id,
        eventId: row.event_id,
        claudeSessionId: row.claude_session_id,
        body: row.body,
        reason: row.reason,
        receivedAt: row.received_at,
      };
    }
  } catch (error) {
    console.error("[chat] failed to store an orphaned reply", error);
  }

  try {
    await recordSystemEvent(
      "ChatReplyOrphaned",
      {
        claude_session_id: input.claudeSessionId,
        event_id: input.eventId,
        reason: input.reason,
        has_body: input.body !== null,
        stored: stored !== null,
      },
      input.claudeSessionId,
      null,
    );
  } catch (error) {
    console.error("[chat] failed to announce an orphaned reply", error);
  }

  return stored;
}

export async function listOrphanedReplies(limit = 100): Promise<readonly OrphanedReplyRecord[]> {
  const { rows } = await query<{
    id: string;
    event_id: string;
    claude_session_id: string | null;
    body: string | null;
    reason: string;
    received_at: string;
  }>(
    `select id, event_id, claude_session_id, body, reason, received_at::text as received_at
       from orphaned_replies
      order by received_at desc, id
      limit $1`,
    [limit],
  );
  return rows.map((row) => ({
    id: row.id,
    eventId: row.event_id,
    claudeSessionId: row.claude_session_id,
    body: row.body,
    reason: row.reason,
    receivedAt: row.received_at,
  }));
}

// --- Announcing ---------------------------------------------------------------------

/**
 * `project_id` on every announcement, and the CLAUDE session id as the
 * event's session id.
 *
 * Both are load-bearing for ticket 006's bus: it filters subscriptions on
 * `events.project_id` and `events.session_id`, so an event missing either
 * reaches no chat panel watching that desk or that board. The body rides
 * along in the payload so a subscribed client renders the message without a
 * refetch — the event store already holds whole file bodies from
 * `PostToolUse`, so a chat line is not what changes its retention question.
 */
async function announce(
  type: string,
  message: ChatMessageRecord,
  projectId: ProjectId,
  claudeSessionId: string | null,
): Promise<void> {
  await recordSystemEvent(
    type,
    {
      message_id: message.id,
      conversation_id: message.conversationId,
      segment_id: message.segmentId,
      session_id: message.sessionId,
      claude_session_id: claudeSessionId,
      direction: message.direction,
      author: message.author,
      body: message.body,
      turn_id: message.turnId,
      delivery_status: message.deliveryStatus,
      delivery_detail: message.deliveryDetail,
      seq: message.seq,
      created_at: message.createdAt,
    },
    claudeSessionId,
    projectId,
  );
}
