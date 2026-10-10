// Ticket 026's criteria, against fixtures.
//
// What jsdom can and cannot be asked. It has no layout engine and no real
// scrolling: `scrollHeight` and `clientHeight` are always 0, so "the view did
// not jump" and "the panel reads correctly at 400 px" are not assertable here
// and are carried to ticket 030 — see this ticket's ## Landed section. What
// *is* assertable, and is asserted below, is every decision those behaviours
// rest on: the arithmetic that restores a scroll position, the predicate that
// decides whether the reader is at the live end, the row builder that places a
// session divider, and the state machine a sent message moves through.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  SEGMENT_END_REASONS,
  type ChatMessageRecord,
  type ConversationRecord,
  type ConversationSegmentRecord,
  type SegmentEndReason,
} from "@office/shared/chat";
import type { StoredEvent } from "../../lib/api.ts";
import type { EventStreamOptions } from "../../lib/ws.ts";
import { ChatPanel, describeActivity, describeAgent, agoText } from "./ChatPanel.tsx";
import { QUEUE_NOTE } from "./ChatComposer.tsx";
import {
  BACKFILL_THRESHOLD_PX,
  buildTranscriptRows,
  countArrivals,
  dividerCopy,
  formatMessageTime,
  isNearBottom,
  scrollTopAfterPrepend,
  segmentEndText,
  SEGMENT_END_TEXT,
} from "./ChatTranscript.tsx";
import ChatOverlay, { collectChatSlots } from "./overlay.tsx";
import {
  actionFromEvent,
  chatTargetKey,
  closeChatPanel,
  INITIAL_PAGE_SIZE,
  mergeMessages,
  messageFromEvent,
  normaliseMessage,
  openChatPanel,
  summariseToolInput,
  useAgentChat,
  type AgentChatDeps,
  type ChatTarget,
  type DeskInfo,
  type SendResult,
  type TranscriptPageResponse,
} from "./useAgentChat.ts";

afterEach(() => {
  cleanup();
  closeChatPanel();
  vi.unstubAllGlobals();
});

// --- Fixtures --------------------------------------------------------------------

const CONVERSATION: ConversationRecord = {
  id: "conv-1",
  projectId: "proj-1",
  subjectKind: "role_slot",
  taskId: null,
  dept: "dev",
  role: "dept_lead",
  owner: "agent1",
  createdAt: "2026-10-10 09:00:00+00",
} as unknown as ConversationRecord;

function segment(overrides: Partial<ConversationSegmentRecord> = {}): ConversationSegmentRecord {
  return {
    id: "seg-1",
    conversationId: "conv-1",
    sessionId: "desk-1",
    claudeSessionId: "claude-1",
    ordinal: 1,
    owner: "agent1",
    model: "claude-sonnet-5",
    startReason: "spawn",
    endReason: null,
    previousEndReason: null,
    restoredFromHandoff: false,
    startedAt: "2026-10-10 09:00:00+00",
    endedAt: null,
    ...overrides,
  } as unknown as ConversationSegmentRecord;
}

function message(overrides: Partial<ChatMessageRecord> = {}): ChatMessageRecord {
  return {
    id: "m-1",
    conversationId: "conv-1",
    sessionId: "desk-1",
    segmentId: "seg-1",
    direction: "inbound",
    author: "agent:dept_lead:dev",
    body: "on it",
    turnId: "turn-1",
    deliveryStatus: null,
    deliveryDetail: null,
    queuedMessageId: null,
    seq: 1,
    createdAt: "2026-10-10 09:01:00+00",
    ...overrides,
  } as unknown as ChatMessageRecord;
}

const DESK: DeskInfo = {
  id: "desk-1",
  projectId: "proj-1",
  tmuxName: "proj-dev-lead-agent1",
  role: "dept_lead",
  dept: "dev",
  owner: "agent1",
  backend: "claude",
  model: "claude-sonnet-5",
  modelReason: "role default",
  status: "running",
  claudeSessionId: "claude-1",
  failureKind: null,
  failureReason: null,
  startedAt: "2026-10-10 09:00:00+00",
  endedAt: null,
} as unknown as DeskInfo;

function page(overrides: Partial<TranscriptPageResponse> = {}): TranscriptPageResponse {
  return {
    conversation: CONVERSATION,
    segments: [segment()],
    messages: [],
    next_before: null,
    ...overrides,
  };
}

function chatEvent(
  type: string,
  payload: Record<string, unknown>,
  overrides: Partial<StoredEvent> = {},
): StoredEvent {
  return {
    id: `e-${String(payload.message_id ?? payload.segment_id ?? Math.random())}`,
    projectId: "proj-1",
    sessionId: "claude-1",
    type,
    payload,
    receivedAt: "2026-10-10 09:02:00+00",
    cursor: "c1",
    ...overrides,
  };
}

function appended(record: ChatMessageRecord): StoredEvent {
  return chatEvent("ChatMessageAppended", {
    message_id: record.id,
    conversation_id: record.conversationId,
    segment_id: record.segmentId,
    session_id: record.sessionId,
    claude_session_id: "claude-1",
    direction: record.direction,
    author: record.author,
    body: record.body,
    turn_id: record.turnId,
    delivery_status: record.deliveryStatus,
    delivery_detail: record.deliveryDetail,
    seq: record.seq,
    created_at: record.createdAt,
  });
}

/** Captures every stream the hook opens, with its filter, and lets a test
 *  push events into it. The chat panel opens two (see useAgentChat's header:
 *  chat events by project, hook events by claude session id). */
interface StreamHarness {
  readonly filter: { projectId?: string | null; sessionId?: string | null };
  readonly emit: (event: StoredEvent) => void;
  readonly setStatus: (status: "open" | "reconnecting") => void;
  closed: boolean;
}

