// Ticket 023's criteria, against fixtures.
//
// The card is ticket 024's, so `renderCard` here is a stub — which is the
// point of the split: this can be tested for every state in the union,
// including states no card design exists for yet.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import {
  TASK_BOARD_COLUMNS,
  TASK_BOARD_COLUMN_OF,
  TASK_STATES,
  type TaskState,
} from "@office/shared/tasks";
import type { BoardCard, StoredEvent } from "../../lib/api.ts";
import type { EventStreamOptions } from "../../lib/ws.ts";
import { Board } from "./Board.tsx";
import { groupByDay, useBoard } from "./useBoard.ts";

afterEach(cleanup);

let seq = 0;
function makeCard(state: TaskState, overrides: Partial<{ id: string; at: Date }> = {}): BoardCard {
  seq += 1;
  const id = overrides.id ?? `task-${seq}`;
  const at = overrides.at ?? new Date("2026-09-23T10:00:00Z");
  return {
    task: {
      id,
      projectId: "p1",
      title: `task ${id}`,
      brief: "",
      department: "dev",
      owner: "gluy",
      state,
      model: null,
      modelReason: null,
      branch: null,
      tokenCost: 0,
      turnCount: 0,
      createdAt: at,
      updatedAt: at,
      stateEnteredAt: at,
    } as unknown as BoardCard["task"],
    column: TASK_BOARD_COLUMN_OF[state],
    chip: state,
  };
}

function columnsFrom(cards: readonly BoardCard[], earlierCount = 0) {
  return TASK_BOARD_COLUMNS.map((column) => ({
    column,
    cards: cards.filter((card) => card.column === column),
    earlierCount: column === "done" ? earlierCount : 0,
  }));
}

const stubCard = (card: BoardCard) => <div data-testid={`card-${card.task.id}`}>{card.chip}</div>;

describe("Board layout", () => {
  it("renders exactly the four design columns, in order", () => {
    render(<Board columns={columnsFrom([])} renderCard={stubCard} />);
    const titles = [...document.querySelectorAll(".column__title")].map((n) => n.textContent);
    expect(titles).toEqual(["Draft", "To do", "In progress", "Done"]);
  });

  it("places every state in the union in the column the shared mapping names", () => {
    // Fixtures for EVERY state, so an unmapped one is caught here rather
    // than in production. The card is a stub, so a state with no card
    // design yet is still covered.
    const cards = TASK_STATES.map((state) => makeCard(state, { id: `s-${state}` }));
    render(<Board columns={columnsFrom(cards)} renderCard={stubCard} />);

    for (const state of TASK_STATES) {
      const card = screen.getByTestId(`card-s-${state}`);
      const column = card.closest(".column");
      expect(column, `${state} rendered outside a column`).toBeTruthy();
      const expected = {
        draft: "Draft",
        todo: "To do",
        in_progress: "In progress",
        done: "Done",
      }[TASK_BOARD_COLUMN_OF[state]];
      expect(column?.getAttribute("data-column-title")).toBe(expected);
    }
  });

  it("renders a meaningful empty state, and Draft's says how work is created", () => {
    render(<Board columns={columnsFrom([])} renderCard={stubCard} />);
    // "Nothing here" would be true and useless — a new user cannot guess
    // that work arrives by asking Management to plan it.
    expect(screen.getByText("No draft batch")).toBeTruthy();
    expect(screen.getByText(/Ask Management to plan work/)).toBeTruthy();
    expect(screen.getByText(/Start working promotes it/)).toBeTruthy();
  });

  it("shows '+N earlier' only when there are earlier tasks, and it applies a filter", () => {
    const onShowEarlier = vi.fn();
    const { rerender } = render(
      <Board columns={columnsFrom([], 0)} renderCard={stubCard} onShowEarlier={onShowEarlier} />,
    );
    expect(screen.queryByText(/earlier/)).toBeNull();

    rerender(
      <Board columns={columnsFrom([], 12)} renderCard={stubCard} onShowEarlier={onShowEarlier} />,
    );
    const button = screen.getByText("+12 earlier");
    act(() => button.click());
    // A filter on the existing bar, not a separate view — the caller (025)
    // applies it and can clear it like any other filter.
    expect(onShowEarlier).toHaveBeenCalledOnce();
  });

  it("marks the board stale while disconnected rather than presenting it as current", () => {
    const { rerender } = render(<Board columns={columnsFrom([])} renderCard={stubCard} />);
    expect(document.querySelector(".board")?.getAttribute("data-stale")).toBeNull();
    rerender(<Board columns={columnsFrom([])} renderCard={stubCard} stale />);
    expect(document.querySelector(".board")?.getAttribute("data-stale")).toBe("true");
  });

  it("renders 200 cards in under 200 ms", () => {
    const cards = Array.from({ length: 200 }, (_, i) =>
      makeCard("in_progress", { id: `bulk-${i}` }),
    );
    const started = performance.now();
    render(<Board columns={columnsFrom(cards)} renderCard={stubCard} />);
    const elapsed = performance.now() - started;
    expect(screen.getAllByTestId(/^card-bulk-/)).toHaveLength(200);
    expect(elapsed).toBeLessThan(200);
  });
});

