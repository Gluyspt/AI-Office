// The panel: who you are talking to, what they have been doing, and a box.
//
// Ticket 026. Slides in over whatever page is open, owns its own state, and
// takes nothing from the shell — 022's overlay convention.
//
// WHAT THIS FILE DELIBERATELY DOES NOT DO
//
//  * **Interrupt, Kill and the model switch are ticket 027's.** They arrive
//    through `headerSlot`; the model is rendered here as a read-only chip
//    because live model switching is unavailable until step 11 and the panel
//    must not offer a control that cannot work.
//  * **The blocked banner is ticket 027's**, through `bannerSlot`.
//  * It invents no agent state. "Working" is inferred from tool events and
//    said as what it is — *last seen using X* — because there is no streaming
//    of an agent's output in this build and a spinner would be a claim.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ChatMessageRecord, ConversationRecord } from "@office/shared/chat";
import { ChatComposer } from "./ChatComposer.tsx";
import { ChatTranscript } from "./ChatTranscript.tsx";
import {
  useAgentChat,
  type AgentChatDeps,
  type ChatTarget,
  type DeskInfo,
  type RecentAction,
} from "./useAgentChat.ts";
import "./chat.css";

/** The contract for a panel extra contributed by a later ticket — see
 *  overlay.tsx. A slot that ignores every prop still works. */
export interface ChatSlotProps {
  readonly target: ChatTarget;
  readonly conversation: ConversationRecord | null;
  readonly desk: DeskInfo | null;
  readonly refresh: () => void;
}

const ROLE_LABELS: Readonly<Record<string, string>> = {
  management_lead: "Management lead",
  dept_lead: "Department lead",
  worker: "Worker",
};

function roleLabel(role: string | null): string | null {
  if (role === null || role === "") return null;
  return ROLE_LABELS[role] ?? role;
}

export interface AgentIdentity {
  readonly title: string;
  readonly subtitle: string | null;
  /** Task conversations get a link into Task detail (ticket 031). */
  readonly taskId: string | null;
}

/**
 * Who the header says this is, from what is actually known.
 *
 * The desk row is the best source (role, department, Linux account, model);
 * the conversation is the fallback, and for a role-slot conversation it
 * carries the same identity tuple. A conversation about a task whose desk
 * nobody can find says so instead of guessing — nothing in the schema links
 * a session to a task yet, so that case is real.
 */
export function describeAgent(
  desk: DeskInfo | null,
  conversation: ConversationRecord | null,
): AgentIdentity {
  if (desk !== null) {
    const parts = [roleLabel(desk.role), desk.dept].filter((part): part is string => !!part);
    return {
      title: parts.join(" · ") || "Agent",
      subtitle: `${desk.owner} · ${desk.status}`,
      taskId: conversation?.taskId ?? null,
    };
  }
  if (conversation !== null && conversation.subjectKind === "role_slot") {
    const parts = [roleLabel(conversation.role), conversation.dept].filter(
      (part): part is string => !!part,
    );
    return {
      title: parts.join(" · ") || "Role slot",
      subtitle: conversation.owner,
      taskId: null,
    };
  }
  if (conversation !== null && conversation.taskId !== null) {
    return { title: "Task conversation", subtitle: null, taskId: conversation.taskId };
  }
  return { title: "Agent", subtitle: null, taskId: null };
}

/** Coarse "how long ago", in the house style of 024's chip duration: a
 *  measurement that just happened reads "just now", never "0m".
 *
 *  Local rather than shared because there is no shared UI-helper module in
 *  022's scope, and creating one here would be a file no ticket owns. */
