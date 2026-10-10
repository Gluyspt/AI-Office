// The composer: type, send, and be told the truth about what sending does.
//
// Ticket 026.
//
// THE NOTE UNDER THE BOX IS A REQUIREMENT, NOT DECORATION. The design is
// explicit that chat alone cannot stop a wrong direction: a message is typed
// into the agent's terminal and **waits for the turn in progress to finish**.
// A composer that looks like an instant-messaging box invites someone to
// type "stop, that's wrong" and watch the agent carry on for ten minutes —
// so the panel says what sending actually does, every time, rather than once
// in a tooltip.
//
// The draft lives in the caller (the overlay) rather than here, because the
// panel unmounts when it closes and the criterion is that closing it does not
// lose an unsent draft.
import type { KeyboardEvent, ReactNode } from "react";

/** Said next to the box, permanently. */
export const QUEUE_NOTE =
  "Sent messages are typed into the agent's terminal and wait until its current turn ends. Chat cannot stop work that is already running.";

export interface ChatComposerProps {
  readonly draft: string;
  readonly onDraftChange: (text: string) => void;
  readonly onSend: (body: string) => void;
  /** Who the message will be attributed to. */
  readonly author: string;
  /** No conversation resolved yet, or no desk to send to. */
  readonly disabled?: boolean;
  readonly disabledReason?: string;
  /** An extra, situational warning — an ended desk, a queued backlog. */
  readonly warning?: ReactNode;
  /** Focus the box on mount. The panel only mounts because a human opened
   *  it, so taking focus is what they were about to do anyway. */
  readonly autoFocus?: boolean;
}

export function ChatComposer({
  draft,
  onDraftChange,
  onSend,
  author,
  disabled = false,
  disabledReason,
  warning,
  autoFocus = false,
}: ChatComposerProps): React.ReactElement {
  // Whitespace-only is empty by the intent of the check — and the server
  // agrees, with a 400. Sending it would cost the agent a turn and read, in
  // the transcript, as the human having said nothing.
  const sendable = !disabled && draft.trim() !== "";

  const submit = (): void => {
    if (!sendable) return;
    onSend(draft);
    onDraftChange("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter sends, Shift+Enter is a newline: an agent brief is often several
    // lines, so the newline has to be reachable without the mouse.
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form
      className="chat-composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {warning !== undefined && warning !== null ? (
        <p className="chat-composer__warning">{warning}</p>
      ) : null}

      <label className="chat-composer__label" htmlFor="chat-composer-input">
        Message the agent as <span className="chat-composer__author">{author}</span>
      </label>
      <textarea
        id="chat-composer-input"
        className="chat-composer__input"
        value={draft}
        placeholder={disabled ? (disabledReason ?? "") : "Enter sends, Shift+Enter for a new line"}
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={onKeyDown}
        disabled={disabled}
        rows={3}
        autoFocus={autoFocus}
      />

      <div className="chat-composer__row">
        <p className="chat-composer__note">{disabled ? disabledReason : QUEUE_NOTE}</p>
        <button type="submit" className="chat-composer__send" disabled={!sendable}>
          Send
        </button>
      </div>
    </form>
  );
}