describe("Done column day grouping", () => {
  const now = new Date("2026-09-23T12:00:00Z");

  it("labels Today, Yesterday, then dates — newest first", () => {
    const cards = [
      makeCard("done", { id: "t", at: new Date("2026-09-23T09:00:00Z") }),
      makeCard("done", { id: "y", at: new Date("2026-09-22T09:00:00Z") }),
      makeCard("done", { id: "old", at: new Date("2026-09-18T09:00:00Z") }),
    ];
    const groups = groupByDay(cards, now);
    expect(groups.map((g) => g.label).slice(0, 2)).toEqual(["Today", "Yesterday"]);
    expect(groups).toHaveLength(3);
    expect(groups[2]!.label).not.toBe("Yesterday");
  });

  it("puts several tasks from one day under one header", () => {
    const cards = [
      makeCard("done", { id: "a", at: new Date("2026-09-23T09:00:00Z") }),
      makeCard("done", { id: "b", at: new Date("2026-09-23T11:00:00Z") }),
    ];
    const groups = groupByDay(cards, now);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.cards).toHaveLength(2);
  });
});

// --- useBoard -------------------------------------------------------------------

interface Harness {
  readonly emit: (event: StoredEvent) => void;
  readonly setStatus: (status: "open" | "reconnecting") => void;
}

function subscribeStub(harness: { current: Harness | null }) {
  return (options: EventStreamOptions) => {
    harness.current = {
      emit: (event) => options.onEvent(event),
      setStatus: (status) => options.onStatus?.(status),
    };
    return { close: () => {}, status: "open" as const, cursor: null };
  };
}

function event(taskId: string, receivedAt: string): StoredEvent {
  return {
    id: `e-${taskId}-${receivedAt}`,
    projectId: "p1",
    sessionId: null,
    type: "TaskCreated",
    payload: { task_id: taskId },
    receivedAt,
    cursor: receivedAt,
  };
}

