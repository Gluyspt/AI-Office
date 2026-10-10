// The transcript: messages, the boundaries between sessions, and the tool
// activity that happened between them.
//
// Ticket 026.
//
//
// THE DIVIDER IS THE POINT OF THIS FILE
// --------------------------------------
// A conversation belongs to a task or a role slot and **sessions are
// segments within it**. The human scrolls one continuous history across a
// `/clear`, a pause, a model switch and a crash; the agent above the line
// remembers none of it. So every segment change renders as a labelled
// boundary saying *why the desk restarted* and *that nothing above it is in
// the agent's head*. A seamless join would be a lie with consequences: it is
// what makes someone write "as we discussed" to an agent that has never
// heard of it.
//
// `restored_from_handoff` is false for every segment in build steps 1-3 —
// handoffs are the knowledge graph, build step 5, and 028's handoff step is a
// named seam that no-ops with a warning. The divider therefore says context
// was NOT carried over. It renders the restored wording too, because the
// column exists and will one day be true, but nothing produces it yet.
//
//
// ORDERING, AND WHY ACTIONS ARE ANCHORED TO A TURN RATHER THAN A CLOCK
// ---------------------------------------------------------------------
// Messages order by `seq`, a conversation-wide sequence — not by time, because
// the target host's wall clock was observed stepping backwards twice in one
// session (ticket 010's header). Recent actions have no `seq`: they are hook
// events. Interleaving them by timestamp would put them in an order the same
// broken clock decides.
//
// They do carry `prompt_id`, and so does every agent reply — so an action
// group sits immediately before the reply of the turn it belongs to, which is
// where it happened (tools run during a turn, the reply ends it). Actions for
// a turn with no reply yet sit at the tail, which is exactly the "the agent is
// working" signal the panel otherwise has no source for.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  ChatMessageRecord,
  ConversationSegmentRecord,
  SegmentEndReason,
} from "@office/shared/chat";
import type { LocalMessage, RecentAction } from "./useAgentChat.ts";

// --- Divider copy ---------------------------------------------------------------

/**
 * Why the previous session ended, in words a person can act on.
 *
 * Every value of `SEGMENT_END_REASONS` has an entry and a test asserts the
 * map is exhaustive, because a missing one would render an empty divider —
 * the one shape this file exists to prevent. `null` is a real case: a segment
 * whose predecessor nobody recorded.
 */
export const SEGMENT_END_TEXT: Readonly<Record<SegmentEndReason, string>> = {
  cleared: "its context was cleared with /clear",
  exited: "the desk exited",
  completed: "the task was completed",
  paused: "the work was paused",
  crash: "the desk crashed",
  model_switch: "it was restarted on a different model",
  replaced: "another desk took over the slot",
  unknown: "nobody recorded why",
};

export function segmentEndText(reason: SegmentEndReason | null): string {
  return reason === null ? "nobody recorded why" : SEGMENT_END_TEXT[reason];
}

export interface DividerCopy {
  readonly title: string;
  readonly why: string;
  /** The load-bearing sentence. Never softened. */
  readonly memory: string;
  readonly handoff: string;
}

export function dividerCopy(segment: ConversationSegmentRecord | null): DividerCopy {
  const restored = segment?.restoredFromHandoff === true;
  return {
    title: "New session",
    why: `The previous session ended — ${segmentEndText(segment?.previousEndReason ?? null)}.`,
    // Said plainly, every time. The human has continuous history; the agent
    // below this line started empty.
    memory: "The agent below does not remember anything above this line.",
    handoff: restored
      ? "Context was restored from a handoff."
      : "No handoff was restored, so nothing above was carried over.",
  };
}

// --- Rows ------------------------------------------------------------------------

export type TranscriptRow =
  | {
      readonly kind: "divider";
      readonly key: string;
      readonly segmentId: string;
      readonly segment: ConversationSegmentRecord | null;
    }
  | { readonly kind: "message"; readonly key: string; readonly message: ChatMessageRecord }
  | {
      readonly kind: "actions";
      readonly key: string;
      readonly turnId: string | null;
      readonly actions: readonly RecentAction[];
    }
  | { readonly kind: "local"; readonly key: string; readonly local: LocalMessage };

