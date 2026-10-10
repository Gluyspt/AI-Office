// Chat state: resolve the conversation, load its history, subscribe to live
// messages, send one and watch what happens to it.
//
// Ticket 026. The three endpoints this talks to are ticket 010's
// (packages/server/src/features/chat/routes/chat.ts), and the record shapes
// come from `@office/shared/chat` — nothing here redeclares a message or a
// segment.
//
//
// THE MODEL THIS FILE MUST NOT MISREPRESENT
// ------------------------------------------
// A conversation belongs to a task or to a role slot; **sessions are
// segments within it**. The human sees one continuous history across pause,
// resume, a model switch and a crash — and the agent does *not* remember any
// of it. So the segment list is loaded with every page and handed to the
// transcript, which draws a labelled boundary at each change. A panel that
// renders a seamless join is lying about what the agent knows.
//
// `restored_from_handoff` is `false` for every segment in build steps 1-3:
// handoff nodes are the knowledge graph, which is step 5. The UI says so
// rather than implying context came across.
//
//
// WHY TWO SOCKETS, AND NOT ONE
// -----------------------------
// Live updates come from two event families with incompatible filters:
//
//   * **Chat and segment events** carry `project_id` and, as the event's
//     session id, the *claude* session id of the segment they belong to
//     (see transcript.ts's `announce`). Filtering them by claude session id
//     would mean the panel stops updating the moment `/clear` rotates that
//     id — which is exactly the silently-stale failure this app cares most
//     about. So they are watched by **project**, and matched to this
//     conversation by `conversation_id` in the payload.
//
//   * **Hook events** (`PreToolUse`, the "recent actions" stream) have
//     `project_id` NULL by construction — "nothing in a hook payload
//     identifies a project" (events/ingest.ts) — so a project subscription
//     can never see one. They are watched by **claude session id**.
//
// The server supports several subscriptions per socket (routes/ws.ts keeps
// an array of them), but ticket 022's `openEventStream` sends exactly one
// subscribe frame per socket and `lib/ws.ts` is not this ticket's file. Two
// streams is the honest cost of that; a later ticket that teaches the client
// to carry a list of filters collapses it to one, with no change here beyond
// deleting a call.
//
//
// THE DEPENDENCY-ARRAY FOOTGUN
// -----------------------------
// Injected functions and the target object are identity-unstable at the call
// site, and putting either in an effect's dependency array makes this hook
// loop forever — found in ticket 023 by a test *hanging* rather than
// failing. `useBoard` solved it by holding the injected deps behind a ref
// and keying effects on a serialised string; this file does the same, for
// the same reason.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type {
  ChatMessageRecord,
  ChatDirection,
  ConversationRecord,
  ConversationSegmentRecord,
  OutboundDeliveryStatus,
} from "@office/shared/chat";
import type { SessionId } from "@office/shared/ids";
import type { SessionRecord } from "@office/shared/sessions";
import { ApiError, apiRequest, type StoredEvent } from "../../lib/api.ts";
import { openEventStream, type ConnectionStatus } from "../../lib/ws.ts";

// --- What the panel is open on ------------------------------------------------

/**
 * Either a desk or a conversation.
 *
 * `session` is the normal way in: `GET /sessions/:id/conversation` resolves
 * the desk's conversation **and creates it if absent**, which is deliberate
 * on the server's side — a human must be able to open a panel on a desk that
 * has not spoken yet and send the first message.
 *
 * `conversation` exists because the transcript endpoint is keyed by
 * conversation and a caller that already has one (a task detail page, a
 * notification) should not have to find a desk first. Sending still works:
 * the server falls back to the conversation's newest segment's session.
 *
 * `taskId` is passed through because **nothing in the schema links a session
 * to a task** — 0003 has no `task_id` column — so the caller that knows it
 * is the only source there is.
 */
export type ChatTarget =
  | {
      readonly kind: "session";
      readonly sessionId: string;
      readonly taskId?: string | null;
    }
  | { readonly kind: "conversation"; readonly conversationId: string };

/** A string identity for a target, for effect keys and draft storage. */
export function chatTargetKey(target: ChatTarget | null): string {
  if (target === null) return "";
  return target.kind === "session"
    ? `session:${target.sessionId}:${target.taskId ?? ""}`
    : `conversation:${target.conversationId}`;
}

