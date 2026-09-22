// The pipeline chip: which stage a task is at, and how long it has been
// there.
//
// The duration is appended to the chip rather than sitting in its own field
// — "paused · 2d" — because the two are one fact. A person scanning the
// board is asking "is anything stuck?", and a state without a duration
// cannot answer that while a duration without a state is meaningless.
//
// Computed from `stateEnteredAt` alone. No history walk: that is the whole
// point of the column existing (see 0005_tasks.sql). Total age and
// accumulated working time live on Task detail, where there is room.
import { TASK_STATE_LABELS, type TaskState } from "@office/shared/tasks";

/**
 * Coarse and honest.
 *
 * Minutes up to an hour, hours up to a day, then days — nobody scanning a
 * board needs seconds, and a ticking per-card timer on 200 cards is a
 * rendering cost for no information.
 *
 * A task that just transitioned reads "just now", never "0m". "0m" looks
 * like a measurement failed rather than like the thing only just happened.
 */
export function formatDuration(since: Date | string, now: Date = new Date()): string {
  const start = since instanceof Date ? since : new Date(since);
  const ms = now.getTime() - start.getTime();
  if (!Number.isFinite(ms)) return "unknown";
  // A clock skew between server and browser must not render "-3m".
  if (ms < 60_000) return "just now";

  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;

  const weeks = Math.floor(days / 7);
  return `${weeks}w`;
}

/**
 * Severity per state, driving colour.
 *
 * `paused` is deliberately the loudest thing on the board short of an
 * error: spotting stalled work is the reason the chip exists, and paused
 * work looks exactly like working work if the two share a treatment. It
 * also carries a dashed border in CSS, so the distinction survives
 * greyscale, colour blindness and a bad monitor.
 */
const CHIP_TONE: Partial<Record<TaskState, string>> = {
  in_progress: "active",
  paused: "paused",
  ready_for_qa: "waiting",
  ci: "active",
  qa_review: "waiting",
  lead_approval: "waiting",
  delivered: "done",
  done: "done",
  draft: "muted",
  pending: "muted",
};

export interface StateChipProps {
  readonly state: TaskState;
  /** When the task entered this state. */
  readonly since: Date | string;
  readonly now?: Date;
}

export function StateChip({ state, since, now }: StateChipProps): React.ReactElement {
  const label = TASK_STATE_LABELS[state];
  const duration = formatDuration(since, now);
  const tone = CHIP_TONE[state] ?? "muted";

  return (
    <span
      className={`chip chip--${tone}`}
      data-state={state}
      data-tone={tone}
      // The label is always present as text, never colour alone — the chip
      // has to work in greyscale and to a screen reader.
      title={`${label} for ${duration}`}
    >
      <span className="chip__label">{label}</span>
      <span className="chip__sep" aria-hidden="true">
        ·
      </span>
      <span className="chip__duration">{duration}</span>
    </span>
  );
}

/** The six pipeline states the design shows as chips inside In progress.
 * Exported so a test can assert all six render rather than re-listing
 * them. */
export const PIPELINE_STATES: readonly TaskState[] = [
  "in_progress",
  "paused",
  "ready_for_qa",
  "ci",
  "qa_review",
  "lead_approval",
];
