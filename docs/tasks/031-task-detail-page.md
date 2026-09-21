---
id: "031"
title: Task detail page (minimal)
build_step: 3
department: dev
estimated_model: sonnet
blocked_by: ["013", "024", "026"]
---

# 031 — Task detail page (minimal)

**Build step:** 3 — Tasks page and chat panel
**Department:** dev
**Estimated model:** sonnet — the sections are enumerated below, and every data source already exists.
**Blocked by:** 013, 024, 026

## Why

The design lists Task detail as its own page, carrying the activity log, diff summary, CI output,
preview link, app logs and delivery report — most of which belong to steps 4, 6 and 8. But the card
needs somewhere to click *now*, and the fuller time picture (total age, accumulated working time, state
history) has no room on a card.

Building the minimal version in step 3 makes the card's click target correct permanently, instead of
pointing at the chat panel and being retrained later. Each deferred section is added by the step that
produces its data.

## Scope

### Files created

- `packages/web/src/routes/tasks.$id.tsx` — the route
- `packages/web/src/features/task-detail/TaskDetail.tsx` — header and section layout
- `packages/web/src/features/task-detail/StateHistory.tsx` — every transition with its timestamp, and the totals derived from it
- `packages/web/src/features/task-detail/useTask.ts` — load one task with its history, subscribe to its events
- `packages/web/src/features/task-detail/task-detail.css`

### Files modified

None.

## Acceptance criteria

- [ ] `/tasks/:id` renders a header with title, state chip and duration, owner, department and model, reusing ticket 024's `StateChip` rather than reimplementing it.
- [ ] The state history lists every transition with its timestamp, actor and reason, from ticket 012's `task_state_history`.
- [ ] **Total age** and **accumulated working time** are computed from that history and shown as plain numbers — working time excludes paused spans, and the page says so rather than leaving the reader to infer it.
- [ ] The file scope is listed in full, with no truncation — this is the page with room for it.
- [ ] A button opens the chat panel for this task's agent, using ticket 026's conversation keyed by task, so the panel shows the full history across sessions.
- [ ] The page updates live: a transition arriving on the WebSocket appends to the history and updates the header without a refresh.
- [ ] A task flagged by ticket 020's retroactive check shows why, and which other task held the file.
- [ ] A gate-bypassed task (ticket 032) shows who advanced it and when, alongside the state history where the bypass is already visible as a transition.
- [ ] An unknown or deleted task id renders a clear not-found state, not a crash or an empty shell.
- [ ] Sections deferred to later steps are **not** rendered as empty placeholders — the page shows what it has. A comment in `TaskDetail.tsx` names each deferred section and its step.
- [ ] The page works at 400 px width.

## Deferred to later steps

Each adds its own section to this page, and owns that file:

| Section | Step |
| --- | :-: |
| Full activity log | 4 |
| Diff summary, commits, merge SHA | 4 |
| Delivery report, accept / send back | 4 |
| CI output | 6 |
| Preview link and app logs | 8 |

## Open questions

- [ ] Accumulated working time is derived from the state history, which means it is only as good as the history. A crash that skips a transition leaves it understated. Acceptable for a displayed number; it must not become the basis of anything billed or enforced.
- [ ] The design does not say whether Task detail should show the task's dependencies and dependents. Not built — the data exists in ticket 014, so it is cheap to add once someone finds themselves wanting it.
- [ ] Whether the chat panel should open automatically when arriving from a card click, or wait for the button, is a small interaction call. Assumed the button, so the page is readable first.