// --- Opening the panel from anywhere ------------------------------------------
//
// The overlay convention (022) gives a feature a mounted panel and no way for
// another feature to open it, so this is the seam: a module-level store with
// one open target. Ticket 027's controls and 031's task detail page call
// `openChatPanel`; neither needs to edit a file this ticket owns, and the
// shell stays unaware the chat panel exists.
//
// A singleton rather than a React context because the opener is usually not a
// child of the overlay — 022's OverlayHost mounts overlays beside the page
// outlet, not around it. `closeChatPanel()` is the test reset.

let openTarget: ChatTarget | null = null;
const targetListeners = new Set<() => void>();

function notifyTargetListeners(): void {
  // Copied before iterating: a listener may unsubscribe during the walk.
  for (const listener of [...targetListeners]) listener();
}

export function openChatPanel(target: ChatTarget): void {
  openTarget = target;
  notifyTargetListeners();
}

export function closeChatPanel(): void {
  if (openTarget === null) return;
  openTarget = null;
  notifyTargetListeners();
}

export function currentChatTarget(): ChatTarget | null {
  return openTarget;
}

export function useChatTarget(): ChatTarget | null {
  return useSyncExternalStore(
    (onStoreChange) => {
      targetListeners.add(onStoreChange);
      return () => {
        targetListeners.delete(onStoreChange);
      };
    },
    currentChatTarget,
    currentChatTarget,
  );
}

// --- The API, over 022's client -----------------------------------------------
//
// `apiRequest` is ticket 022's own fetch wrapper, re-exported by lib/api.ts.
// Reusing it keeps one definition of the base path, of https-only, and of how
// a 4xx body becomes an ApiError — rather than adding a second HTTP client
// inside a feature, or editing api.ts, which is 022's file.

export interface ConversationBundle {
  readonly conversation: ConversationRecord;
  readonly segments: readonly ConversationSegmentRecord[];
  readonly current_segment: ConversationSegmentRecord | null;
}

export function resolveSessionConversation(
  sessionId: string,
  taskId?: string | null,
): Promise<ConversationBundle> {
  const query = taskId ? `?task_id=${encodeURIComponent(taskId)}` : "";
  return apiRequest<ConversationBundle>(
    `/sessions/${encodeURIComponent(sessionId)}/conversation${query}`,
  );
}

export interface TranscriptPageResponse {
  readonly conversation: ConversationRecord;
  readonly segments: readonly ConversationSegmentRecord[];
  /** Oldest first within the page, however the page was reached. */
  readonly messages: readonly ChatMessageRecord[];
  /** Pass back as `before` for the page before this one. Null at the start. */
  readonly next_before: string | null;
}

export function fetchTranscriptPage(
  conversationId: string,
  params: { readonly before?: string | null; readonly limit: number },
): Promise<TranscriptPageResponse> {
  const query = new URLSearchParams({ limit: String(params.limit) });
  if (params.before) query.set("before", params.before);
  return apiRequest<TranscriptPageResponse>(
    `/conversations/${encodeURIComponent(conversationId)}/messages?${query.toString()}`,
  );
}

/** `GET /sessions/:id` — the desk behind the header. */
export type DeskInfo = SessionRecord & {
  readonly pending_messages?: readonly unknown[];
};

export function fetchDesk(sessionId: string): Promise<DeskInfo> {
  return apiRequest<DeskInfo>(`/sessions/${encodeURIComponent(sessionId)}`);
}

/**
 * The result of a send, with the one property the panel cannot do without:
 * **the recorded message comes back even when delivery failed.**
 *
 * The server records outbound messages *before* attempting delivery and puts
 * the row in the response body on both paths — 202 on delivered or queued,
 * 4xx/5xx with `{ error, kind, message }` otherwise. So a failure is not a
 * reason to drop the bubble the panel already drew: "a message that vanished
 * is indistinguishable from one the agent ignored, and that is the panel's
 * worst failure".
 */
export interface SendResult {
  readonly ok: boolean;
  readonly message: ChatMessageRecord | null;
  readonly error: string | null;
}