export interface BuildRowsInput {
  readonly messages: readonly ChatMessageRecord[];
  readonly locals: readonly LocalMessage[];
  readonly segments: readonly ConversationSegmentRecord[];
  readonly actions: readonly RecentAction[];
  readonly showActions: boolean;
  /** True while older pages remain. Suppresses the top divider, because the
   *  boundary is not known to be where the loaded window happens to start. */
  readonly hasMore: boolean;
}

export function buildTranscriptRows(input: BuildRowsInput): TranscriptRow[] {
  const segmentById = new Map(input.segments.map((segment) => [segment.id, segment]));

  const actionsByTurn = new Map<string, RecentAction[]>();
  const untargetedActions: RecentAction[] = [];
  if (input.showActions) {
    for (const action of input.actions) {
      if (action.turnId === null) {
        untargetedActions.push(action);
        continue;
      }
      const bucket = actionsByTurn.get(action.turnId) ?? [];
      bucket.push(action);
      actionsByTurn.set(action.turnId, bucket);
    }
  }

  const rows: TranscriptRow[] = [];
  let previousSegmentId: string | null = null;

  for (const [index, message] of input.messages.entries()) {
    const boundary = previousSegmentId !== null && message.segmentId !== previousSegmentId;
    const topOfKnownHistory = index === 0 && !input.hasMore;
    const segment = segmentById.get(message.segmentId) ?? null;

    if (
      boundary ||
      // At the very top of a fully loaded conversation, a segment that had a
      // predecessor still gets its divider — the restart happened, even though
      // the messages before it are not on screen (a desk can restart without
      // having said anything).
      (topOfKnownHistory && segment !== null && segment.previousEndReason !== null)
    ) {
      rows.push({
        kind: "divider",
        key: `divider-${message.segmentId}`,
        segmentId: message.segmentId,
        segment,
      });
    }

    // Tool calls of this turn ran before the reply that ends it.
    const turnId = message.turnId;
    if (turnId !== null) {
      const pending = actionsByTurn.get(turnId);
      if (pending !== undefined) {
        rows.push({ kind: "actions", key: `actions-${turnId}`, turnId, actions: pending });
        actionsByTurn.delete(turnId);
      }
    }

    rows.push({ kind: "message", key: message.id, message });
    previousSegmentId = message.segmentId;
  }

  // Turns still in flight, and anything with no turn at all, at the tail.
  for (const [turnId, pending] of actionsByTurn) {
    rows.push({ kind: "actions", key: `actions-${turnId}`, turnId, actions: pending });
  }
  if (untargetedActions.length > 0) {
    rows.push({
      kind: "actions",
      key: "actions-untargeted",
      turnId: null,
      actions: untargetedActions,
    });
  }

  for (const local of input.locals) {
    rows.push({ kind: "local", key: local.localId, local });
  }

  return rows;
}

// --- Scrolling -------------------------------------------------------------------

export interface ScrollMetrics {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/** Within `slack` pixels of the bottom counts as "reading the live end". */
export function isNearBottom(metrics: ScrollMetrics, slack = 48): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= slack;
}

/**
 * Where to put `scrollTop` after older messages were prepended, so the
 * message the user was looking at stays under their eyes.
 *
 * The invariant is the distance from the *bottom*: the content above grew, so
 * keeping `scrollTop` would show different text, and keeping the top anchored
 * is what makes a backfill feel like the page jumped.
 */
export function scrollTopAfterPrepend(
  before: ScrollMetrics,
  nextScrollHeight: number,
): number {
  const fromBottom = before.scrollHeight - before.scrollTop;
  return Math.max(0, nextScrollHeight - fromBottom);
}

/** Pixels from the top that trigger a backfill. Deliberately generous: a
 *  backfill that only fires at exactly 0 never fires on a trackpad. */
export const BACKFILL_THRESHOLD_PX = 64;

function metricsOf(element: HTMLElement): ScrollMetrics {
  return {
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  };
}

