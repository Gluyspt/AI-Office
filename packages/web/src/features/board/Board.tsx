// The four columns, in the design's order, with the card implementation
// left to ticket 024 through a `renderCard` prop.
//
// That split is not ceremony: it is what lets this ticket be tested against
// fixtures for every state in the union — including states no card design
// exists for yet — so an unmapped state is caught here rather than in
// production.
import type { ReactNode } from "react";
import { TASK_BOARD_COLUMNS, type TaskBoardColumn } from "@office/shared/tasks";
import type { BoardCard } from "../../lib/api.ts";
import { Column, EMPTY_STATES } from "./Column.tsx";
import { groupByDay, type BoardColumnView } from "./useBoard.ts";
import "./board.css";

/** The design's four columns, in the design's order. Labels live here;
 * the identifiers come from the shared vocabulary. */
const COLUMN_TITLES: Readonly<Record<TaskBoardColumn, string>> = {
  draft: "Draft",
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
};

export interface BoardProps {
  readonly columns: readonly BoardColumnView[];
  /** Ticket 024 supplies this. Kept a prop so the card and the board can be
   * built, changed and tested independently. */
  readonly renderCard: (card: BoardCard) => ReactNode;
  /** Ticket 024's filter bar and 025's Start working, per column. */
  readonly headerSlot?: (column: TaskBoardColumn) => ReactNode;
  /**
   * Applies the state filter behind "+N earlier" on the Done column.
   *
   * A filter on the existing bar, deliberately not a separate view: the
   * design's Done column is a 7-day window, and "show me the rest" is the
   * same question the filter bar already answers. Clearable like any other
   * filter because it *is* any other filter.
   */
  readonly onShowEarlier?: () => void;
  /** True while the socket is down. The board must not present stale data
   * as current — 022's status strip says so page-wide, and this dims the
   * board so the two cannot disagree. */
  readonly stale?: boolean;
  readonly now?: Date;
}

export function Board({
  columns,
  renderCard,
  headerSlot,
  onShowEarlier,
  stale = false,
  now,
}: BoardProps): React.ReactElement {
  const byColumn = new Map(columns.map((column) => [column.column, column]));

  return (
    <div className="board" data-stale={stale ? "true" : undefined}>
      {TASK_BOARD_COLUMNS.map((name) => {
        const view = byColumn.get(name) ?? { column: name, cards: [], earlierCount: 0 };
        const empty = EMPTY_STATES[name] ?? { title: "Nothing here" };

        return (
          <Column
            key={name}
            title={COLUMN_TITLES[name]}
            count={view.cards.length}
            headerSlot={headerSlot?.(name)}
            emptyTitle={empty.title}
            emptyDetail={empty.detail}
            footer={
              name === "done" && view.earlierCount > 0 ? (
                <button type="button" className="column__earlier" onClick={onShowEarlier}>
                  +{view.earlierCount} earlier
                </button>
              ) : null
            }
          >
            {name === "done" ? (
              // The 7-day window under day headers — Today, Yesterday, then
              // dates — newest first.
              groupByDay(view.cards, now).map((group) => (
                <div className="column__day" key={group.label}>
                  <h3 className="column__day-label">{group.label}</h3>
                  {group.cards.map((card) => (
                    <div className="column__card" key={card.task.id}>
                      {renderCard(card)}
                    </div>
                  ))}
                </div>
              ))
            ) : (
              view.cards.map((card) => (
                // Keyed by task id so React reconciles in place: a live
                // update must not remount the list and reset the scroll.
                <div className="column__card" key={card.task.id}>
                  {renderCard(card)}
                </div>
              ))
            )}
          </Column>
        );
      })}
    </div>
  );
}