export async function postChatMessage(
  conversationId: string,
  input: { readonly body: string; readonly author: string; readonly sessionId?: string | null },
): Promise<SendResult> {
  const payload = {
    body: input.body,
    author: input.author,
    ...(input.sessionId ? { session_id: input.sessionId } : {}),
  };
  try {
    const response = await apiRequest<{ readonly message?: ChatMessageRecord }>(
      `/conversations/${encodeURIComponent(conversationId)}/messages`,
      { method: "POST", body: JSON.stringify(payload) },
    );
    return { ok: true, message: response.message ?? null, error: null };
  } catch (cause) {
    if (cause instanceof ApiError) {
      const body = cause.body as
        | { readonly message?: ChatMessageRecord; readonly error?: string }
        | null;
      return {
        ok: false,
        message: body?.message ?? null,
        error: body?.error ?? cause.message,
      };
    }
    // No response at all — the server is unreachable or the request died in
    // flight. Nothing is known about whether the message was recorded, so the
    // bubble stays and says so rather than disappearing.
    return { ok: false, message: null, error: String(cause) };
  }
}

// --- Normalising what arrives --------------------------------------------------

/**
 * `seq` is the ordering key and it must be a number before anything sorts it.
 *
 * On the wire it can be either. `chat_messages.seq` is a `bigserial`, which
 * node-postgres hands back as a **string** to avoid precision loss, and
 * ticket 010 projects it as `seq::text` to make that explicit before
 * converting. If any of those layers ever stops converting, a transcript
 * sorted with `>` would order 10 before 9 — so the conversion happens here,
 * at every entry point, and the sort below can then be plain arithmetic.
 */
export function normaliseMessage(message: ChatMessageRecord): ChatMessageRecord {
  const seq = Number(message.seq);
  return Number.isFinite(seq) && seq === message.seq ? message : { ...message, seq };
}

function bySeq(a: ChatMessageRecord, b: ChatMessageRecord): number {
  return a.seq - b.seq || a.id.localeCompare(b.id);
}

/** Merge by id, newest write winning: a `ChatMessageDelivery` event for a
 *  message already on screen updates it in place rather than duplicating it. */
export function mergeMessages(
  current: readonly ChatMessageRecord[],
  incoming: readonly ChatMessageRecord[],
): readonly ChatMessageRecord[] {
  if (incoming.length === 0) return current;
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, normaliseMessage(message));
  return [...byId.values()].sort(bySeq);
}

const DIRECTIONS: readonly string[] = ["inbound", "outbound"];
const DELIVERY_STATUSES: readonly string[] = ["pending", "delivered", "queued", "failed"];

/**
 * A `ChatMessageAppended` / `ChatMessageDelivery` payload as a record.
 *
 * Ticket 010 puts the whole message in the event payload on purpose — "the
 * body rides along so a subscribed client renders the message without a
 * refetch" — which is what makes the one-second reply criterion reachable.
 * This is the one place in the web app that builds a record from an event
 * payload rather than refetching (the board deliberately does the opposite,
 * because a task event is *not* a task row; a chat event *is* the message).
 *
 * Returns null only when the payload has nothing renderable. A missing `seq`
 * is NOT a reason to drop a message — it sorts to the end, which is where a
 * just-arrived message belongs anyway. Dropping it would be the vanishing
 * failure in a different costume.
 */
export function messageFromEvent(payload: unknown): ChatMessageRecord | null {
  if (typeof payload !== "object" || payload === null) return null;
  const raw = payload as Record<string, unknown>;
  const id = raw.message_id;
  const conversationId = raw.conversation_id;
  const direction = raw.direction;
  const body = raw.body;
  const author = raw.author;
  if (typeof id !== "string" || typeof conversationId !== "string") return null;
  if (typeof body !== "string" || typeof author !== "string") return null;
  if (typeof direction !== "string" || !DIRECTIONS.includes(direction)) return null;

  const seq = Number(raw.seq);
  const status = raw.delivery_status;
  return {
    id,
    conversationId,
    sessionId: String(raw.session_id ?? "") as SessionId,
    segmentId: typeof raw.segment_id === "string" ? raw.segment_id : "",
    direction: direction as ChatDirection,
    author,
    body,
    turnId: typeof raw.turn_id === "string" ? raw.turn_id : null,
    deliveryStatus:
      typeof status === "string" && DELIVERY_STATUSES.includes(status)
        ? (status as OutboundDeliveryStatus)
        : null,
    deliveryDetail: typeof raw.delivery_detail === "string" ? raw.delivery_detail : null,
    // The announcement does not carry it, and nothing in the panel reads it.
    queuedMessageId: null,
    seq: Number.isFinite(seq) ? seq : Number.MAX_SAFE_INTEGER,
    createdAt: typeof raw.created_at === "string" ? raw.created_at : "",
  };
}

// --- Recent actions -------------------------------------------------------------