/**
 * How many of these messages are newer than the newest one already seen.
 *
 * Counted by `seq`, not by list length, because the list also grows at the
 * *top* when older history backfills — and a backfill is not three new
 * messages arriving. `seq` is the conversation-wide ordering key, so "newer"
 * is a fact rather than an inference about where in the array a row landed.
 */
export function countArrivals(
  messages: readonly ChatMessageRecord[],
  previousNewestSeq: number,
): number {
  let count = 0;
  for (const message of messages) if (message.seq > previousNewestSeq) count += 1;
  return count;
}

// --- Small renderers ---------------------------------------------------------------

/**
 * `created_at` arrives as Postgres text (`2026-10-10 12:34:56.789+00`) and is
 * kept as a string end to end, because a `timestamptz` that round-trips
 * through a JS `Date` loses microseconds — this repo has been bitten six
 * times. Rendering it still wants a short local time, so parse for display
 * only and fall back to the raw value rather than ever printing
 * "Invalid Date".
 */
export function formatMessageTime(raw: string): string {
  if (raw === "") return "";
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  return parsed.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** What the delivery marker says, and whether it offers a retry.
 *
 * `queued` is the one that must not be softened. Ticket 008 refuses to
 * deliver into an open permission dialog because a message delivered there
 * **approves the pending tool call** (confirmed on the target, 20/20) — and
 * nothing re-drains that queue when the dialog clears. So a queued message
 * needs a human to send it again, and the panel says exactly that instead of
 * implying it is on its way. */
export const DELIVERY_TEXT = {
  pending: "sending…",
  delivered: "delivered to the agent's terminal",
  queued:
    "not delivered — the agent had a permission dialog open. Nothing will re-send it: send it again once the dialog is cleared.",
  failed: "failed to deliver",
} as const;

function MessageBubble({
  message,
  onResend,
}: {
  readonly message: ChatMessageRecord;
  readonly onResend: (body: string) => void;
}): React.ReactElement {
  const status = message.deliveryStatus;
  const retryable = status === "failed" || status === "queued";
  return (
    <article
      className="chat-message"
      data-direction={message.direction}
      data-delivery={status ?? undefined}
      data-message-id={message.id}
    >
      <header className="chat-message__head">
        {/* Every message is attributed. The author string is the server's,
            rendered verbatim — an agent reads `agent:dept_lead:dev`, a human
            reads their own name. */}
        <span className="chat-message__author">{message.author}</span>
        <span className="chat-message__role">
          {message.direction === "inbound" ? "agent" : "human"}
        </span>
        <time className="chat-message__time" dateTime={message.createdAt}>
          {formatMessageTime(message.createdAt)}
        </time>
      </header>

      {/* TEXT, NOT MARKUP. React escapes this; nothing in this feature uses
          dangerouslySetInnerHTML, so a reply containing a script tag is
          displayed literally. `white-space: pre-wrap` keeps the agent's own
          line breaks without interpreting anything. */}
      <p className="chat-message__body">{message.body}</p>

      {status !== null ? (
        <footer className="chat-message__delivery" data-delivery-status={status}>
          <span>{DELIVERY_TEXT[status]}</span>
          {message.deliveryDetail !== null ? (
            <span className="chat-message__detail">{message.deliveryDetail}</span>
          ) : null}
          {retryable ? (
            <button
              type="button"
              className="chat-link"
              onClick={() => onResend(message.body)}
            >
              Send again
            </button>
          ) : null}
        </footer>
      ) : null}
    </article>
  );
}

function LocalBubble({
  local,
  onRetry,
}: {
  readonly local: LocalMessage;
  readonly onRetry: (localId: string) => void;
}): React.ReactElement {
  return (
    <article
      className="chat-message chat-message--local"
      data-direction="outbound"
      data-delivery={local.status === "failed" ? "failed" : "pending"}
      data-local-id={local.localId}
    >
      <header className="chat-message__head">
        <span className="chat-message__author">{local.author}</span>
        <span className="chat-message__role">human</span>
      </header>
      <p className="chat-message__body">{local.body}</p>
      <footer className="chat-message__delivery" data-delivery-status={local.status}>
        <span>
          {local.status === "pending"
            ? DELIVERY_TEXT.pending
            : "not recorded — the server did not accept it"}
        </span>
        {local.detail !== null ? (
          <span className="chat-message__detail">{local.detail}</span>
        ) : null}
        {local.status === "failed" ? (
          <button type="button" className="chat-link" onClick={() => onRetry(local.localId)}>
            Retry
          </button>
        ) : null}
      </footer>
    </article>
  );
}

/** Tool activity. Subordinate by construction: no bubble, no attribution
 *  line, smaller type, and collapsible as a group. */
function ActionGroup({ actions }: { readonly actions: readonly RecentAction[] }) {
  const [expanded, setExpanded] = useState(false);
  const VISIBLE = 3;
  const shown = expanded ? actions : actions.slice(-VISIBLE);
  const hidden = actions.length - shown.length;

  return (
    <div className="chat-actions" aria-label="Recent actions">
      {hidden > 0 ? (
        <button
          type="button"
          className="chat-link chat-actions__more"
          aria-expanded={expanded}
          onClick={() => setExpanded(true)}
        >
          +{hidden} earlier actions
        </button>
      ) : null}
      {expanded && actions.length > VISIBLE ? (
        <button
          type="button"
          className="chat-link chat-actions__more"
          aria-expanded={expanded}
          onClick={() => setExpanded(false)}
        >
          show fewer actions
        </button>
      ) : null}
      <ul className="chat-actions__list">
        {shown.map((action) => (
          <li className="chat-action" key={action.id} data-tool={action.tool}>
            <span className="chat-action__tool">{action.tool}</span>
            {action.detail !== null ? (
              <span className="chat-action__detail">{action.detail}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function SegmentDivider({
  segment,
}: {
  readonly segment: ConversationSegmentRecord | null;
}): React.ReactElement {
  const copy = dividerCopy(segment);
  return (
    <div className="chat-divider" role="separator" data-segment-id={segment?.id ?? "unknown"}>
      <div className="chat-divider__rule" aria-hidden="true" />
      <div className="chat-divider__body">
        <p className="chat-divider__title">{copy.title}</p>
        <p className="chat-divider__why">{copy.why}</p>
        <p className="chat-divider__memory">{copy.memory}</p>
        <p className="chat-divider__handoff">{copy.handoff}</p>
      </div>
    </div>
  );
}

// --- The list ----------------------------------------------------------------------

export interface ChatTranscriptProps {
  readonly messages: readonly ChatMessageRecord[];
  readonly locals: readonly LocalMessage[];
  readonly segments: readonly ConversationSegmentRecord[];
  readonly actions: readonly RecentAction[];
  readonly showActions: boolean;
  readonly hasMore: boolean;
  readonly loadingOlder: boolean;
  readonly loading: boolean;
  readonly onLoadOlder: () => void;
  readonly onRetryLocal: (localId: string) => void;
  readonly onResend: (body: string) => void;
}

export function ChatTranscript({
  messages,
  locals,
  segments,
  actions,
  showActions,
  hasMore,
  loadingOlder,
  loading,
  onLoadOlder,
  onRetryLocal,
  onResend,
}: ChatTranscriptProps): React.ReactElement {
  const scroller = useRef<HTMLDivElement | null>(null);
  const atBottom = useRef(true);
  const beforePrepend = useRef<ScrollMetrics | null>(null);
  const [unread, setUnread] = useState(0);

  const rows = useMemo(
    () =>
      buildTranscriptRows({ messages, locals, segments, actions, showActions, hasMore }),
    [messages, locals, segments, actions, showActions, hasMore],
  );

  const jumpToBottom = useCallback(() => {
    const element = scroller.current;
    if (element === null) return;
    element.scrollTop = element.scrollHeight;
    atBottom.current = true;
    setUnread(0);
  }, []);

  const requestOlder = useCallback(() => {
    const element = scroller.current;
    // Captured BEFORE the fetch, used after the rows grow — see
    // scrollTopAfterPrepend.
    if (element !== null) beforePrepend.current = metricsOf(element);
    onLoadOlder();
  }, [onLoadOlder]);

  const onScroll = useCallback(() => {
    const element = scroller.current;
    if (element === null) return;
    const current = metricsOf(element);
    atBottom.current = isNearBottom(current);
    if (atBottom.current) setUnread(0);
    if (current.scrollTop <= BACKFILL_THRESHOLD_PX && hasMore && !loadingOlder) {
      requestOlder();
    }
  }, [hasMore, loadingOlder, requestOlder]);

  // Prepend restoration runs before paint, so the jump is never visible.
  const firstMessageId = messages[0]?.id ?? null;
  useLayoutEffect(() => {
    const element = scroller.current;
    const before = beforePrepend.current;
    if (element === null || before === null) return;
    beforePrepend.current = null;
    element.scrollTop = scrollTopAfterPrepend(before, element.scrollHeight);
  }, [firstMessageId]);

  // New arrivals: follow the live end only if the reader is already there.
  // Yanking the view out from under someone reading history is the thing this
  // guard exists to prevent; the count is the affordance instead.
  const newestSeq = messages[messages.length - 1]?.seq ?? null;
  const seenSeq = useRef<number | null>(null);
  useEffect(() => {
    if (newestSeq === null) return;
    const previous = seenSeq.current;
    seenSeq.current = newestSeq;
    if (previous === null) {
      // First page: the newest message belongs on screen.
      jumpToBottom();
      return;
    }
    if (newestSeq <= previous) return; // a backfill, or a delivery update
    if (atBottom.current) {
      const element = scroller.current;
      if (element !== null) element.scrollTop = element.scrollHeight;
      return;
    }
    const arrived = countArrivals(messages, previous);
    if (arrived > 0) setUnread((count) => count + arrived);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `messages` is
    // read from the same render as `newestSeq`; keying on the array identity
    // would run this on every delivery update too.
  }, [newestSeq, jumpToBottom]);

  // A message the user just typed always follows to the bottom: they are
  // looking at the composer, not at history.
  const localCount = locals.length;
  const seenLocals = useRef(localCount);
  useEffect(() => {
    const grew = localCount > seenLocals.current;
    seenLocals.current = localCount;
    if (grew) jumpToBottom();
  }, [localCount, jumpToBottom]);

  return (
    <div className="chat-transcript">
      <div
        className="chat-transcript__scroll"
        ref={scroller}
        onScroll={onScroll}
        role="log"
        aria-label="Conversation"
        aria-live="polite"
      >
        {/* A real button as well as the scroll trigger: a keyboard user never
            reaches a scroll handler, and in a short conversation there is no
            scrollbar to drag. */}
        {hasMore ? (
          <div className="chat-transcript__top">
            <button
              type="button"
              className="chat-link"
              onClick={requestOlder}
              disabled={loadingOlder}
            >
              {loadingOlder ? "Loading earlier messages…" : "Load earlier messages"}
            </button>
          </div>
        ) : null}

        {!hasMore && !loading && messages.length > 0 ? (
          <p className="chat-transcript__start">The start of this conversation.</p>
        ) : null}

        {loading && messages.length === 0 ? (
          <p className="chat-transcript__empty">Loading the conversation…</p>
        ) : null}

        {!loading && messages.length === 0 && locals.length === 0 ? (
          <p className="chat-transcript__empty">
            Nothing has been said in this conversation yet. You can speak first.
          </p>
        ) : null}

        {rows.map((row) => {
          if (row.kind === "divider") return <SegmentDivider key={row.key} segment={row.segment} />;
          if (row.kind === "actions") return <ActionGroup key={row.key} actions={row.actions} />;
          if (row.kind === "local") {
            return <LocalBubble key={row.key} local={row.local} onRetry={onRetryLocal} />;
          }
          return <MessageBubble key={row.key} message={row.message} onResend={onResend} />;
        })}
      </div>

      {unread > 0 ? (
        <button type="button" className="chat-transcript__unread" onClick={jumpToBottom}>
          {unread === 1 ? "1 new message" : `${unread} new messages`} — jump to the end
        </button>
      ) : null}
    </div>
  );
}