function subscribeStub(streams: StreamHarness[]) {
  return (options: EventStreamOptions) => {
    const harness: StreamHarness = {
      filter: { projectId: options.projectId ?? null, sessionId: options.sessionId ?? null },
      emit: (event) => options.onEvent(event),
      setStatus: (status) => options.onStatus?.(status),
      closed: false,
    };
    streams.push(harness);
    return {
      close: () => {
        harness.closed = true;
      },
      status: "open" as const,
      cursor: null,
    };
  };
}

const SESSION_TARGET: ChatTarget = { kind: "session", sessionId: "desk-1" };

function deps(overrides: Partial<AgentChatDeps> = {}): AgentChatDeps {
  return {
    resolveConversation: async () => ({
      conversation: CONVERSATION,
      segments: [segment()],
      current_segment: segment(),
    }),
    loadPage: async () => page(),
    sendMessage: async () => ({ ok: true, message: null, error: null }),
    loadDesk: async () => DESK,
    subscribe: subscribeStub([]),
    ...overrides,
  };
}

// --- Pure: ordering and normalisation --------------------------------------------

describe("message normalisation", () => {
  it("sorts by seq numerically even when the wire hands it a string", () => {
    // `chat_messages.seq` is a bigserial: node-postgres returns int8 as a
    // STRING to avoid precision loss, and 010 projects `seq::text` before
    // converting. If any layer stops converting, a string sort puts "10"
    // before "9" and the transcript silently reorders itself.
    const nine = { ...message({ id: "m9" }), seq: "9" } as unknown as ChatMessageRecord;
    const ten = { ...message({ id: "m10" }), seq: "10" } as unknown as ChatMessageRecord;
    const merged = mergeMessages([], [ten, nine]);
    expect(merged.map((entry) => entry.id)).toEqual(["m9", "m10"]);
    expect(normaliseMessage(ten).seq).toBe(10);
  });

  it("merges by id, so a delivery update replaces rather than duplicates", () => {
    const sent = message({ id: "m-out", direction: "outbound", deliveryStatus: "pending", seq: 4 });
    const delivered = { ...sent, deliveryStatus: "delivered" as const };
    const merged = mergeMessages([sent], [delivered]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.deliveryStatus).toBe("delivered");
  });
});