export function agoText(at: string, now: Date = new Date()): string {
  const started = new Date(at);
  const ms = now.getTime() - started.getTime();
  if (!Number.isFinite(ms)) return "at an unknown time";
  if (ms < 60_000) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export interface Activity {
  readonly kind: "tooling" | "awaiting_reply";
  readonly text: string;
}

/**
 * What to say between the transcript and the box.
 *
 * There is no token-by-token streaming in this build — the design lists a
 * MessageDisplay hook as a later enhancement — so between a message being
 * sent and the turn ending the panel has exactly two facts available: tool
 * calls arriving, and an outbound message having been delivered. It reports
 * those two and nothing else.
 *
 * The open question this answers, and its cost, is recorded in the ticket: an
 * agent that thinks for ten minutes without calling a tool looks idle here.
 * Saying "last seen using Bash, 4m ago" rather than animating a "working"
 * spinner is what keeps that honest — a stale indicator is visible as stale.
 */
export function describeActivity(input: {
  readonly actions: readonly RecentAction[];
  readonly messages: readonly ChatMessageRecord[];
  readonly now?: Date;
}): Activity | null {
  const replied = new Set(
    input.messages
      .filter((message) => message.direction === "inbound" && message.turnId !== null)
      .map((message) => message.turnId as string),
  );
  const openAction = [...input.actions]
    .reverse()
    .find((action) => action.turnId === null || !replied.has(action.turnId));
  if (openAction !== undefined) {
    const detail = openAction.detail === null ? "" : ` — ${openAction.detail}`;
    return {
      kind: "tooling",
      text: `Last seen using ${openAction.tool}${detail}, ${agoText(openAction.at, input.now)}.`,
    };
  }

  const newest = input.messages[input.messages.length - 1];
  if (newest !== undefined && newest.direction === "outbound") {
    if (newest.deliveryStatus === "delivered" || newest.deliveryStatus === "pending") {
      return {
        kind: "awaiting_reply",
        text: "Waiting for the agent's turn to end. Nothing appears here until it does — there is no live streaming of its output in this build.",
      };
    }
  }
  return null;
}

export interface ChatPanelProps {
  readonly target: ChatTarget;
  /** The name a sent message is attributed to. There is no authentication
   *  until step 9; the caller passes the dev identity. */
  readonly author: string;
  readonly draft: string;
  readonly onDraftChange: (text: string) => void;
  readonly onClose: () => void;
  /** Ticket 027's agent controls. */
  readonly headerSlot?: ReactNode;
  /** Ticket 027's blocked banner. */
  readonly bannerSlot?: ReactNode;
  /** Injected in tests. */
  readonly deps?: AgentChatDeps;
}

export function ChatPanel({
  target,
  author,
  draft,
  onDraftChange,
  onClose,
  headerSlot,
  bannerSlot,
  deps,
}: ChatPanelProps): React.ReactElement {
  const chat = useAgentChat({ target, author, deps });
  const [showActions, setShowActions] = useState(true);
  // Mounted closed, opened on the next frame, so the slide-in transition has
  // two states to animate between. Unmounting on close is what keeps a closed
  // panel from being an invisible click target over the page (022's overlay
  // host makes anything an overlay renders take pointer events back).
  const [entered, setEntered] = useState(false);
  const panel = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  const identity = useMemo(
    () => describeAgent(chat.desk, chat.conversation),
    [chat.desk, chat.conversation],
  );
  const activity = useMemo(
    () => describeActivity({ actions: chat.actions, messages: chat.messages }),
    [chat.actions, chat.messages],
  );

  const deskEnded = chat.desk?.status === "ended" || chat.desk?.status === "failed";

  return (
    <aside
      className="chat-panel"
      ref={panel}
      data-open={entered ? "true" : "false"}
      data-stale={chat.stale ? "true" : undefined}
      role="dialog"
      aria-label={`Chat with ${identity.title}`}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="chat-panel__header">
        <div className="chat-panel__who">
          <h2 className="chat-panel__title">{identity.title}</h2>
          {identity.subtitle !== null ? (
            <p className="chat-panel__subtitle">{identity.subtitle}</p>
          ) : null}
          {identity.taskId !== null ? (
            <a className="chat-panel__task" href={`/tasks/${identity.taskId}`}>
              Task detail
            </a>
          ) : null}
        </div>

        <div className="chat-panel__meta">
          {chat.desk !== null ? (
            // Read-only on purpose: live model switching is unavailable until
            // step 11, and a chip that looks clickable and does nothing is
            // worse than one that does not.
            // The class is this feature's own, not 024's `.chip`: that
            // stylesheet is loaded by the task card, so borrowing its classes
            // would make the panel's look depend on whether a board happens
            // to be on the page.
            <span
              className="chat-panel__model"
              title="Switching an agent's model while it runs is not available in this build"
            >
              {chat.desk.model}
            </span>
          ) : null}
          {/* Ticket 027's Interrupt / Kill / model switch land here without
              this file changing. */}
          {headerSlot}
          <button
            type="button"
            className="chat-panel__close"
            onClick={onClose}
            aria-label="Close chat"
          >
            ×
          </button>
        </div>
      </header>

      {bannerSlot}

      {chat.stale ? (
        <p className="chat-panel__notice chat-panel__notice--warn">
          Live updates are disconnected — replies may be missing until this reconnects.
        </p>
      ) : null}

      {chat.error !== null ? (
        <p className="chat-panel__notice chat-panel__notice--error">
          {chat.error}{" "}
          <button type="button" className="chat-link" onClick={chat.refresh}>
            Try again
          </button>
        </p>
      ) : null}

      <div className="chat-panel__actions-toggle">
        <button
          type="button"
          className="chat-link"
          aria-expanded={showActions}
          onClick={() => setShowActions((value) => !value)}
        >
          {showActions ? "Hide recent actions" : "Show recent actions"}
        </button>
      </div>

      <ChatTranscript
        messages={chat.messages}
        locals={chat.locals}
        segments={chat.segments}
        actions={chat.actions}
        showActions={showActions}
        hasMore={chat.hasMore}
        loadingOlder={chat.loadingOlder}
        loading={chat.loading}
        onLoadOlder={() => void chat.loadOlder()}
        onRetryLocal={(localId) => void chat.retryLocal(localId)}
        onResend={(body) => void chat.send(body)}
      />

      {activity !== null ? (
        <p className="chat-panel__activity" data-activity={activity.kind}>
          {activity.text}
        </p>
      ) : null}

      <ChatComposer
        draft={draft}
        onDraftChange={onDraftChange}
        onSend={(body) => void chat.send(body)}
        author={author}
        disabled={chat.conversation === null}
        disabledReason={
          chat.loading ? "Loading the conversation…" : "No conversation to send to yet."
        }
        warning={
          deskEnded
            ? "This desk has ended. A message will be recorded in the transcript but cannot be delivered."
            : undefined
        }
        autoFocus
      />
    </aside>
  );
}