/** One line in the "recent actions" stream. */
export interface RecentAction {
  /** The event id — stable, so a replayed backfill cannot double a line. */
  readonly id: string;
  /** `prompt_id`: which turn the tool call belongs to. */
  readonly turnId: string | null;
  readonly tool: string;
  /** A short, literal summary of the tool input, or null when none fits. */
  readonly detail: string | null;
  readonly at: string;
}

/**
 * `PreToolUse` only.
 *
 * `PostToolUse` carries the tool's entire output — whole file bodies for a
 * Read, the written content for a Write — and adds nothing a one-line
 * activity entry needs. The ticket names the PreToolUse stream; this follows
 * it literally rather than widening to every tool event.
 */
export const ACTION_EVENT_TYPE = "PreToolUse";

/** Input fields worth showing, most specific first. Nothing is synthesised:
 *  a tool whose input has none of these renders as the bare tool name. */
const ACTION_DETAIL_KEYS = [
  "command",
  "file_path",
  "notebook_path",
  "path",
  "pattern",
  "url",
  "query",
  "subagent_type",
  "description",
] as const;

const ACTION_DETAIL_LIMIT = 120;

export function summariseToolInput(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const raw = input as Record<string, unknown>;
  for (const key of ACTION_DETAIL_KEYS) {
    const value = raw[key];
    if (typeof value !== "string" || value.trim() === "") continue;
    const flat = value.replace(/\s+/g, " ").trim();
    return flat.length > ACTION_DETAIL_LIMIT ? `${flat.slice(0, ACTION_DETAIL_LIMIT)}…` : flat;
  }
  return null;
}

export function actionFromEvent(event: StoredEvent): RecentAction | null {
  if (event.type !== ACTION_EVENT_TYPE) return null;
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null) return null;
  const raw = payload as Record<string, unknown>;
  const tool = raw.tool_name;
  if (typeof tool !== "string" || tool === "") return null;
  return {
    id: event.id,
    turnId: typeof raw.prompt_id === "string" && raw.prompt_id !== "" ? raw.prompt_id : null,
    tool,
    detail: summariseToolInput(raw.tool_input),
    at: event.receivedAt,
  };
}

// --- An unsent or unacknowledged message --------------------------------------

/**
 * The optimistic bubble, kept separate from `ChatMessageRecord` on purpose.
 *
 * Faking a record would mean inventing a `segment_id`, a `seq` and a
 * `created_at` the server has not assigned — the same mistake as rendering a
 * token cost of 0. A local message is its own shape, and it is replaced by
 * the server's record the moment one exists.
 */
export interface LocalMessage {
  readonly localId: string;
  readonly body: string;
  readonly author: string;
  readonly status: "pending" | "failed";
  /** Why it failed, verbatim from the server where there was one. */
  readonly detail: string | null;
}

function dropMatchingLocal(
  locals: readonly LocalMessage[],
  message: ChatMessageRecord,
): readonly LocalMessage[] {
  if (message.direction !== "outbound") return locals;
  // Match on what the human actually typed. The server assigns the id, so the
  // optimistic bubble and the record have nothing else in common — and
  // without this, a message sent while its own WebSocket event is in flight
  // appears twice.
  const index = locals.findIndex(
    (local) => local.body === message.body && local.author === message.author,
  );
  if (index === -1) return locals;
  return [...locals.slice(0, index), ...locals.slice(index + 1)];
}

// --- The hook ------------------------------------------------------------------

/**
 * How much history to load when the panel opens: **one page of 50, then
 * backfill on scroll.**
 *
 * The ticket leaves this to the UI and the reasoning is in the ## Landed
 * section: 50 is comfortably more than a screenful at three or four lines a
 * message, so there is something to scroll into immediately and the first
 * paint stays one round trip; a conversation spanning many segments can be
 * thousands of messages, and loading it to render a panel would make opening
 * one slow in exactly the office where it matters most. It is also the
 * server's own `DEFAULT_PAGE_SIZE`, but it is passed explicitly — inheriting
 * a default means the panel's behaviour changes when a server constant does.
 */
export const INITIAL_PAGE_SIZE = 50;
export const OLDER_PAGE_SIZE = 50;

/** Recent actions are display-only and unbounded in principle; a desk running
 *  for a day would otherwise accumulate every tool call it ever made. */
export const MAX_RECENT_ACTIONS = 200;

