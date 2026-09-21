---
id: "023"
title: Board primitives — columns and live board state
build_step: 3
department: dev
estimated_model: opus
blocked_by: ["013", "022"]
---

# 023 — Board primitives: columns and live board state

**Build step:** 3 — Tasks page and chat panel
**Department:** dev
**Estimated model:** opus — the live-update model (events arriving while a human is mid-interaction) is the hard part and is easy to get subtly wrong.
**Blocked by:** 013, 022

## Why

The board is the page the team lives on. This ticket builds the structural half — the four columns from
the design, and the hook that keeps them current from the WebSocket stream without flicker, lost
scroll position, or a stale card after an agent moves a task.

Cards and the page composition are deliberately separate tickets, so this one can be built and tested
against fixtures.

## Scope

### Files created

- `packages/web/src/features/board/Board.tsx` — the column layout; takes columns and a `renderCard` prop, so the card implementation stays in ticket 024
- `packages/web/src/features/board/Column.tsx` — one column: header, count, optional header slot, empty state, scroll container
- `packages/web/src/features/board/useBoard.ts` — loads `GET /board`, subscribes to task events, applies updates incrementally
- `packages/web/src/features/board/board.css`

### Files modified

None.

## Acceptance criteria

- [ ] The four columns are exactly Draft, To do, In progress, Done, in that order.
- [ ] A task moved by an agent relocates to the correct column within one second of the event, without a full page refetch.
- [ ] Applying an event for a task not currently loaded triggers a targeted fetch rather than a full board reload.
- [ ] Out-of-order events do not regress state: an older event arriving after a newer one for the same task is discarded, asserted by test.
- [ ] Scroll position and any open interaction survive a live update — a card update while the user is scrolled halfway down In progress does not jump the view.
- [ ] A column with no tasks renders a meaningful empty state, not blank space; the Draft column's empty state says how a batch gets created.
- [ ] The Done column groups its 7-day window under day headers — Today, Yesterday, then dates — newest first.
- [ ] Below those, "+N earlier" applies a state filter on the existing filter bar rather than opening a separate view. A test asserts the filter is applied and is clearable like any other.
- [ ] Columns render at 400 px width by stacking, per the design's mobile-reachability goal; the board scrolls horizontally rather than compressing columns below a readable width on desktop.
- [ ] A board with 200 tasks renders in under 200 ms and updates without visible lag; the column is virtualised or paged if it does not.
- [ ] Board state is tested against fixtures for every state in ticket 012's union, so an unmapped state is caught here rather than in production.
- [ ] While the socket is disconnected, the board shows the disconnected state from ticket 022 rather than presenting stale data as current.

## Open questions

- [ ] Time-in-state on a card ticks. Whether that is a live timer per card or a value refreshed on each event is undecided; a live timer on 200 cards is a rendering cost. Assumed a coarse refresh — minutes, not seconds — and flagged to ticket 024 which owns the chip.
- [ ] Drag and drop between columns is not mentioned anywhere in the design. Not built. State changes happen through explicit actions, which also keeps the state machine in ticket 012 authoritative. Confirm nobody expects to drag.
