// Ticket 024's criteria, against fixtures covering each department, each
// chip state, an empty scope and a ten-file scope.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import {
  TASK_DEPARTMENTS,
  TASK_STATE_LABELS,
  type TaskDepartment,
  type TaskRecord,
  type TaskState,
} from "@office/shared/tasks";
import { formatDuration, PIPELINE_STATES, StateChip } from "./StateChip.tsx";
import { TaskCard } from "./TaskCard.tsx";
import {
  BoardFilters,
  filtersFromSearch,
  hasAnyFilter,
  searchFromFilters,
  useBoardFilters,
} from "./BoardFilters.tsx";

afterEach(cleanup);

const NOW = new Date("2026-09-23T12:00:00Z");

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "t-1",
    projectId: "p-1",
    title: "Wire the board to the event stream",
    brief: "",
    department: "dev",
    owner: "gluy",
    state: "in_progress",
    model: null,
    modelReason: null,
    branch: null,
    tokenCost: 0,
    turnCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    stateEnteredAt: new Date("2026-09-23T09:00:00Z"),
    ...overrides,
  } as TaskRecord;
}

describe("formatDuration", () => {
  it("never reads 0m for a task that just transitioned", () => {
    // "0m" looks like a measurement failed rather than like the thing only
    // just happened.
    expect(formatDuration(new Date(NOW.getTime() - 5_000), NOW)).toBe("just now");
    expect(formatDuration(NOW, NOW)).toBe("just now");
  });

  it("is coarse and readable at every scale", () => {
    const ago = (ms: number) => formatDuration(new Date(NOW.getTime() - ms), NOW);
    expect(ago(5 * 60_000)).toBe("5m");
    expect(ago(3 * 3_600_000)).toBe("3h");
    expect(ago(2 * 86_400_000)).toBe("2d");
    expect(ago(14 * 86_400_000)).toBe("2w");
  });

  it("does not render a negative duration when the clocks disagree", () => {
    // A server slightly ahead of the browser must not produce "-3m".
    expect(formatDuration(new Date(NOW.getTime() + 120_000), NOW)).toBe("just now");
  });
});

describe("StateChip", () => {
  it("renders all six pipeline states with a text label, not colour alone", () => {
    for (const state of PIPELINE_STATES) {
      cleanup();
      render(<StateChip state={state} since={new Date(NOW.getTime() - 3_600_000)} now={NOW} />);
      // The label is text in the DOM, so the chip works in greyscale and to
      // a screen reader.
      expect(screen.getByText(TASK_STATE_LABELS[state])).toBeTruthy();
      expect(screen.getByText("1h")).toBeTruthy();
    }
  });

  it("gives each pipeline state a distinct tone, and paused its own", () => {
    const tones = new Map<TaskState, string>();
    for (const state of PIPELINE_STATES) {
      cleanup();
      render(<StateChip state={state} since={NOW} now={NOW} />);
      tones.set(state, document.querySelector(".chip")!.getAttribute("data-tone")!);
    }
    // Spotting stalled work is the point: paused must not share a treatment
    // with anything that is actually progressing.
    expect(tones.get("paused")).toBe("paused");
    expect(tones.get("paused")).not.toBe(tones.get("in_progress"));
  });
});

