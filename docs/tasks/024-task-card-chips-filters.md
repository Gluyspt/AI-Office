---
id: "024"
title: Task card, pipeline chips, and board filters
build_step: 3
department: dev
estimated_model: sonnet
blocked_by: ["023"]
---

# 024 — Task card, pipeline chips, and board filters

**Build step:** 3 — Tasks page and chat panel
**Department:** dev
**Estimated model:** sonnet — the card's contents and the chip set are enumerated in the design.
**Blocked by:** 023

## Why

The design specifies the card exactly: title, owner, department, model, owned files, elapsed time,
token cost — and pipeline states as chips inside In progress. The card is where a human decides what
needs attention, so what it shows and what it hides is the whole value of the page.

## Scope

### Files created

- `packages/web/src/features/board/TaskCard.tsx`
- `packages/web/src/features/board/StateChip.tsx` — the pipeline chip with its duration appended: in progress, paused, ready for QA, CI, QA review, awaiting lead
- `packages/web/src/features/board/BoardFilters.tsx` — project, owner, department, state
- `packages/web/src/features/board/task-card.css`

### Files modified

None.

## Decided

**The card shows time in the current state, appended to the state chip** — "in progress · 3h", "paused · 2d", "awaiting lead · 6h" — computed from `state_since` alone, with no history walk. Total age, accumulated working time and the full state history live on the Task detail page (ticket 031), where there is room for them without hover.

**Clicking a card opens Task detail** at `/tasks/:id`. That mapping is correct permanently and never has to be retrained.

## Acceptance criteria

- [x] The card renders every field the design lists: title, owner, department, model, owned files, token cost — with elapsed time expressed as the chip's duration rather than a separate field.
- [x] Owned files are summarised when long (first path plus a count) and reveal the full list on interaction — an eight-file scope must not make the card unreadable.
- [x] A chip renders for each of the six pipeline states, visually distinct, and `paused` is distinguishable at a glance from `in progress` since spotting stalled work is the point.
- [x] The chip's duration is formatted coarsely and readably at every scale — minutes, hours, days — and a task that just transitioned does not read "0m".
- [x] A task flagged by ticket 020's retroactive check carries a visible "unguarded edit — needs review" marker, distinct from the pipeline chip.
- [x] A task advanced through ticket 032's interim control carries a visible gate-bypassed marker, so work that never passed a real gate stays identifiable.
- [x] A task in `ready for QA` renders ticket 032's "Advance (no gate yet)" control. This is interim and is removed with that ticket at step 6.
- [x] Clicking the card navigates to `/tasks/:id`.
- [x] Chips carry a text label, not colour alone — asserted by test. **The AA contrast half is
      NOT measured**: the pairs come from `global.css`'s severity tokens, chosen for it, but
      nothing here computes a contrast ratio. Needs a real render; belongs with 030.
- [x] Token cost renders as "not measured yet" rather than "0" until step 7 provides real numbers — a zero that looks like a measurement is worse than an honest gap.
- [x] Filters combine (owner AND department AND state), reflect into the URL so a filtered board is shareable, and restore from the URL on load.
- [x] The state filter is the mechanism behind the Done column's "+N earlier", and applying it that way is indistinguishable from setting it by hand.
- [x] Clearing filters is one action and is always visible when any filter is active.
- [x] A very long title stays available in full to hover and a screen reader — asserted by test.
      **The "without breaking layout" half is not verified**: jsdom does not lay out. Truncation
      is `-webkit-line-clamp` with `overflow-wrap: anywhere`, so a single long word cannot push
      the card wide, but that is an argument. 030.
- [x] The card is keyboard reachable and its primary action is activatable by keyboard.
- [x] Card components are tested against fixtures covering each department, each chip state, an empty file scope, and a ten-file scope.

## Decided during implementation

- **Three things the card must show have no data source, so each is an optional prop rather than
  invented here.** Owned files (`TaskRecord` has no scope field — deferred to 019), the
  unguarded-edit flag (020's), and the gate-bypassed flag plus the advance control (032's). A card
  given none of them renders correctly and claims nothing false; the tickets that own the data
  pass it in without this file changing.

- **"not declared" and "none" are different answers for file scope.** An absent scope renders
  *not declared*; an explicitly empty one renders *none*. Collapsing them would let "nothing
  stores this yet" read as "this task touches no files", which is a claim the card has no right to
  make.

- **`paused` gets error colouring AND a dashed border.** Spotting stalled work is the reason the
  chip exists, and paused work looks exactly like working work if the two share a treatment.
  Doubling the signal means it survives greyscale, colour blindness and a bad monitor.

- **A duration under a minute reads "just now", never "0m".** "0m" looks like a measurement
  failed rather than like the thing only just happened. A clock skew that would produce a negative
  duration reads the same way rather than "-3m".

- **The primary action is a real `<button>`, not a click handler on the card `<div>`.** Keyboard
  reachable, activatable with Enter and Space, and announced as an action — none of which a
  clickable div gives for free.

- **Filters use `replaceState`, not `pushState`.** Narrowing a board should not fill the back
  button with a trail of half-typed owner names.

- **An unknown filter value in the URL is dropped, not forwarded.** A hand-edited
  `?state=nonsense` shows an unfiltered board rather than producing a 400 from the API.

## Open questions

- [ ] The design puts a clickable model chip on the *agent card* in the chat panel, and lists model on the *task card*. Whether the task card's model is also clickable is not stated. Assumed read-only here; the switch lives in ticket 027 with the agent controls.