describe("useBoard", () => {
  it("relocates a task to the right column on an event, without a full reload", async () => {
    const harness: { current: Harness | null } = { current: null };
    const load = vi.fn(async () => ({
      columns: columnsFrom([makeCard("pending", { id: "moving" })]),
      doneWindowDays: 7,
    }));
    const fetchTask = vi.fn(async () => ({
      task: makeCard("in_progress", { id: "moving" }).task,
      history: [],
    }));

    const subscribe = subscribeStub(harness);
    const { result } = renderHook(() =>
      useBoard({ load, fetchTask, subscribe, backfill: async () => [] }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.columns.find((c) => c.column === "todo")!.cards).toHaveLength(1);

    await act(async () => {
      harness.current!.emit(event("moving", "2026-09-23T10:00:01Z"));
    });

    await waitFor(() =>
      expect(result.current.columns.find((c) => c.column === "in_progress")!.cards).toHaveLength(1),
    );
    expect(result.current.columns.find((c) => c.column === "todo")!.cards).toHaveLength(0);
    // A targeted fetch, not a board reload: reloading would lose scroll
    // position and any open interaction.
    expect(load).toHaveBeenCalledTimes(1);
    expect(fetchTask).toHaveBeenCalledWith("moving");
  });

  it("fetches a task it has never seen rather than reloading the board", async () => {
    const harness: { current: Harness | null } = { current: null };
    const load = vi.fn(async () => ({ columns: columnsFrom([]), doneWindowDays: 7 }));
    const fetchTask = vi.fn(async () => ({
      task: makeCard("pending", { id: "brand-new" }).task,
      history: [],
    }));

    const subscribe = subscribeStub(harness);
    const { result } = renderHook(() =>
      useBoard({ load, fetchTask, subscribe, backfill: async () => [] }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      harness.current!.emit(event("brand-new", "2026-09-23T10:00:01Z"));
    });

    await waitFor(() =>
      expect(result.current.columns.find((c) => c.column === "todo")!.cards).toHaveLength(1),
    );
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("discards an older event arriving after a newer one for the same task", async () => {
    const harness: { current: Harness | null } = { current: null };
    const load = vi.fn(async () => ({ columns: columnsFrom([]), doneWindowDays: 7 }));
    const fetchTask = vi.fn(async () => ({
      task: makeCard("in_progress", { id: "racer" }).task,
      history: [],
    }));

    const subscribe = subscribeStub(harness);
    const { result } = renderHook(() =>
      useBoard({ load, fetchTask, subscribe, backfill: async () => [] }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      harness.current!.emit(event("racer", "2026-09-23T10:00:05Z"));
    });
    await waitFor(() => expect(fetchTask).toHaveBeenCalledTimes(1));

    // An older event for the same task, arriving late. Applying it would
    // let a slow reconcile overwrite newer state with older.
    await act(async () => {
      harness.current!.emit(event("racer", "2026-09-23T10:00:01Z"));
    });
    expect(fetchTask).toHaveBeenCalledTimes(1);
  });

  it("goes stale on disconnect and recovers on reconnect", async () => {
    const harness: { current: Harness | null } = { current: null };
    const subscribe = subscribeStub(harness);
    const { result } = renderHook(() =>
      useBoard({
        load: async () => ({ columns: columnsFrom([]), doneWindowDays: 7 }),
        fetchTask: async () => ({ task: makeCard("pending").task, history: [] }),
        subscribe,
        backfill: async () => [],
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => harness.current!.setStatus("reconnecting"));
    expect(result.current.stale).toBe(true);

    act(() => harness.current!.setStatus("open"));
    expect(result.current.stale).toBe(false);
  });

  it("drops a card whose task no longer exists", async () => {
    const harness: { current: Harness | null } = { current: null };
    const subscribe = subscribeStub(harness);
    const { result } = renderHook(() =>
      useBoard({
        load: async () => ({
          columns: columnsFrom([makeCard("pending", { id: "doomed" })]),
          doneWindowDays: 7,
        }),
        fetchTask: async () => {
          throw new Error("404");
        },
        subscribe,
        backfill: async () => [],
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      harness.current!.emit(event("doomed", "2026-09-23T10:00:01Z"));
    });

    await waitFor(() =>
      expect(result.current.columns.every((c) => c.cards.length === 0)).toBe(true),
    );
  });

  it("reconciles every task named in a TasksUnblocked payload", async () => {
    const harness: { current: Harness | null } = { current: null };
    const fetchTask = vi.fn(async (id: string) => ({
      task: makeCard("pending", { id: String(id) }).task,
      history: [],
    }));
    const subscribe = subscribeStub(harness);
    const { result } = renderHook(() =>
      useBoard({
        load: async () => ({ columns: columnsFrom([]), doneWindowDays: 7 }),
        fetchTask: fetchTask as never,
        subscribe,
        backfill: async () => [],
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      harness.current!.emit({
        id: "e-unblocked",
        projectId: "p1",
        sessionId: null,
        type: "TasksUnblocked",
        payload: { unblocked: [{ task_id: "u1" }, { task_id: "u2" }] },
        receivedAt: "2026-09-23T10:00:01Z",
        cursor: "c",
      });
    });

    await waitFor(() => expect(fetchTask).toHaveBeenCalledTimes(2));
  });
});