export interface AgentChatDeps {
  readonly resolveConversation?: typeof resolveSessionConversation;
  readonly loadPage?: typeof fetchTranscriptPage;
  readonly sendMessage?: typeof postChatMessage;
  readonly loadDesk?: typeof fetchDesk;
  readonly subscribe?: typeof openEventStream;
}

export interface UseAgentChatOptions {
  readonly target: ChatTarget | null;
  /** Whose name is attached to a sent message. Required by the API, and
   *  rendered next to the message — see 022 on there being no auth yet. */
  readonly author: string;
  readonly deps?: AgentChatDeps;
}

export interface AgentChatState {
  readonly conversation: ConversationRecord | null;
  readonly segments: readonly ConversationSegmentRecord[];
  readonly desk: DeskInfo | null;
  readonly messages: readonly ChatMessageRecord[];
  readonly locals: readonly LocalMessage[];
  readonly actions: readonly RecentAction[];
  readonly loading: boolean;
  readonly loadingOlder: boolean;
  readonly error: string | null;
  /** True while the API still has older pages. Drives the backfill. */
  readonly hasMore: boolean;
  readonly status: ConnectionStatus;
  /** The socket dropped: live messages may be missing until it is back. */
  readonly stale: boolean;
  readonly send: (body: string) => Promise<void>;
  readonly retryLocal: (localId: string) => Promise<void>;
  readonly loadOlder: () => Promise<void>;
  readonly refresh: () => void;
}