describe("messageFromEvent", () => {
  it("builds a record from a ChatMessageAppended payload", () => {
    const record = messageFromEvent(appended(message()).payload);
    expect(record?.body).toBe("on it");
    expect(record?.author).toBe("agent:dept_lead:dev");
    expect(record?.segmentId).toBe("seg-1");
  });

  it("rejects a payload with nothing renderable, but never over a missing seq", () => {
    expect(messageFromEvent({ message_id: "m", conversation_id: "c" })).toBeNull();
    expect(messageFromEvent({ direction: "sideways", body: "x", author: "a" })).toBeNull();
    // A missing seq sorts last — which is where a just-arrived message
    // belongs. Dropping the message would be the vanishing failure again.
    const noSeq = messageFromEvent({
      message_id: "m",
      conversation_id: "c",
      direction: "inbound",
      author: "a",
      body: "hello",
    });
    expect(noSeq?.body).toBe("hello");
    expect(noSeq?.seq).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("recent actions", () => {
  it("summarises a tool input literally, and invents nothing when it cannot", () => {
    expect(summariseToolInput({ command: "pnpm vitest run" })).toBe("pnpm vitest run");
    expect(summariseToolInput({ file_path: "packages/web/src/x.ts" })).toBe(
      "packages/web/src/x.ts",
    );
    expect(summariseToolInput({ unexpected: "shape" })).toBeNull();
    expect(summariseToolInput(undefined)).toBeNull();
    const long = summariseToolInput({ command: "x".repeat(400) });
    expect(long?.endsWith("…")).toBe(true);
    expect(long?.length).toBeLessThan(140);
  });

  it("reads PreToolUse only", () => {
    const pre = actionFromEvent({
      id: "e1",
      projectId: null,
      sessionId: "claude-1",
      type: "PreToolUse",
      payload: { tool_name: "Bash", tool_input: { command: "ls" }, prompt_id: "turn-1" },
      receivedAt: "2026-10-10 09:02:00+00",
      cursor: "c",
    });
    expect(pre).toMatchObject({ tool: "Bash", detail: "ls", turnId: "turn-1" });

    // PostToolUse carries whole file bodies and adds nothing a one-line
    // activity entry needs.
    expect(
      actionFromEvent({
        id: "e2",
        projectId: null,
        sessionId: "claude-1",
        type: "PostToolUse",
        payload: { tool_name: "Read", tool_response: "…whole file…" },
        receivedAt: "2026-10-10 09:02:00+00",
        cursor: "c",
      }),
    ).toBeNull();
  });
});

// --- Pure: the divider ------------------------------------------------------------

describe("segment divider copy", () => {
  it("has wording for every end reason in the shared vocabulary", () => {
    // A missing entry renders an empty divider, which is the one shape this
    // file exists to prevent.
    for (const reason of SEGMENT_END_REASONS) {
      expect(SEGMENT_END_TEXT[reason as SegmentEndReason], reason).toBeTruthy();
    }
    expect(Object.keys(SEGMENT_END_TEXT).sort()).toEqual([...SEGMENT_END_REASONS].sort());
    // An unrecorded predecessor says so rather than guessing.
    expect(segmentEndText(null)).toContain("nobody recorded");
  });

  it("says the agent does not remember, and does not promise a restored handoff", () => {
    const copy = dividerCopy(segment({ previousEndReason: "paused" }));
    expect(copy.why).toContain("paused");
    expect(copy.memory).toBe("The agent below does not remember anything above this line.");
    // restored_from_handoff is false for every segment in build steps 1-3 —
    // handoff nodes are the knowledge graph, step 5. The UI must not imply
    // context came across.
    expect(copy.handoff).toContain("No handoff was restored");
    expect(dividerCopy(segment({ restoredFromHandoff: true })).handoff).toContain(
      "restored from a handoff",
    );
  });
});

describe("buildTranscriptRows", () => {
  const segOne = segment({ id: "seg-1", ordinal: 1 });
  const segTwo = segment({
    id: "seg-2",
    ordinal: 2,
    claudeSessionId: "claude-2",
    previousEndReason: "crash",
  });

  it("renders a boundary at a segment change, not a seamless join", () => {
    const rows = buildTranscriptRows({
      messages: [
        message({ id: "a", segmentId: "seg-1", seq: 1, turnId: null }),
        message({ id: "b", segmentId: "seg-2", seq: 2, turnId: null }),
      ],
      locals: [],
      segments: [segOne, segTwo],
      actions: [],
      showActions: true,
      hasMore: false,
    });
    expect(rows.map((row) => row.kind)).toEqual(["message", "divider", "message"]);
    const divider = rows[1];
    if (divider?.kind !== "divider") throw new Error("expected a divider row");
    expect(divider.segment?.previousEndReason).toBe("crash");
  });

  it("does not invent a boundary inside one segment", () => {
    const rows = buildTranscriptRows({
      messages: [
        message({ id: "a", segmentId: "seg-1", seq: 1, turnId: null }),
        message({ id: "b", segmentId: "seg-1", seq: 2, turnId: null }),
      ],
      locals: [],
      segments: [segOne],
      actions: [],
      showActions: true,
      hasMore: false,
    });
    expect(rows.some((row) => row.kind === "divider")).toBe(false);
  });

  it("suppresses the top divider while older pages are still unloaded", () => {
    const input = {
      messages: [message({ id: "b", segmentId: "seg-2", seq: 2, turnId: null })],
      locals: [],
      segments: [segOne, segTwo],
      actions: [],
      showActions: true,
    };
    // With more history to load, the window's first row is a page edge, not a
    // restart: claiming the boundary is there would be wrong.
    expect(
      buildTranscriptRows({ ...input, hasMore: true }).some((row) => row.kind === "divider"),
    ).toBe(false);
    // Fully loaded, the restart is real and gets its divider even though the
    // segment before it has no messages on screen.
    expect(
      buildTranscriptRows({ ...input, hasMore: false }).some((row) => row.kind === "divider"),
    ).toBe(true);
  });

  it("anchors tool activity to its own turn, and parks an unfinished turn at the tail", () => {
    const rows = buildTranscriptRows({
      messages: [message({ id: "reply", segmentId: "seg-1", seq: 1, turnId: "turn-1" })],
      locals: [{ localId: "local-1", body: "hi", author: "gluy", status: "pending", detail: null }],
      segments: [segOne],
      actions: [
        { id: "a1", turnId: "turn-1", tool: "Bash", detail: "ls", at: "t" },
        { id: "a2", turnId: "turn-2", tool: "Edit", detail: "x.ts", at: "t" },
      ],
      showActions: true,
      hasMore: false,
    });
    // Tools ran during the turn, so they sit before the reply that ended it;
    // the turn with no reply yet is the tail, which is the only "working"
    // signal the panel has.
    expect(rows.map((row) => row.kind)).toEqual(["actions", "message", "actions", "local"]);
  });

  it("drops every action line when actions are collapsed", () => {
    const rows = buildTranscriptRows({
      messages: [message({ id: "reply", turnId: "turn-1" })],
      locals: [],
      segments: [segOne],
      actions: [{ id: "a1", turnId: "turn-1", tool: "Bash", detail: "ls", at: "t" }],
      showActions: false,
      hasMore: false,
    });
    expect(rows.some((row) => row.kind === "actions")).toBe(false);
  });
});

// --- Pure: scrolling and time ------------------------------------------------------

describe("scroll arithmetic", () => {
  it("keeps the reader's place when older messages are prepended", () => {
    // The invariant is the distance from the BOTTOM: content grew above, so
    // keeping scrollTop would show different text.
    const before = { scrollTop: 100, scrollHeight: 1_000, clientHeight: 400 };
    expect(scrollTopAfterPrepend(before, 2_000)).toBe(1_100);
    // And it never goes negative when the container shrank.
    expect(scrollTopAfterPrepend(before, 500)).toBe(0);
  });

  it("knows whether the reader is at the live end", () => {
    expect(isNearBottom({ scrollTop: 600, scrollHeight: 1_000, clientHeight: 400 })).toBe(true);
    expect(isNearBottom({ scrollTop: 100, scrollHeight: 1_000, clientHeight: 400 })).toBe(false);
    expect(BACKFILL_THRESHOLD_PX).toBeGreaterThan(0);
  });

  it("counts arrivals by seq, so a backfill is not 'three new messages'", () => {
    const loaded = [message({ id: "old", seq: 1 }), message({ id: "new", seq: 9 })];
    expect(countArrivals(loaded, 1)).toBe(1);
    expect(countArrivals(loaded, 9)).toBe(0);
  });

  it("never renders Invalid Date for a Postgres text timestamp", () => {
    expect(formatMessageTime("2026-10-10 09:01:00+00")).not.toContain("Invalid");
    expect(formatMessageTime("2026-10-10 09:01:00+00")).not.toBe("");
    // An unparseable value falls back to the raw string rather than lying.
    expect(formatMessageTime("not a time")).toBe("not a time");
    expect(formatMessageTime("")).toBe("");
  });
});

// --- Pure: header and activity ------------------------------------------------------

describe("panel header and activity", () => {
  it("names the agent from the desk, and falls back to the conversation", () => {
    expect(describeAgent(DESK, CONVERSATION)).toMatchObject({
      title: "Department lead · dev",
      subtitle: "agent1 · running",
    });
    expect(describeAgent(null, CONVERSATION).title).toBe("Department lead · dev");
    const taskConversation = {
      ...CONVERSATION,
      subjectKind: "task",
      taskId: "task-7",
      dept: null,
      role: null,
      owner: null,
    } as unknown as ConversationRecord;
    expect(describeAgent(null, taskConversation)).toMatchObject({ taskId: "task-7" });
    expect(describeAgent(null, null).title).toBe("Agent");
  });

  it("reports activity as the fact it has, and says nothing when it has none", () => {
    const now = new Date("2026-10-10T09:05:00Z");
    const working = describeActivity({
      actions: [
        { id: "a1", turnId: "turn-9", tool: "Bash", detail: "pnpm test", at: "2026-10-10 09:04:00+00" },
      ],
      messages: [],
      now,
    });
    // No streaming exists in this build, so "working" is reported as what was
    // observed — a tool call — never as an animated claim.
    expect(working?.kind).toBe("tooling");
    expect(working?.text).toContain("Bash");

    const waiting = describeActivity({
      actions: [],
      messages: [
        message({ id: "out", direction: "outbound", deliveryStatus: "delivered", turnId: null }),
      ],
      now,
    });
    expect(waiting?.text).toContain("no live streaming");

    // A tool call whose turn has already replied is finished business.
    expect(
      describeActivity({
        actions: [{ id: "a1", turnId: "turn-1", tool: "Bash", detail: null, at: "t" }],
        messages: [message({ id: "r", turnId: "turn-1" })],
        now,
      }),
    ).toBeNull();
  });

  it("reads a duration coarsely, and never '0m'", () => {
    const now = new Date("2026-10-10T09:05:00Z");
    expect(agoText("2026-10-10T09:04:58Z", now)).toBe("just now");
    expect(agoText("2026-10-10T08:35:00Z", now)).toBe("30m ago");
    expect(agoText("nonsense", now)).toBe("at an unknown time");
  });
});

// --- The hook ----------------------------------------------------------------------

describe("useAgentChat", () => {
  it("resolves the desk's conversation, pages explicitly, and subscribes twice", async () => {
    const streams: StreamHarness[] = [];
    const loadPage = vi.fn(async () => page({ messages: [message()] }));
    const { result } = renderHook(() =>
      useAgentChat({
        target: SESSION_TARGET,
        author: "gluy",
        deps: deps({ loadPage, subscribe: subscribeStub(streams) }),
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.conversation?.id).toBe("conv-1");
    expect(result.current.messages.map((entry) => entry.body)).toEqual(["on it"]);
    // The page size is passed, never inherited from a server default.
    expect(loadPage).toHaveBeenCalledWith("conv-1", { limit: INITIAL_PAGE_SIZE });

    await waitFor(() => expect(streams).toHaveLength(2));
    // Chat events by project (they survive a /clear rotating the claude
    // session id); hook events by claude session id (they carry no project).
    expect(streams.map((stream) => stream.filter)).toEqual([
      { projectId: "proj-1", sessionId: null },
      { projectId: null, sessionId: "claude-1" },
    ]);
  });

  it("passes a task id through, because nothing links a session to a task", async () => {
    // 0003_sessions.sql has no task_id column and claim_task is ticket 017, so
    // the caller that knows the task is the only source there is — the server
    // resolves a task conversation from it, and a role slot without it.
    const resolveConversation = vi.fn(async () => ({
      conversation: CONVERSATION,
      segments: [segment()],
      current_segment: segment(),
    }));
    const { result } = renderHook(() =>
      useAgentChat({
        target: { kind: "session", sessionId: "desk-1", taskId: "task-7" },
        author: "gluy",
        deps: deps({ resolveConversation }),
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(resolveConversation).toHaveBeenCalledWith("desk-1", "task-7");
  });

  it("renders a live reply from the event payload, with no second fetch", async () => {
    const streams: StreamHarness[] = [];
    const loadPage = vi.fn(async () => page());
    const { result } = renderHook(() =>
      useAgentChat({
        target: SESSION_TARGET,
        author: "gluy",
        deps: deps({ loadPage, subscribe: subscribeStub(streams) }),
      }),
    );
    await waitFor(() => expect(streams.length).toBeGreaterThan(0));

    await act(async () => {
      streams[0]!.emit(appended(message({ id: "live", body: "done", seq: 2 })));
    });

    expect(result.current.messages.map((entry) => entry.body)).toEqual(["done"]);
    // One load, for the first page. The reply rode in on the event — which is
    // what makes "within a second of the Stop hook" reachable at all.
    expect(loadPage).toHaveBeenCalledTimes(1);
  });

  it("ignores another conversation's traffic on the shared project stream", async () => {
    const streams: StreamHarness[] = [];
    const { result } = renderHook(() =>
      useAgentChat({
        target: SESSION_TARGET,
        author: "gluy",
        deps: deps({ subscribe: subscribeStub(streams) }),
      }),
    );
    await waitFor(() => expect(streams.length).toBeGreaterThan(0));

    await act(async () => {
      streams[0]!.emit(
        appended(message({ id: "elsewhere", conversationId: "conv-other", body: "not yours" })),
      );
    });
    expect(result.current.messages).toHaveLength(0);
  });

  it("refreshes the segment list when a message arrives from a segment it has never seen", async () => {
    // Without this, the first message after a `/clear` renders as a seamless
    // join — the exact thing the divider exists to prevent.
    const streams: StreamHarness[] = [];
    const segTwo = segment({ id: "seg-2", ordinal: 2, previousEndReason: "cleared" });
    let callCount = 0;
    const loadPage = vi.fn(async () => {
      callCount += 1;
      return callCount === 1 ? page() : page({ segments: [segment(), segTwo] });
    });
    const { result } = renderHook(() =>
      useAgentChat({
        target: SESSION_TARGET,
        author: "gluy",
        deps: deps({ loadPage, subscribe: subscribeStub(streams) }),
      }),
    );
    await waitFor(() => expect(streams.length).toBeGreaterThan(0));

    await act(async () => {
      streams[0]!.emit(appended(message({ id: "after-clear", segmentId: "seg-2", seq: 2 })));
    });

    await waitFor(() => expect(result.current.segments).toHaveLength(2));
    expect(loadPage).toHaveBeenLastCalledWith("conv-1", { limit: 1 });
  });

  it("keeps tool activity for this desk and drops another desk's", async () => {
    const streams: StreamHarness[] = [];
    const { result } = renderHook(() =>
      useAgentChat({
        target: SESSION_TARGET,
        author: "gluy",
        deps: deps({ subscribe: subscribeStub(streams) }),
      }),
    );
    await waitFor(() => expect(streams).toHaveLength(2));

    const tool = (id: string, claudeSessionId: string): StoredEvent => ({
      id,
      projectId: null,
      sessionId: claudeSessionId,
      type: "PreToolUse",
      payload: { tool_name: "Edit", tool_input: { file_path: "x.ts" }, prompt_id: "turn-2" },
      receivedAt: "2026-10-10 09:02:00+00",
      cursor: "c",
    });

    await act(async () => {
      streams[1]!.emit(tool("t1", "claude-1"));
      streams[1]!.emit(tool("t1", "claude-1")); // a replayed backfill must not double it
      streams[1]!.emit(tool("t2", "claude-OTHER"));
    });

    expect(result.current.actions.map((action) => action.id)).toEqual(["t1"]);
  });

  it("goes stale on a drop and recovers on reconnect", async () => {
    const streams: StreamHarness[] = [];
    const { result } = renderHook(() =>
      useAgentChat({
        target: SESSION_TARGET,
        author: "gluy",
        deps: deps({ subscribe: subscribeStub(streams) }),
      }),
    );
    await waitFor(() => expect(streams.length).toBeGreaterThan(0));

    act(() => streams[0]!.setStatus("reconnecting"));
    expect(result.current.stale).toBe(true);
    act(() => streams[0]!.setStatus("open"));
    expect(result.current.stale).toBe(false);
  });

  it("pages backwards through next_before without gaps or duplicates", async () => {
    const first = page({
      messages: [message({ id: "m3", seq: 3, body: "three" })],
      next_before: "cursor-2",
    });
    const second = page({
      messages: [message({ id: "m2", seq: 2, body: "two" })],
      next_before: null,
    });
    const loadPage = vi.fn(async (_id: string, params: { before?: string | null }) =>
      params.before === undefined || params.before === null ? first : second,
    );
    const { result } = renderHook(() =>
      useAgentChat({ target: SESSION_TARGET, author: "gluy", deps: deps({ loadPage }) }),
    );
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    await act(async () => {
      await result.current.loadOlder();
    });

    // The cursor goes back under the name it came out under.
    expect(loadPage).toHaveBeenLastCalledWith("conv-1", { before: "cursor-2", limit: 50 });
    expect(result.current.messages.map((entry) => entry.body)).toEqual(["two", "three"]);
    expect(result.current.hasMore).toBe(false);

    // And a re-delivered page cannot double a message.
    await act(async () => {
      await result.current.loadOlder();
    });
    expect(result.current.messages).toHaveLength(2);
  });

  it("shows a sent message as pending, then as the server's record", async () => {
    const sentRecord = message({
      id: "m-out",
      direction: "outbound",
      author: "gluy",
      body: "please rebase",
      deliveryStatus: "delivered",
      turnId: null,
      seq: 5,
    });
    let release: ((result: SendResult) => void) | null = null;
    const sendMessage = vi.fn(
      () =>
        new Promise<SendResult>((resolve) => {
          release = resolve;
        }),
    );
    const { result } = renderHook(() =>
      useAgentChat({ target: SESSION_TARGET, author: "gluy", deps: deps({ sendMessage }) }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      void result.current.send("please rebase");
    });
    expect(result.current.locals).toMatchObject([{ status: "pending", body: "please rebase" }]);

    await act(async () => {
      release!({ ok: true, message: sentRecord, error: null });
    });
    await waitFor(() => expect(result.current.locals).toHaveLength(0));
    expect(result.current.messages.map((entry) => entry.deliveryStatus)).toEqual(["delivered"]);
  });

  it("does not double a message whose own event arrives before the response", async () => {
    const streams: StreamHarness[] = [];
    const sentRecord = message({
      id: "m-out",
      direction: "outbound",
      author: "gluy",
      body: "ship it",
      deliveryStatus: "delivered",
      turnId: null,
      seq: 5,
    });
    let release: ((result: SendResult) => void) | null = null;
    const { result } = renderHook(() =>
      useAgentChat({
        target: SESSION_TARGET,
        author: "gluy",
        deps: deps({
          subscribe: subscribeStub(streams),
          sendMessage: () =>
            new Promise<SendResult>((resolve) => {
              release = resolve;
            }),
        }),
      }),
    );
    await waitFor(() => expect(streams.length).toBeGreaterThan(0));

    await act(async () => {
      void result.current.send("ship it");
    });
    await act(async () => {
      streams[0]!.emit(appended(sentRecord));
    });
    // The optimistic bubble is reconciled by what the human typed — the server
    // assigns the id, so there is nothing else the two have in common.
    expect(result.current.locals).toHaveLength(0);
    expect(result.current.messages).toHaveLength(1);

    await act(async () => {
      release!({ ok: true, message: sentRecord, error: null });
    });
    expect(result.current.messages).toHaveLength(1);
  });

  it("keeps the message when delivery fails and the server recorded it", async () => {
    // The server records outbound messages BEFORE attempting delivery and
    // returns the row on the error path too, so the panel can mark the bubble
    // it already drew instead of dropping it: "a message that vanished is
    // indistinguishable from one the agent ignored".
    const failedRecord = message({
      id: "m-failed",
      direction: "outbound",
      author: "gluy",
      body: "are you there",
      deliveryStatus: "failed",
      deliveryDetail: "session desk-1 has ended",
      turnId: null,
      seq: 6,
    });
    const { result } = renderHook(() =>
      useAgentChat({
        target: SESSION_TARGET,
        author: "gluy",
        deps: deps({
          sendMessage: async () => ({ ok: false, message: failedRecord, error: "session_ended" }),
        }),
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.send("are you there");
    });
    expect(result.current.locals).toHaveLength(0);
    expect(result.current.messages[0]?.deliveryStatus).toBe("failed");
  });

  it("keeps an unrecorded message on screen as failed, and retries it", async () => {
    const results: SendResult[] = [
      { ok: false, message: null, error: "could not reach the event server" },
      {
        ok: true,
        message: message({
          id: "m-retried",
          direction: "outbound",
          author: "gluy",
          body: "retry me",
          deliveryStatus: "delivered",
          turnId: null,
          seq: 7,
        }),
        error: null,
      },
    ];
    const sendMessage = vi.fn(async () => results.shift()!);
    const { result } = renderHook(() =>
      useAgentChat({ target: SESSION_TARGET, author: "gluy", deps: deps({ sendMessage }) }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.send("retry me");
    });
    expect(result.current.locals).toMatchObject([
      { status: "failed", detail: "could not reach the event server" },
    ]);

    await act(async () => {
      await result.current.retryLocal(result.current.locals[0]!.localId);
    });
    expect(result.current.locals).toHaveLength(0);
    expect(result.current.messages[0]?.id).toBe("m-retried");
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("refuses to send a whitespace-only message, as the server does", async () => {
    const sendMessage = vi.fn(async () => ({ ok: true, message: null, error: null }));
    const { result } = renderHook(() =>
      useAgentChat({ target: SESSION_TARGET, author: "gluy", deps: deps({ sendMessage }) }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.send("   ");
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(result.current.locals).toHaveLength(0);
  });

  it("never shows one conversation's messages under another's header", async () => {
    // Rapid switching while both desks are active. The slow page belongs to
    // the desk the user has already left; applying it would put desk A's
    // words under desk B's name.
    const slow = page({
      conversation: CONVERSATION,
      messages: [message({ id: "slow", body: "from desk A" })],
    });
    const fast = page({
      conversation: { ...CONVERSATION, id: "conv-2", owner: "agent2" } as ConversationRecord,
      messages: [message({ id: "fast", conversationId: "conv-2", body: "from desk B" })],
      segments: [segment({ id: "seg-b", conversationId: "conv-2", claudeSessionId: "claude-2" })],
    });
    let releaseSlow: (() => void) | null = null;
    const loadPage = vi.fn(async (id: string) => {
      if (id === "conv-1") {
        await new Promise<void>((resolve) => {
          releaseSlow = resolve;
        });
        return slow;
      }
      return fast;
    });
    const resolveConversation = vi.fn(async (sessionId: string) => ({
      conversation:
        sessionId === "desk-1"
          ? CONVERSATION
          : ({ ...CONVERSATION, id: "conv-2", owner: "agent2" } as ConversationRecord),
      segments: [segment()],
      current_segment: segment(),
    }));

    const { result, rerender } = renderHook(
      (props: { target: ChatTarget }) =>
        useAgentChat({
          target: props.target,
          author: "gluy",
          deps: deps({ loadPage, resolveConversation }),
        }),
      { initialProps: { target: SESSION_TARGET } },
    );

    await waitFor(() => expect(releaseSlow).not.toBeNull());
    // Switch desks while desk A's page is still in flight.
    rerender({ target: { kind: "session", sessionId: "desk-2" } });
    await waitFor(() => expect(result.current.conversation?.id).toBe("conv-2"));

    await act(async () => {
      releaseSlow!();
      await Promise.resolve();
    });

    expect(result.current.conversation?.id).toBe("conv-2");
    expect(result.current.messages.map((entry) => entry.body)).toEqual(["from desk B"]);
    expect(result.current.messages.some((entry) => entry.body === "from desk A")).toBe(false);
  });

  it("surfaces a load failure instead of an empty transcript", async () => {
    const { result } = renderHook(() =>
      useAgentChat({
        target: SESSION_TARGET,
        author: "gluy",
        deps: deps({
          loadPage: async () => {
            throw new Error("404 no conversation");
          },
        }),
      }),
    );
    await waitFor(() => expect(result.current.error).toContain("404"));
    expect(result.current.loading).toBe(false);
  });
});

// --- The panel ---------------------------------------------------------------------

function renderPanel(overrides: Partial<AgentChatDeps> = {}, panelProps: Partial<{ draft: string }> = {}) {
  const streams: StreamHarness[] = [];
  const view = render(
    <ChatPanel
      target={SESSION_TARGET}
      author="gluy"
      draft={panelProps.draft ?? ""}
      onDraftChange={() => {}}
      onClose={() => {}}
      deps={deps({ subscribe: subscribeStub(streams), ...overrides })}
    />,
  );
  return { view, streams };
}

describe("ChatPanel", () => {
  it("labels every message by sender and renders markup as text", async () => {
    // A reply containing a script tag is displayed literally, not executed:
    // nothing in this feature uses dangerouslySetInnerHTML.
    const hostile = "<script>alert('x')</script> **not bold**";
    renderPanel({
      loadPage: async () =>
        page({
          messages: [
            message({ id: "m1", body: hostile }),
            message({
              id: "m2",
              direction: "outbound",
              author: "gluy",
              body: "noted",
              deliveryStatus: "delivered",
              seq: 2,
              turnId: null,
            }),
          ],
        }),
    });

    await waitFor(() => expect(screen.getByText(hostile)).toBeTruthy());
    expect(document.querySelector(".chat-message__body script")).toBeNull();
    expect(document.querySelector("script")).toBeNull();
    // Every message is attributed. Scoped to the bubbles, because the
    // composer also names the author it will send as.
    const authors = [...document.querySelectorAll(".chat-message__author")].map(
      (node) => node.textContent,
    );
    expect(authors).toEqual(["agent:dept_lead:dev", "gluy"]);
    const bubbles = [...document.querySelectorAll(".chat-message")];
    expect(bubbles.map((bubble) => bubble.getAttribute("data-direction"))).toEqual([
      "inbound",
      "outbound",
    ]);
  });

  it("says that a message waits for the agent's current turn", async () => {
    // The design is explicit that chat alone cannot stop a wrong direction.
    renderPanel();
    await waitFor(() => expect(screen.getByText(QUEUE_NOTE)).toBeTruthy());
    expect(QUEUE_NOTE).toContain("wait until its current turn ends");
    expect(QUEUE_NOTE).toContain("cannot stop work that is already running");
  });

  it("tells the truth about a queued message: nothing will re-send it", async () => {
    renderPanel({
      loadPage: async () =>
        page({
          messages: [
            message({
              id: "m-queued",
              direction: "outbound",
              author: "gluy",
              body: "status?",
              deliveryStatus: "queued",
              deliveryDetail: "a permission dialog is open",
              turnId: null,
            }),
          ],
        }),
    });
    await waitFor(() => expect(screen.getByText(/Nothing will re-send it/)).toBeTruthy());
    // 008 refuses to deliver into an open dialog because delivering there
    // approves the pending tool call, and nothing re-drains that queue.
    expect(screen.getByText("Send again")).toBeTruthy();
  });

  it("renders the session boundary rather than a seamless join", async () => {
    renderPanel({
      loadPage: async () =>
        page({
          segments: [
            segment({ id: "seg-1", ordinal: 1, endReason: "paused" }),
            segment({
              id: "seg-2",
              ordinal: 2,
              claudeSessionId: "claude-2",
              previousEndReason: "paused",
            }),
          ],
          messages: [
            message({ id: "before", segmentId: "seg-1", seq: 1, body: "working on it" }),
            message({ id: "after", segmentId: "seg-2", seq: 2, body: "back" }),
          ],
        }),
    });

    await waitFor(() => expect(document.querySelector(".chat-divider")).toBeTruthy());
    expect(screen.getByText(/the work was paused/)).toBeTruthy();
    expect(
      screen.getByText("The agent below does not remember anything above this line."),
    ).toBeTruthy();
    expect(screen.getByText(/No handoff was restored/)).toBeTruthy();
  });

  it("renders tool activity subordinately, and collapses it", async () => {
    const streams: StreamHarness[] = [];
    render(
      <ChatPanel
        target={SESSION_TARGET}
        author="gluy"
        draft=""
        onDraftChange={() => {}}
        onClose={() => {}}
        deps={deps({ subscribe: subscribeStub(streams) })}
      />,
    );
    await waitFor(() => expect(streams).toHaveLength(2));

    await act(async () => {
      streams[1]!.emit({
        id: "tool-1",
        projectId: null,
        sessionId: "claude-1",
        type: "PreToolUse",
        payload: {
          tool_name: "Bash",
          tool_input: { command: "pnpm vitest run" },
          prompt_id: "turn-9",
        },
        receivedAt: "2026-10-10 09:02:00+00",
        cursor: "c",
      });
    });

    await waitFor(() => expect(document.querySelector(".chat-action")).toBeTruthy());
    // Not a message bubble: an action line is a margin note, never something
    // anyone said.
    expect(document.querySelector(".chat-action")?.closest(".chat-message")).toBeNull();
    expect(screen.getByText("pnpm vitest run")).toBeTruthy();

    act(() => screen.getByText("Hide recent actions").click());
    expect(document.querySelector(".chat-action")).toBeNull();
    act(() => screen.getByText("Show recent actions").click());
    expect(document.querySelector(".chat-action")).toBeTruthy();
  });

  it("offers a 'new messages' affordance instead of yanking a reader to the end", async () => {
    const streams: StreamHarness[] = [];
    render(
      <ChatPanel
        target={SESSION_TARGET}
        author="gluy"
        draft=""
        onDraftChange={() => {}}
        onClose={() => {}}
        deps={deps({
          subscribe: subscribeStub(streams),
          loadPage: async () => page({ messages: [message({ id: "m1", seq: 1 })] }),
        })}
      />,
    );
    await waitFor(() => expect(streams.length).toBeGreaterThan(0));

    // jsdom reports every element as 0×0, so the scroll position has to be
    // installed by hand. This asserts the decision, not the rendering: the
    // real "the view did not move" check needs a browser (ticket 030).
    const scroller = document.querySelector(".chat-transcript__scroll") as HTMLElement;
    Object.defineProperty(scroller, "scrollHeight", { value: 2_000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 400, configurable: true });
    scroller.scrollTop = 100;
    act(() => scroller.dispatchEvent(new Event("scroll")));

    await act(async () => {
      streams[0]!.emit(appended(message({ id: "m2", seq: 2, body: "later" })));
    });

    const affordance = await screen.findByText(/1 new message/);
    expect(affordance.textContent).toContain("jump to the end");
    expect(scroller.scrollTop).toBe(100); // not yanked

    act(() => affordance.click());
    expect(scroller.scrollTop).toBe(2_000);
    expect(screen.queryByText(/new message/)).toBeNull();
  });

  it("backfills older history from the top affordance", async () => {
    const loadPage = vi.fn(async (_id: string, params: { before?: string | null }) =>
      params.before
        ? page({ messages: [message({ id: "older", seq: 1, body: "earlier" })], next_before: null })
        : page({ messages: [message({ id: "newer", seq: 2, body: "latest" })], next_before: "cur" }),
    );
    renderPanel({ loadPage });

    const button = await screen.findByText("Load earlier messages");
    await act(async () => {
      button.click();
    });

    await waitFor(() => expect(screen.getByText("earlier")).toBeTruthy());
    const bodies = [...document.querySelectorAll(".chat-message__body")].map(
      (node) => node.textContent,
    );
    expect(bodies).toEqual(["earlier", "latest"]);
    expect(screen.getByText("The start of this conversation.")).toBeTruthy();
  });

  it("warns, rather than pretends, when the desk has ended", async () => {
    renderPanel({ loadDesk: async () => ({ ...DESK, status: "ended" }) as DeskInfo });
    await waitFor(() => expect(screen.getByText(/This desk has ended/)).toBeTruthy());
  });

  it("shows the model read-only, because switching it live does not exist yet", async () => {
    renderPanel();
    const chip = await waitFor(() => {
      const found = document.querySelector(".chat-panel__model");
      expect(found).toBeTruthy();
      return found;
    });
    expect(chip?.textContent).toBe("claude-sonnet-5");
    expect(chip?.tagName).toBe("SPAN");
    expect(chip?.getAttribute("title")).toContain("not available in this build");
  });
});

// --- The overlay -------------------------------------------------------------------

/** A socket that never connects, so the overlay's real ws client does not try
 *  to reach a server from jsdom. */
class SilentSocket {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  send(): void {}
  close(): void {}
}

function stubApi(): void {
  vi.stubGlobal("WebSocket", SilentSocket as unknown as typeof WebSocket);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes("/conversation")
      ? { conversation: CONVERSATION, segments: [segment()], current_segment: segment() }
      : url.includes("/messages")
        ? page()
        : DESK;
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  });
}

/** The live composer, once the panel has resolved its conversation. */
async function composer(): Promise<HTMLTextAreaElement> {
  return waitFor(() => {
    const box = document.querySelector(".chat-composer__input") as HTMLTextAreaElement | null;
    expect(box).toBeTruthy();
    expect(box!.disabled).toBe(false);
    return box!;
  });
}

/** `fireEvent.change`, not a hand-set `.value`: React tracks the value
 *  property behind a descriptor, so assigning it directly updates the DOM and
 *  never reaches `onChange` — which would make a draft test pass while the
 *  draft was never stored anywhere. */
async function type(text: string): Promise<void> {
  const box = await composer();
  fireEvent.change(box, { target: { value: text } });
  await waitFor(() => expect(box.value).toBe(text));
}

describe("the chat overlay", () => {
  it("renders nothing until something opens it", () => {
    stubApi();
    render(<ChatOverlay />);
    expect(document.querySelector(".chat-panel")).toBeNull();
  });

  it("opens over any page and keeps an unsent draft across a close", async () => {
    stubApi();
    render(<ChatOverlay />);

    act(() => openChatPanel({ kind: "conversation", conversationId: "conv-1" }));
    await type("half a thought");

    act(() => closeChatPanel());
    // Closed means gone from the DOM: 022's overlay host gives anything an
    // overlay renders `pointer-events: auto`, so a panel left mounted would
    // be an invisible click target over the page.
    expect(document.querySelector(".chat-panel")).toBeNull();

    act(() => openChatPanel({ kind: "conversation", conversationId: "conv-1" }));
    expect((await composer()).value).toBe("half a thought");
  });

  it("keeps one desk's draft out of another desk's composer", async () => {
    stubApi();
    render(<ChatOverlay />);

    act(() => openChatPanel({ kind: "conversation", conversationId: "conv-1" }));
    await type("for desk one");

    act(() => openChatPanel({ kind: "conversation", conversationId: "conv-2" }));
    expect((await composer()).value).toBe("");

    act(() => openChatPanel({ kind: "conversation", conversationId: "conv-1" }));
    expect((await composer()).value).toBe("for desk one");
  });

  it("mounts only slot modules that opt in, so 027 cannot be handed props it never agreed to", () => {
    const marked = () => <span>controls</span>;
    const unmarked = () => <span>something else</span>;
    const collected = collectChatSlots({
      "./AgentControls.tsx": { default: marked, chatSlot: "header" },
      "./BlockedBanner.tsx": { default: unmarked, chatSlot: "banner" },
      "./Unmarked.tsx": { default: unmarked },
    });
    expect(collected.map((slot) => [slot.name, slot.where])).toEqual([
      ["AgentControls.tsx", "header"],
      ["BlockedBanner.tsx", "banner"],
    ]);
    // Nothing is contributed today: 027 has not landed, and this file's own
    // components are excluded by the glob rather than filtered by luck.
    expect(collectChatSlots()).toEqual([]);
  });

  it("keys the draft store per target", () => {
    expect(chatTargetKey({ kind: "session", sessionId: "d1" })).not.toBe(
      chatTargetKey({ kind: "session", sessionId: "d2" }),
    );
    expect(chatTargetKey({ kind: "session", sessionId: "d1", taskId: "t1" })).not.toBe(
      chatTargetKey({ kind: "session", sessionId: "d1" }),
    );
    expect(chatTargetKey(null)).toBe("");
  });
});
