// Board state: one load, then incremental updates from the event stream.
//
// The board is the page the team lives on and it is left open all day, so
// the thing that matters is not the first render — it is that the hundredth
// update does not refetch the world, lose the scroll position, or quietly
// show yesterday's truth.
//
//
// A GAP WORTH KNOWING ABOUT
// -------------------------
// `transition()` in packages/server/src/features/tasks/states.ts emits NO
// event. Nothing in the system currently announces that a task changed
// state — 013 emits TaskCreated, 014 emits TasksUnblocked, 015 emits
// FileLocksSwept, and that is the whole list. So a card will not move
// columns on its own until some ticket emits on transition.
//
// This hook is therefore written to react to *any* event whose payload
// mentions a `task_id`, rather than to a named TaskMoved event that does
// not exist. When 012 or 017 starts emitting on transition, the board picks
// it up with no change here. Flagged in the ticket's open questions.
//
//
// WHY RECONCILE BY FETCH RATHER THAN BY PATCHING THE PAYLOAD
// ----------------------------------------------------------
// An event says *something happened to this task*; it is not a complete
// task row, and payload shapes differ per event type. Patching a card from
// a partial payload means every new event type is a chance to write a card
// that is subtly wrong. Fetching the task by id gives one code path and one
// source of truth, at the cost of a round trip per changed task — which is
// the right trade for a board where a handful of tasks change at a time.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  TASK_BOARD_COLUMNS,
  TASK_BOARD_COLUMN_OF,
  type TaskBoardColumn,
  type TaskRecord,
} from "@office/shared/tasks";
import {
  getBoard,
  getTask,
  listEvents,
  type BoardCard,
  type BoardFilters,
  type StoredEvent,
} from "../../lib/api.ts";
import { openEventStream, type ConnectionStatus } from "../../lib/ws.ts";

export interface BoardColumnView {
  readonly column: TaskBoardColumn;
  readonly cards: readonly BoardCard[];
  /** Completed tasks outside the 7-day window. Non-zero only for `done`. */
  readonly earlierCount: number;
}

export interface BoardState {
  readonly columns: readonly BoardColumnView[];
  readonly doneWindowDays: number;
  readonly status: ConnectionStatus;
  readonly loading: boolean;
  readonly error: string | null;
  /** True once the socket has dropped and the board may be behind. The page
   * must not present stale data as current. */
  readonly stale: boolean;
  readonly refresh: () => void;
}

function cardOf(task: TaskRecord): BoardCard {
  // Column and chip come from the shared mapping, never from a second copy
  // here — a state added to TASK_STATES without a column fails a test in
  // the server package rather than silently vanishing off this board.
  return { task, column: TASK_BOARD_COLUMN_OF[task.state], chip: task.state };
}

/** Events whose payload names a task. Deliberately structural rather than a
 * list of event types: a type added later is picked up without editing
 * this. */
function taskIdOf(event: StoredEvent): string | null {
  const payload = event.payload;
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.task_id === "string") return record.task_id;
  // TasksUnblocked carries a list rather than a single id; the first is
  // enough to trigger reconciliation of the rest through `unblocked`.
  return null;
}

function taskIdsOf(event: StoredEvent): string[] {
  const single = taskIdOf(event);
  if (single) return [single];
  const payload = event.payload as Record<string, unknown> | null;
  const unblocked = payload?.unblocked;
  if (Array.isArray(unblocked)) {
    return unblocked
      .map((entry) =>
        entry && typeof entry === "object" && typeof (entry as { task_id?: unknown }).task_id === "string"
          ? (entry as { task_id: string }).task_id
          : null,
      )
      .filter((id): id is string => id !== null);
  }
  return [];
}

export interface UseBoardOptions {
  readonly filters?: BoardFilters;
  /** Injected in tests. */
  readonly load?: typeof getBoard;
  readonly fetchTask?: typeof getTask;
  readonly subscribe?: typeof openEventStream;
  readonly backfill?: typeof listEvents;
}