export function useAgentChat(options: UseAgentChatOptions): AgentChatState {
  const { target, author } = options;
  const {
    resolveConversation = resolveSessionConversation,
    loadPage = fetchTranscriptPage,
    sendMessage = postChatMessage,
    loadDesk = fetchDesk,
    subscribe = openEventStream,
  } = options.deps ?? {};

  const [conversation, setConversation] = useState<ConversationRecord | null>(null);
  const [segments, setSegments] = useState<readonly ConversationSegmentRecord[]>([]);
  const [desk, setDesk] = useState<DeskInfo | null>(null);
  const [messages, setMessages] = useState<readonly ChatMessageRecord[]>([]);
  const [locals, setLocals] = useState<readonly LocalMessage[]>([]);
  const [actions, setActions] = useState<readonly RecentAction[]>([]);
  const [before, setBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [stale, setStale] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  // Injected functions live here and in NO dependency array. See the header.
  const injected = useRef({ resolveConversation, loadPage, sendMessage, loadDesk, subscribe });
  injected.current = { resolveConversation, loadPage, sendMessage, loadDesk, subscribe };

  const targetKey = chatTargetKey(target);
  // The target itself is read through a ref for the same reason: a caller
  // writing `useAgentChat({ target: { kind: "session", sessionId } })` makes a
  // new object every render.
  const targetRef = useRef(target);
  targetRef.current = target;

  // Which conversation the panel is *currently* showing. Every async result
  // is checked against this before it is applied, so a slow page for the desk
  // the user just navigated away from cannot land under the new header.
  const liveKey = useRef(targetKey);
  const knownSegmentIds = useRef<ReadonlySet<string>>(new Set());
  const refreshingSegments = useRef(false);
  const localCounter = useRef(0);
  // A mirror of `locals`, so a retry can read a body without reaching into a
  // setState updater.
  const localsRef = useRef<readonly LocalMessage[]>(locals);
  localsRef.current = locals;

  useEffect(() => {
    knownSegmentIds.current = new Set(segments.map((segment) => segment.id));
  }, [segments]);

  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  // --- Load: resolve the conversation, then its newest page --------------------
  useEffect(() => {
    liveKey.current = targetKey;
    // Cleared on every target change, before anything is fetched. This is the
    // criterion "switching the panel between two conversations never shows
    // one agent's messages under the other's header" at its simplest: there
    // is no window in which the old transcript is still on screen under the
    // new identity.
    setConversation(null);
    setSegments([]);
    setDesk(null);
    setMessages([]);
    setLocals([]);
    setActions([]);
    setBefore(null);
    setError(null);

    const current = targetRef.current;
    if (current === null) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    const mine = (): boolean => !cancelled && liveKey.current === targetKey;
    setLoading(true);

    void (async () => {
      try {
        let conversationId: string;
        if (current.kind === "session") {
          const bundle = await injected.current.resolveConversation(
            current.sessionId,
            current.taskId ?? null,
          );
          if (!mine()) return;
          conversationId = bundle.conversation.id;
          setConversation(bundle.conversation);
          setSegments(bundle.segments);
        } else {
          conversationId = current.conversationId;
        }

        const page = await injected.current.loadPage(conversationId, {
          limit: INITIAL_PAGE_SIZE,
        });
        if (!mine()) return;
        setConversation(page.conversation);
        setSegments(page.segments);
        setMessages([...page.messages].map(normaliseMessage).sort(bySeq));
        setBefore(page.next_before);

        // The desk, for the header and for addressing a send. Best effort: a
        // transcript that reads fine without it must not fail to render
        // because the session row is gone.
        const deskId =
          current.kind === "session"
            ? current.sessionId
            : (page.segments[page.segments.length - 1]?.sessionId ?? null);
        if (deskId !== null) {
          try {
            const info = await injected.current.loadDesk(String(deskId));
            if (mine()) setDesk(info);
          } catch {
            if (mine()) setDesk(null);
          }
        }
      } catch (cause) {
        if (mine()) setError(describeFailure(cause));
      } finally {
        if (mine()) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see the header:
    // identity-unstable props must never drive this effect.
  }, [targetKey, reloadToken]);

  const conversationId = conversation?.id ?? null;
  const projectId = conversation?.projectId ?? null;

  /** The claude session id the desk is on right now. Rotates on `/clear`,
   *  which is why the chat subscription is not keyed on it. */
  const claudeSessionId = useMemo((): string | null => {
    const open = segments.find((segment) => segment.endReason === null);
    return open?.claudeSessionId ?? desk?.claudeSessionId ?? null;
  }, [segments, desk]);

  // --- Live ---------------------------------------------------------------------
  useEffect(() => {
    if (conversationId === null) return;
    let cancelled = false;

    const refreshSegments = async (): Promise<void> => {
      if (refreshingSegments.current) return;
      refreshingSegments.current = true;
      try {
        // One row, for the `segments` that travel with every page. A message
        // whose segment the panel has never heard of must not render as a
        // seamless join — the divider is the whole point of this ticket.
        const page = await injected.current.loadPage(conversationId, { limit: 1 });
        if (cancelled) return;
        setSegments(page.segments);
      } catch {
        // Nothing to do: the divider falls back to "reason not recorded",
        // which is honest, and the next event tries again.
      } finally {
        refreshingSegments.current = false;
      }
    };

    const onEvent = (event: StoredEvent): void => {
      if (cancelled) return;
      const payload =
        typeof event.payload === "object" && event.payload !== null
          ? (event.payload as Record<string, unknown>)
          : null;

      if (event.type === "ChatMessageAppended" || event.type === "ChatMessageDelivery") {
        if (payload?.conversation_id !== conversationId) return;
        const message = messageFromEvent(payload);
        if (message === null) return;
        setMessages((current) => mergeMessages(current, [message]));
        setLocals((current) => dropMatchingLocal(current, message));
        if (message.segmentId !== "" && !knownSegmentIds.current.has(message.segmentId)) {
          void refreshSegments();
        }
        return;
      }

      if (
        event.type === "ConversationSegmentOpened" ||
        event.type === "ConversationSegmentClosed"
      ) {
        if (payload?.conversation_id !== conversationId) return;
        void refreshSegments();
        return;
      }

      if (event.type === ACTION_EVENT_TYPE) {
        // Hook events carry no conversation id; the claude session id the
        // subscription filtered on is the only correlation there is.
        if (claudeSessionId === null || event.sessionId !== claudeSessionId) return;
        const action = actionFromEvent(event);
        if (action === null) return;
        setActions((current) =>
          current.some((existing) => existing.id === action.id)
            ? current
            : [...current, action].slice(-MAX_RECENT_ACTIONS),
        );
      }
    };

    // Chat and segment events, by project — so a `/clear` mid-conversation
    // does not silently stop the panel updating.
    const conversationStream = injected.current.subscribe({
      projectId,
      onEvent,
      onStatus: (next) => {
        if (cancelled) return;
        setStatus(next);
        if (next === "reconnecting") setStale(true);
        if (next === "open") setStale(false);
      },
    });

    // Tool activity, by claude session id — hook events have no project.
    // Status is taken from the conversation stream only: two writers would
    // race, and this one carries the less important traffic.
    const actionStream =
      claudeSessionId === null
        ? null
        : injected.current.subscribe({ sessionId: claudeSessionId, onEvent });

    return () => {
      cancelled = true;
      conversationStream.close();
      actionStream?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- as above. Every
    // value here is a string or null, so the key is stable by construction.
  }, [conversationId, projectId, claudeSessionId]);

  // --- Send ---------------------------------------------------------------------

  const deliver = useCallback(
    async (localId: string, body: string, toConversation: string): Promise<void> => {
      const current = targetRef.current;
      const result = await injected.current.sendMessage(toConversation, {
        body,
        author,
        // The panel knows which desk it is looking at, and the server lets an
        // explicit session win over the conversation's newest segment.
        sessionId: current?.kind === "session" ? current.sessionId : null,
      });
      if (liveKey.current !== chatTargetKey(current)) return;

      const recorded = result.message;
      if (recorded !== null) {
        // Recorded. The server's row replaces the optimistic bubble whatever
        // delivery did — `delivery_status` on it says delivered, queued or
        // failed, and the transcript renders that honestly.
        setMessages((messagesNow) => mergeMessages(messagesNow, [recorded]));
        setLocals((localsNow) => localsNow.filter((local) => local.localId !== localId));
        return;
      }

      // Nothing was recorded — an unknown conversation, a conversation with no
      // desk at all, or an unreachable server. The bubble stays, marked
      // failed, with a retry.
      setLocals((localsNow) =>
        localsNow.map((local) =>
          local.localId === localId
            ? { ...local, status: "failed" as const, detail: result.error }
            : local,
        ),
      );
    },
    [author],
  );

  const send = useCallback(
    async (body: string): Promise<void> => {
      if (conversationId === null) return;
      // Mirrors the server's own 400: a whitespace-only body is empty by the
      // intent of the check, and sending it costs the agent a turn.
      if (body.trim() === "") return;
      localCounter.current += 1;
      const localId = `local-${localCounter.current}`;
      setLocals((current) => [
        ...current,
        { localId, body, author, status: "pending", detail: null },
      ]);
      try {
        await deliver(localId, body, conversationId);
      } catch (cause) {
        setLocals((current) =>
          current.map((local) =>
            local.localId === localId
              ? { ...local, status: "failed" as const, detail: describeFailure(cause) }
              : local,
          ),
        );
      }
    },
    [author, conversationId, deliver],
  );

  const retryLocal = useCallback(
    async (localId: string): Promise<void> => {
      if (conversationId === null) return;
      // Read through the ref, not out of a setState updater: React may invoke
      // an updater more than once, so an updater is not a place to extract a
      // value from.
      const body = localsRef.current.find((local) => local.localId === localId)?.body;
      if (body === undefined) return;
      setLocals((current) =>
        current.map((local) =>
          local.localId === localId
            ? { ...local, status: "pending" as const, detail: null }
            : local,
        ),
      );
      try {
        await deliver(localId, body, conversationId);
      } catch (cause) {
        setLocals((current) =>
          current.map((local) =>
            local.localId === localId
              ? { ...local, status: "failed" as const, detail: describeFailure(cause) }
              : local,
          ),
        );
      }
    },
    [conversationId, deliver],
  );

  // --- Backfill ------------------------------------------------------------------

  const loadOlder = useCallback(async (): Promise<void> => {
    if (conversationId === null || before === null || loadingOlder) return;
    const key = liveKey.current;
    setLoadingOlder(true);
    try {
      // The cursor goes back under the name it came out under: `next_before`
      // feeds `before`. Paging is backwards and `seq` is conversation-wide, so
      // this walks across segment boundaries with no gap and no duplicate.
      const page = await injected.current.loadPage(conversationId, {
        before,
        limit: OLDER_PAGE_SIZE,
      });
      if (liveKey.current !== key) return;
      setMessages((current) => mergeMessages(current, page.messages));
      setSegments(page.segments);
      setBefore(page.next_before);
    } catch (cause) {
      if (liveKey.current === key) setError(describeFailure(cause));
    } finally {
      if (liveKey.current === key) setLoadingOlder(false);
    }
  }, [before, conversationId, loadingOlder]);

  return {
    conversation,
    segments,
    desk,
    messages,
    locals,
    actions,
    loading,
    loadingOlder,
    error,
    hasMore: before !== null,
    status,
    stale,
    send,
    retryLocal,
    loadOlder,
    refresh,
  };
}

function describeFailure(cause: unknown): string {
  if (cause instanceof ApiError) return cause.message;
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
