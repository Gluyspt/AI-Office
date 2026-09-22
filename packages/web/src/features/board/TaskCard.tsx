// The task card: what a person reads to decide what needs attention.
//
// The design lists its contents exactly — title, owner, department, model,
// owned files, elapsed time, token cost — and what the card shows and hides
// is the whole value of the page. Two decisions follow from that:
//
//   - Elapsed time is the chip's duration, not a separate field. State and
//     duration are one fact ("paused · 2d"); splitting them makes the board
//     harder to scan, not easier.
//   - Anything without a real source says so. Token cost renders "not
//     measured yet" rather than "0", because a zero that looks like a
//     measurement is worse than an honest gap, and the same rule governs
//     owned files below.
//
//
// WHAT HAS NO SOURCE YET, AND WHY IT IS A PROP
// ---------------------------------------------
// Three things this card is specified to show do not exist in the data yet:
//
//   - **Owned files.** `TaskRecord` has no file-scope field. Nothing stores
//     a task's declared scope — that question was deliberately deferred to
//     ticket 019 (see docs/tasks/README.md). `file_locks` holds *acquired*
//     scope, which is empty for a draft.
//   - **The unguarded-edit flag**, which ticket 020's retroactive check
//     raises.
//   - **The gate-bypassed flag** and the "Advance (no gate yet)" control,
//     both ticket 032's.
//
// Each arrives as an optional prop rather than being invented here. A card
// given none of them renders correctly and says nothing false; the tickets
// that own the data pass it in without this file changing.
import { useState, type ReactNode } from "react";
import type { TaskRecord } from "@office/shared/tasks";
import { StateChip } from "./StateChip.tsx";
import "./task-card.css";

/** How many file paths to show before collapsing to a count. An eight-file
 * scope must not make the card unreadable. */
const FILES_SHOWN = 1;

export interface TaskCardProps {
  readonly task: TaskRecord;
  /**
   * Declared file scope. Absent until ticket 019 decides where a task's
   * scope is stored — the card renders an honest "not declared" rather
   * than an empty list that reads as "touches nothing".
   */
  readonly fileScope?: readonly string[];
  /** Ticket 020: this task made an edit the guard never saw. */
  readonly unguardedEdit?: boolean;
  /** Ticket 032: advanced without passing a real gate. */
  readonly gateBypassed?: boolean;
  /** Ticket 032's interim control, rendered for `ready_for_qa`. A slot, so
   * that ticket owns the control and this file is not edited when it is
   * removed at step 6. */
  readonly advanceControl?: ReactNode;
  readonly now?: Date;
  /** Overridable for tests; defaults to navigating to Task detail. */
  readonly onOpen?: (task: TaskRecord) => void;
}

export function TaskCard({
  task,
  fileScope,
  unguardedEdit = false,
  gateBypassed = false,
  advanceControl,
  now,
  onOpen,
}: TaskCardProps): React.ReactElement {
  const [filesOpen, setFilesOpen] = useState(false);

  const open = (): void => {
    if (onOpen) {
      onOpen(task);
      return;
    }
    // Ticket 022's router upgrades a same-origin href to client-side
    // navigation; this mapping is permanent, so it never has to be
    // retrained.
    window.history.pushState({}, "", `/tasks/${task.id}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };

  const files = fileScope ?? [];
  const hiddenFileCount = Math.max(0, files.length - FILES_SHOWN);

  return (
    <article
      className="task-card"
      data-task-id={task.id}
      data-department={task.department}
    >
      {/* The whole card is the click target, but the accessible action is a
          real button: keyboard reachable, activatable with Enter and Space,
          and announced as a link to the task rather than as a div. */}
      <button type="button" className="task-card__open" onClick={open}>
        {/* title attribute and full text for a screen reader; CSS truncates
            visually without hiding it from either. */}
        <span className="task-card__title" title={task.title}>
          {task.title}
        </span>
      </button>

      <div className="task-card__chips">
        <StateChip state={task.state} since={task.stateEnteredAt} now={now} />
        {unguardedEdit ? (
          // Deliberately not a pipeline chip: this is not a stage the task
          // is at, it is a thing that needs a human.
          <span className="marker marker--review" data-marker="unguarded-edit">
            unguarded edit — needs review
          </span>
        ) : null}
        {gateBypassed ? (
          <span className="marker marker--bypass" data-marker="gate-bypassed">
            gate bypassed
          </span>
        ) : null}
      </div>

      <dl className="task-card__meta">
        <div className="task-card__field">
          <dt>Owner</dt>
          <dd>{task.owner}</dd>
        </div>
        <div className="task-card__field">
          <dt>Dept</dt>
          <dd>{task.department}</dd>
        </div>
        <div className="task-card__field">
          <dt>Model</dt>
          {/* Read-only here. The design puts a clickable model chip on the
              *agent* card in the chat panel; whether the task card's is
              clickable is not stated, so the switch stays in ticket 027. */}
          <dd>{task.model ?? "role default"}</dd>
        </div>
        <div className="task-card__field">
          <dt>Tokens</dt>
          <dd>
            {task.tokenCost > 0 ? (
              task.tokenCost.toLocaleString()
            ) : (
              // Not "0". Nothing feeds this until step 7's OTEL collection,
              // and a zero that looks like a measurement is worse than an
              // honest gap.
              <span className="task-card__unmeasured">not measured yet</span>
            )}
          </dd>
        </div>
      </dl>

      <div className="task-card__files">
        <span className="task-card__files-label">Files</span>
        {fileScope === undefined ? (
          <span className="task-card__unmeasured">not declared</span>
        ) : files.length === 0 ? (
          <span className="task-card__unmeasured">none</span>
        ) : (
          <>
            <span className="task-card__file">{files[0]}</span>
            {hiddenFileCount > 0 ? (
              <button
                type="button"
                className="task-card__files-more"
                aria-expanded={filesOpen}
                onClick={() => setFilesOpen((value) => !value)}
              >
                {filesOpen ? "show less" : `+${hiddenFileCount} more`}
              </button>
            ) : null}
            {filesOpen ? (
              <ul className="task-card__file-list">
                {files.slice(FILES_SHOWN).map((path) => (
                  <li key={path}>{path}</li>
                ))}
              </ul>
            ) : null}
          </>
        )}
      </div>

      {task.state === "ready_for_qa" && advanceControl ? (
        <div className="task-card__actions">{advanceControl}</div>
      ) : null}
    </article>
  );
}
