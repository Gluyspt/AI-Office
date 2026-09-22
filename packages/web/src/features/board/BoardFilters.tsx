// The filter bar: owner, department, state — combining, shareable, and
// clearable in one action.
//
// Filters live in the URL, not only in component state. A filtered board is
// something people send each other ("look at everything blocked on QA"),
// and a board whose URL does not describe what it is showing cannot be
// shared or reloaded. Restoring from the URL on load is the same property
// read backwards.
//
// The state filter is also the mechanism behind the Done column's "+N
// earlier": that button sets `state=done` here, which is why applying it
// that way is indistinguishable from setting it by hand, and why it clears
// like any other filter. No separate view, no second code path.
import { useCallback, useEffect, useState } from "react";
import {
  TASK_DEPARTMENTS,
  TASK_STATES,
  TASK_STATE_LABELS,
  type TaskDepartment,
  type TaskState,
} from "@office/shared/tasks";

export interface BoardFilterValues {
  readonly projectId?: string | null;
  readonly owner?: string | null;
  readonly department?: TaskDepartment | null;
  readonly state?: TaskState | null;
}

const KEYS = ["project_id", "owner", "department", "state"] as const;

/** URL -> filters. Unknown values are dropped rather than passed through:
 * a hand-edited `?state=nonsense` should show an unfiltered board, not a
 * 400 from the API. */
export function filtersFromSearch(search: string): BoardFilterValues {
  const params = new URLSearchParams(search);
  const department = params.get("department");
  const state = params.get("state");
  return {
    projectId: params.get("project_id") || null,
    owner: params.get("owner") || null,
    department: (TASK_DEPARTMENTS as readonly string[]).includes(department ?? "")
      ? (department as TaskDepartment)
      : null,
    state: (TASK_STATES as readonly string[]).includes(state ?? "")
      ? (state as TaskState)
      : null,
  };
}

/** Filters -> query string. Empty values are omitted entirely, so a clean
 * board has a clean URL. */
export function searchFromFilters(filters: BoardFilterValues): string {
  const params = new URLSearchParams();
  const values: Record<(typeof KEYS)[number], string | null | undefined> = {
    project_id: filters.projectId,
    owner: filters.owner,
    department: filters.department,
    state: filters.state,
  };
  for (const key of KEYS) {
    const value = values[key];
    if (value) params.set(key, value);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function hasAnyFilter(filters: BoardFilterValues): boolean {
  return Boolean(filters.projectId || filters.owner || filters.department || filters.state);
}

/**
 * Filter state, synced to the URL.
 *
 * `replaceState`, not `pushState`: adjusting a filter should not fill the
 * back button with a trail of half-typed owner names. The board is one
 * place you narrow, not a sequence of pages.
 */
export function useBoardFilters(
  initialSearch: string = typeof window === "undefined" ? "" : window.location.search,
): {
  readonly filters: BoardFilterValues;
  readonly setFilter: <K extends keyof BoardFilterValues>(
    key: K,
    value: BoardFilterValues[K],
  ) => void;
  readonly clear: () => void;
} {
  const [filters, setFilters] = useState<BoardFilterValues>(() =>
    filtersFromSearch(initialSearch),
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const next = `${window.location.pathname}${searchFromFilters(filters)}`;
    window.history.replaceState({}, "", next);
  }, [filters]);

  const setFilter = useCallback(
    <K extends keyof BoardFilterValues>(key: K, value: BoardFilterValues[K]) => {
      setFilters((current) => ({ ...current, [key]: value || null }));
    },
    [],
  );

  const clear = useCallback(() => setFilters({}), []);

  return { filters, setFilter, clear };
}

export interface BoardFiltersProps {
  readonly filters: BoardFilterValues;
  readonly setFilter: <K extends keyof BoardFilterValues>(
    key: K,
    value: BoardFilterValues[K],
  ) => void;
  readonly clear: () => void;
  /** Owner names to offer. The board knows who is on its cards; there is no
   * users endpoint until step 9. */
  readonly owners?: readonly string[];
}

export function BoardFilters({
  filters,
  setFilter,
  clear,
  owners = [],
}: BoardFiltersProps): React.ReactElement {
  const active = hasAnyFilter(filters);

  return (
    <div className="filters" role="search" aria-label="Board filters">
      <label className="filters__field">
        <span className="filters__label">Owner</span>
        <select
          value={filters.owner ?? ""}
          onChange={(event) => setFilter("owner", event.target.value || null)}
        >
          <option value="">Anyone</option>
          {owners.map((owner) => (
            <option key={owner} value={owner}>
              {owner}
            </option>
          ))}
        </select>
      </label>

      <label className="filters__field">
        <span className="filters__label">Department</span>
        <select
          value={filters.department ?? ""}
          onChange={(event) =>
            setFilter("department", (event.target.value || null) as TaskDepartment | null)
          }
        >
          <option value="">Any</option>
          {TASK_DEPARTMENTS.map((department) => (
            <option key={department} value={department}>
              {department}
            </option>
          ))}
        </select>
      </label>

      <label className="filters__field">
        <span className="filters__label">State</span>
        <select
          value={filters.state ?? ""}
          onChange={(event) => setFilter("state", (event.target.value || null) as TaskState | null)}
        >
          <option value="">Any</option>
          {TASK_STATES.map((state) => (
            <option key={state} value={state}>
              {TASK_STATE_LABELS[state]}
            </option>
          ))}
        </select>
      </label>

      {/* One action, and only visible when it would do something. A
          permanently present Clear is a control people learn to ignore. */}
      {active ? (
        <button type="button" className="filters__clear" onClick={clear}>
          Clear filters
        </button>
      ) : null}
    </div>
  );
}
