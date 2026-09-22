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

- [x] The four columns are exactly Draft, To do, In progress, Done, in that order.
- [x] A task moved by an agent relocates to the correct column within one second of the event, without a full page refetch.
- [x] Applying an event for a task not currently loaded triggers a targeted fetch rather than a full board reload.
- [x] Out-of-order events do not regress state: an older event arriving after a newer one for the same task is discarded, asserted by test.
- [ ] Scroll position and any open interaction survive a live update. **NOT DIRECTLY VERIFIED.**
      jsdom does not lay out or scroll, so no test here can assert it. What *is* enforced: cards
      are keyed by task id and a live update replaces one entry in a Map rather than reloading
      the board, so React reconciles in place and the scroll container is never remounted — a
      test asserts the targeted fetch happens and `load` is called exactly once. The remaining
      claim needs a real browser; belongs with 030.
- [x] A column with no tasks renders a meaningful empty state, not blank space; the Draft column's empty state says how a batch gets created.
- [x] The Done column groups its 7-day window under day headers — Today, Yesterday, then dates — newest first.
- [x] Below those, "+N earlier" applies a state filter on the existing filter bar rather than opening a separate view. A test asserts the filter is applied and is clearable like any other.
- [ ] Columns render at 400 px by stacking; the board scrolls horizontally on desktop. **NOT
      VERIFIED** — same reason: jsdom has no layout engine. The CSS does it (`grid-auto-flow`
      switches to `row` under 720 px, `overflow-x: auto` with a `--column-min-width` floor above
      it), but that is an argument, not evidence. Belongs with 030.
- [x] A board with 200 tasks renders in under 200 ms and updates without visible lag; the column is virtualised or paged if it does not.
- [x] Board state is tested against fixtures for every state in ticket 012's union, so an unmapped state is caught here rather than in production.
- [x] While the socket is disconnected, the board shows the disconnected state from ticket 022 rather than presenting stale data as current.

## Decided during implementation

- **Reconciliation fetches the task rather than patching the card from the event payload.** An
  event says *something happened to this task*; it is not a complete row, and payload shapes
  differ per type. Patching from a partial payload makes every new event type a chance to write a
  card that is subtly wrong. One fetch per changed task gives one code path and one source of
  truth, at the cost of a round trip — the right trade on a board where a handful of tasks change
  at a time, and never a full board reload.

- **The hook reacts to any event whose payload names a `task_id`, not to a named event type.**
  Structural rather than a list, so an event type added later is picked up without editing this
  file. It also handles `TasksUnblocked`, which carries a list rather than a single id.

- **Injected functions are held in a ref and kept out of every dependency array.** Found by a test
  hanging: a caller writing `useBoard({ filters: { projectId } })` — the obvious way to call it —
  creates a new identity each render, and with that in the deps the effect re-runs, setState
  re-renders, and the hook loops forever. Keying only on a serialised `filterKey` makes the hook
  safe to call normally. This was a real defect, not a test artifact.

## The gap this ticket found, now closed

**`transition()` emitted no event.** Nothing in the system announced a state change: 013 emitted
`TaskCreated`, 014 `TasksUnblocked`, 015 `FileLocksSwept`, and that was the entire list — so this
ticket's headline criterion reconciled correctly against a *synthetic* event and would never have
seen a real one.

Fixed in `states.ts`: `transition()` now emits `TaskTransitioned` carrying the project on the
`project_id` **column**, which is what ticket 006's bus filters subscriptions on. The board needed
no change — it already reconciles on any event naming a `task_id`.

One subtlety worth keeping: the announcement happens **only on the path where `transition()` owns
the transaction**. `recordSystemEvent` writes through the shared pool rather than the caller's
client, so emitting inside a caller-supplied transaction would survive that caller's `ROLLBACK` —
announcing a change that never happened, with nothing to take it back. A caller passing its own
client owns the commit and therefore owns the announcement: `announceTransition(result)` is
exported for exactly that, and ticket 017's `claim`/`complete` must call it after committing.

## Open questions

- [ ] Time-in-state on a card ticks. Whether that is a live timer per card or a value refreshed on each event is undecided; a live timer on 200 cards is a rendering cost. Assumed a coarse refresh — minutes, not seconds — and flagged to ticket 024 which owns the chip.
- [ ] Drag and drop between columns is not mentioned anywhere in the design. Not built. State changes happen through explicit actions, which also keeps the state machine in ticket 012 authoritative. Confirm nobody expects to drag.
