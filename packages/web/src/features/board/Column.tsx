// One board column: header, count, an optional header slot, the cards, and
// an empty state that says something.
//
// The empty state matters more than it looks. Three of these four columns
// are empty on a quiet morning, and blank space reads as "broken" — or
// worse, as "nothing to do" when the real answer is "nobody has planned a
// batch yet". The Draft column in particular has to say how work gets
// created, because that is the one thing a new user cannot guess.
//
// The scroll container is this element and it is never remounted on a live
// update: cards are keyed by task id, so React reconciles the list in place
// and the user's scroll position survives an agent moving a card.
import type { ReactNode } from "react";

export interface ColumnProps {
  readonly title: string;
  readonly count: number;
  /** Rendered in the header, right-aligned — 024's filters, 025's Start
   * working button. Keeps those tickets out of this file. */
  readonly headerSlot?: ReactNode;
  readonly emptyTitle: string;
  readonly emptyDetail?: string;
  /** Rendered under the cards — the Done column's "+N earlier". */
  readonly footer?: ReactNode;
  readonly children: ReactNode;
}

export function Column({
  title,
  count,
  headerSlot,
  emptyTitle,
  emptyDetail,
  footer,
  children,
}: ColumnProps): React.ReactElement {
  const empty = count === 0;
  return (
    <section className="column" data-column-title={title} aria-label={title}>
      <header className="column__header">
        <h2 className="column__title">{title}</h2>
        <span className="column__count" aria-label={`${count} tasks`}>
          {count}
        </span>
        {headerSlot ? <div className="column__slot">{headerSlot}</div> : null}
      </header>

      <div className="column__scroll">
        {empty ? (
          <div className="column__empty">
            <p className="column__empty-title">{emptyTitle}</p>
            {emptyDetail ? <p className="column__empty-detail">{emptyDetail}</p> : null}
          </div>
        ) : (
          children
        )}
        {footer}
      </div>
    </section>
  );
}

/** Empty-state copy, one place, so the board and any test agree on it.
 *
 * Draft's is the load-bearing one: "Nothing here" would be true and
 * useless. A person looking at an empty board needs to know that work
 * arrives by asking Management to plan it, not by clicking a New Task
 * button that does not exist. */
export const EMPTY_STATES: Readonly<
  Record<string, { readonly title: string; readonly detail?: string }>
> = {
  draft: {
    title: "No draft batch",
    detail:
      "Ask Management to plan work. It proposes a batch here, you edit owners, scope and dependencies, and Start working promotes it.",
  },
  todo: {
    title: "Nothing waiting",
    detail: "Promoted tasks queue here until a lead claims them.",
  },
  in_progress: {
    title: "No work in flight",
    detail: "Claimed tasks appear here, with a chip showing which stage they are at.",
  },
  done: {
    title: "Nothing finished recently",
    detail: "Accepted work from the last 7 days shows here, newest first.",
  },
};