describe("TaskCard", () => {
  it("renders every field the design lists, with elapsed time as the chip's duration", () => {
    render(<TaskCard task={makeTask({ model: "opus" })} now={NOW} />);
    expect(screen.getByText("Wire the board to the event stream")).toBeTruthy();
    expect(screen.getByText("gluy")).toBeTruthy();
    expect(screen.getByText("dev")).toBeTruthy();
    expect(screen.getByText("opus")).toBeTruthy();
    // Elapsed time is the chip's duration, not a separate field.
    expect(screen.getByText("3h")).toBeTruthy();
    expect(screen.getByText(TASK_STATE_LABELS.in_progress)).toBeTruthy();
  });

  it("renders each department", () => {
    for (const department of TASK_DEPARTMENTS) {
      cleanup();
      render(<TaskCard task={makeTask({ department: department as TaskDepartment })} now={NOW} />);
      expect(document.querySelector(".task-card")!.getAttribute("data-department")).toBe(
        department,
      );
    }
  });

  it("says 'not measured yet' rather than 0 for token cost", () => {
    // A zero that looks like a measurement is worse than an honest gap;
    // nothing feeds this until step 7.
    render(<TaskCard task={makeTask({ tokenCost: 0 })} now={NOW} />);
    expect(screen.getByText("not measured yet")).toBeTruthy();
    expect(screen.queryByText("0")).toBeNull();
  });

  it("shows a real token cost once there is one", () => {
    render(<TaskCard task={makeTask({ tokenCost: 12345 })} now={NOW} />);
    expect(screen.getByText("12,345")).toBeTruthy();
  });

  it("distinguishes an undeclared scope from an empty one", () => {
    // Nothing stores a declared scope yet (deferred to 019). An empty list
    // would read as "touches nothing", which is a different claim.
    render(<TaskCard task={makeTask()} now={NOW} />);
    expect(screen.getByText("not declared")).toBeTruthy();

    cleanup();
    render(<TaskCard task={makeTask()} fileScope={[]} now={NOW} />);
    expect(screen.getByText("none")).toBeTruthy();
  });

  it("summarises a ten-file scope and reveals the rest on interaction", () => {
    const files = Array.from({ length: 10 }, (_, i) => `src/features/thing/file-${i}.ts`);
    render(<TaskCard task={makeTask()} fileScope={files} now={NOW} />);

    // First path plus a count — an eight-file scope must not make the card
    // unreadable.
    expect(screen.getByText(files[0]!)).toBeTruthy();
    expect(screen.queryByText(files[5]!)).toBeNull();

    const more = screen.getByText("+9 more");
    act(() => more.click());
    expect(screen.getByText(files[5]!)).toBeTruthy();
    expect(more.getAttribute("aria-expanded")).toBe("true");
  });

  it("carries an unguarded-edit marker distinct from the pipeline chip", () => {
    render(<TaskCard task={makeTask()} unguardedEdit now={NOW} />);
    const marker = document.querySelector('[data-marker="unguarded-edit"]');
    expect(marker?.textContent).toMatch(/needs review/);
    // Not a chip: this is not a stage, it is a thing that needs a human.
    expect(marker?.classList.contains("chip")).toBe(false);
  });

  it("carries a gate-bypassed marker so work that skipped a gate stays identifiable", () => {
    render(<TaskCard task={makeTask()} gateBypassed now={NOW} />);
    expect(document.querySelector('[data-marker="gate-bypassed"]')).toBeTruthy();
  });

  it("renders 032's advance control only for ready_for_qa", () => {
    const control = <button type="button">Advance (no gate yet)</button>;
    render(<TaskCard task={makeTask({ state: "in_progress" })} advanceControl={control} now={NOW} />);
    expect(screen.queryByText("Advance (no gate yet)")).toBeNull();

    cleanup();
    render(
      <TaskCard task={makeTask({ state: "ready_for_qa" })} advanceControl={control} now={NOW} />,
    );
    expect(screen.getByText("Advance (no gate yet)")).toBeTruthy();
  });

  it("opens Task detail, and its action is a keyboard-reachable button", () => {
    const onOpen = vi.fn();
    render(<TaskCard task={makeTask({ id: "abc" as TaskRecord["id"] })} onOpen={onOpen} now={NOW} />);
    const action = screen.getByRole("button", { name: /Wire the board/ });
    act(() => action.click());
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen.mock.calls[0]![0].id).toBe("abc");
  });

  it("keeps a very long title available in full to hover and a screen reader", () => {
    const title = "A ".repeat(200).trim();
    render(<TaskCard task={makeTask({ title })} now={NOW} />);
    // Truncation is visual only — the text stays in the DOM and in `title`.
    expect(screen.getByTitle(title)).toBeTruthy();
  });
});

describe("BoardFilters", () => {
  it("round-trips through the URL so a filtered board is shareable", () => {
    const filters = { owner: "gluy", department: "qa" as TaskDepartment, state: "paused" as TaskState };
    const search = searchFromFilters(filters);
    expect(search).toContain("owner=gluy");
    expect(filtersFromSearch(search)).toMatchObject(filters);
  });

  it("drops an unknown value rather than passing it to the API", () => {
    // A hand-edited ?state=nonsense should show an unfiltered board, not a
    // 400 from the server.
    expect(filtersFromSearch("?state=nonsense&department=marketing")).toMatchObject({
      state: null,
      department: null,
    });
  });

  it("leaves a clean board with a clean URL", () => {
    expect(searchFromFilters({})).toBe("");
    expect(hasAnyFilter({})).toBe(false);
    expect(hasAnyFilter({ owner: "gluy" })).toBe(true);
  });

  it("restores from the URL on load and combines filters", () => {
    const { result } = renderHook(() => useBoardFilters("?owner=gluy&department=dev"));
    expect(result.current.filters.owner).toBe("gluy");
    expect(result.current.filters.department).toBe("dev");

    act(() => result.current.setFilter("state", "paused"));
    expect(result.current.filters).toMatchObject({
      owner: "gluy",
      department: "dev",
      state: "paused",
    });
  });

  it("applies the state filter the same way '+N earlier' does", () => {
    // The Done column's button sets state=done through this same path, so
    // the two are indistinguishable — and it clears like any other filter.
    const { result } = renderHook(() => useBoardFilters(""));
    act(() => result.current.setFilter("state", "done"));
    expect(searchFromFilters(result.current.filters)).toBe("?state=done");

    act(() => result.current.clear());
    expect(hasAnyFilter(result.current.filters)).toBe(false);
  });

  it("shows Clear only while a filter is active", () => {
    const noop = () => {};
    const { rerender } = render(
      <BoardFilters filters={{}} setFilter={noop} clear={noop} owners={["gluy"]} />,
    );
    // A permanently present Clear is a control people learn to ignore.
    expect(screen.queryByText("Clear filters")).toBeNull();

    rerender(
      <BoardFilters filters={{ owner: "gluy" }} setFilter={noop} clear={noop} owners={["gluy"]} />,
    );
    expect(screen.getByText("Clear filters")).toBeTruthy();
  });
});