export function useBoard(options: UseBoardOptions = {}): BoardState {
  const {
    filters,
    load = getBoard,
    fetchTask = getTask,
    subscribe = openEventStream,
    backfill = listEvents,
  } = options;

  const [cards, setCards] = useState<ReadonlyMap<string, BoardCard>>(new Map());
  const [earlierCount, setEarlierCount] = useState(0);
  const [doneWindowDays, setDoneWindowDays] = useState(7);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  // Last event timestamp applied per task. An older event arriving after a
  // newer one for the same task is discarded rather than applied — without
  // this, a slow reconcile can overwrite a newer state with an older one
  // and the board silently regresses.
  const appliedAt = useRef(new Map<string, string>());

  // Filters are an object literal at most call sites; keying an effect on
  // its identity would reconnect the socket on every render.
  const filterKey = JSON.stringify(filters ?? {});

  // The injected functions live in a ref, and NOT in any dependency array.
  //
  // This is the footgun this hook has to not have: a caller writing
  // `useBoard({ filters: { projectId } })` — or a test writing
  // `load: async () => fixture` — creates a new identity on every render.
  // With those in the deps, the effect re-runs, setState re-renders, and
  // the hook loops forever. Keying on `filterKey` only, and reading the
  // functions through a ref, makes the hook safe to call the obvious way.
  const injected = useRef({ load, fetchTask, subscribe, backfill });
  injected.current = { load, fetchTask, subscribe, backfill };

  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    injected.current
      .load(filters ?? {})
      .then((board) => {
        if (cancelled) return;
        const next = new Map<string, BoardCard>();
        for (const column of board.columns) {
          for (const card of column.cards) next.set(card.task.id, card);
        }
        setCards(next);
        setEarlierCount(board.columns.find((c) => c.column === "done")?.earlierCount ?? 0);
        setDoneWindowDays(board.doneWindowDays);
        appliedAt.current = new Map();
        setError(null);
        setStale(false);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see the
    // `injected` ref above: identity-unstable props must not drive this.
  }, [filterKey, reloadToken]);

  useEffect(() => {
    let cancelled = false;

    const reconcile = async (taskId: string, at: string): Promise<void> => {
      const last = appliedAt.current.get(taskId);
      if (last !== undefined && at <= last) return; // older than what we have
      appliedAt.current.set(taskId, at);
      try {
        const { task } = await injected.current.fetchTask(taskId);
        if (cancelled) return;
        setCards((current) => {
          const next = new Map(current);
          next.set(task.id, cardOf(task));
          return next;
        });
      } catch {
        // A task that 404s was deleted; drop it rather than leaving a card
        // for something that no longer exists.
        if (cancelled) return;
        setCards((current) => {
          if (!current.has(taskId)) return current;
          const next = new Map(current);
          next.delete(taskId);
          return next;
        });
      }
    };

    const stream = injected.current.subscribe({
      projectId: filters?.projectId ?? null,
      backfill: injected.current.backfill,
      onEvent: (event) => {
        // A targeted fetch per changed task, never a full board reload —
        // reloading would lose scroll position and any open interaction.
        for (const id of taskIdsOf(event)) void reconcile(id, event.receivedAt);
      },
      onStatus: (next) => {
        setStatus(next);
        // Once dropped, the board is not known to be current until the
        // stream reconnects and backfills.
        if (next === "reconnecting") setStale(true);
        if (next === "open") setStale(false);
      },
    });

    return () => {
      cancelled = true;
      stream.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- as above.
  }, [filterKey]);

  const columns = useMemo((): BoardColumnView[] => {
    const grouped = new Map<TaskBoardColumn, BoardCard[]>();
    for (const column of TASK_BOARD_COLUMNS) grouped.set(column, []);
    for (const card of cards.values()) grouped.get(card.column)?.push(card);

    const done = grouped.get("done");
    if (done) {
      // Newest first, matching the server's own ordering for the window.
      done.sort(
        (a, b) =>
          new Date(b.task.stateEnteredAt).getTime() - new Date(a.task.stateEnteredAt).getTime(),
      );
    }
    for (const column of TASK_BOARD_COLUMNS) {
      if (column === "done") continue;
      grouped
        .get(column)
        ?.sort(
          (a, b) =>
            new Date(a.task.createdAt).getTime() - new Date(b.task.createdAt).getTime() ||
            a.task.id.localeCompare(b.task.id),
        );
    }

    return TASK_BOARD_COLUMNS.map((column) => ({
      column,
      cards: grouped.get(column) ?? [],
      earlierCount: column === "done" ? earlierCount : 0,
    }));
  }, [cards, earlierCount]);

  return { columns, doneWindowDays, status, loading, error, stale, refresh };
}

// --- Done-column day grouping -------------------------------------------------

export interface DayGroup {
  /** "Today", "Yesterday", or a date like "18 Sep". */
  readonly label: string;
  readonly cards: readonly BoardCard[];
}

/**
 * Groups the Done window under day headers, newest first.
 *
 * `now` is injectable because "Today" is the one label whose correctness
 * depends on when the test runs.
 */
export function groupByDay(
  cards: readonly BoardCard[],
  now: Date = new Date(),
): DayGroup[] {
  const startOfDay = (date: Date): number =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const today = startOfDay(now);
  const dayMs = 24 * 60 * 60 * 1000;

  const groups = new Map<number, BoardCard[]>();
  for (const card of cards) {
    const day = startOfDay(new Date(card.task.stateEnteredAt));
    const bucket = groups.get(day) ?? [];
    bucket.push(card);
    groups.set(day, bucket);
  }

  return [...groups.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([day, group]) => {
      let label: string;
      if (day === today) label = "Today";
      else if (day === today - dayMs) label = "Yesterday";
      else {
        label = new Date(day).toLocaleDateString(undefined, { day: "numeric", month: "short" });
      }
      return { label, cards: group };
    });
}
