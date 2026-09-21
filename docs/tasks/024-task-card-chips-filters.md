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

- [ ] The card renders every field the design lists: title, owner, department, model, owned files, token cost — with elapsed time expressed as the chip's duration rather than a separate field.
- [ ] Owned files are summarised when long (first path plus a count) and reveal the full list on interaction — an eight-file scope must not make the card unreadable.
- [ ] A chip renders for each of the six pipeline states, visually distinct, and `paused` is distinguishable at a glance from `in progress` since spotting stalled work is the point.
- [ ] The chip's duration is formatted coarsely and readably at every scale — minutes, hours, days — and a task that just transitioned does not read "0m".
- [ ] A task flagged by ticket 020's retroactive check carries a visible "unguarded edit — needs review" marker, distinct from the pipeline chip.
- [ ] A task advanced through ticket 032's interim control carries a visible gate-bypassed marker, so work that never passed a real gate stays identifiable.
- [ ] A task in `ready for QA` renders ticket 032's "Advance (no gate yet)" control. This is interim and is removed with that ticket at step 6.
- [ ] Clicking the card navigates to `/tasks/:id`.
- [ ] Chips carry a text label, not colour alone, and each meets WCAG AA contrast against the card background in both light and dark.
- [ ] Token cost renders as "not measured yet" rather than "0" until step 7 provides real numbers — a zero that looks like a measurement is worse than an honest gap.
- [ ] Filters combine (owner AND department AND state), reflect into the URL so a filtered board is shareable, and restore from the URL on load.
- [ ] The state filter is the mechanism behind the Done column's "+N earlier", and applying it that way is indistinguishable from setting it by hand.
- [ ] Clearing filters is one action and is always visible when any filter is active.
- [ ] A card with a very long title truncates without breaking the layout, and the full title is available on hover and to a screen reader.
- [ ] The card is keyboard reachable and its primary action is activatable by keyboard.
- [ ] Card components are tested against fixtures covering each department, each chip state, an empty file scope, and a ten-file scope.

## Open questions

- [ ] The design puts a clickable model chip on the *agent card* in the chat panel, and lists model on the *task card*. Whether the task card's model is also clickable is not stated. Assumed read-only here; the switch lives in ticket 027 with the agent controls.
