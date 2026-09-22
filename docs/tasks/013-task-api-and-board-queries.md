---
id: "013"
title: Task API and board queries
build_step: 2
department: dev
estimated_model: sonnet
blocked_by: ["005", "012"]
---

# 013 — Task API and board queries

**Build step:** 2 — Coordination
**Department:** dev
**Estimated model:** sonnet — CRUD and one read model over a state machine that already exists.
**Blocked by:** 005, 012

## Why

The Tasks page needs one query that returns a whole board, filtered, in one round trip. Building that
read model here — rather than letting the UI assemble it from several endpoints — keeps ticket 023
honest and makes the board cheap to re-render on every WebSocket event.

## Scope

### Files created

- `packages/server/src/features/tasks/repo.ts` — persistence for tasks: create, read, update fields, list; plus the board read model that groups by column and attaches the pipeline chip
- `packages/server/src/features/tasks/routes/tasks.ts` — `POST /tasks`, `GET /tasks/:id`, `PATCH /tasks/:id`, `GET /tasks`, `GET /board`

### Files modified

None.

## Acceptance criteria

- [x] `GET /board?project_id=` returns the four columns from the design — Draft, To do, In progress, Done — with every pipeline state mapped into the correct column and carried as a chip value on the task.
- [x] The column mapping is asserted for every state in ticket 012's union, so a new state cannot silently vanish from the board.
- [x] Every task carries `state_since`, the timestamp of its last transition, so the card can render time-in-current-state without walking history.
- [x] The Done column returns only tasks completed in the **last 7 days**, newest first, plus a count of how many earlier ones exist.
- [x] `GET /board` supports project, owner, department **and state** filters; filters combine. The state filter is what "+N earlier" on the Done column applies.
- [x] `GET /tasks/:id` returns the full state history from ticket 012, so the Task detail page can compute total age and accumulated working time without a second call.
- [x] The board query runs in a single round trip; a test asserts the query count is one with 200 tasks present.
- [x] `PATCH /tasks/:id` refuses to write `state` directly and returns a message pointing at the transition endpoint — state changes go through ticket 012's `transition()` only.
- [x] Every task returned carries the fields the card needs: title, owner, department, model, file scope, elapsed time, token cost.
- [x] Creating a task emits an event through ticket 005 so subscribed clients update without polling.
- [x] `GET /tasks` pages deterministically with a stable sort, verified across two pages with a concurrent insert.
- [x] A task created with a department outside the dev/research/qa union is rejected with a 400 naming the valid values.

## Decided

- **Cards show time in current state**, computed from `state_since` alone — no history walk. The fuller picture (total age, accumulated working time, full history) belongs to the Task detail page in ticket 031.
- **Done shows a 7-day window** with a count of earlier tasks; "+N earlier" applies a state filter on the existing filter bar rather than opening a separate view. This is why `state` joins the filter set.

## Open questions

- [ ] **`events.project_id` is never set, so the `TaskCreated` event arrives with a null project.**
      `persist()` in `features/events/ingest.ts` takes a type, a session id and a payload — there
      is no project parameter, and that file belongs to ticket 005. The event therefore carries its
      project in the *payload* only, which means a bus subscriber filtering by project (ticket 006's
      `subscribe({projectId})`) will not receive it. Ticket 023's board needs either a project-aware
      `persist` or a payload-level filter. Found while implementing this ticket; not worked around,
      because the one-line fix is in another ticket's file.
- [x] Token cost per task has no source until step 7 (OTEL collection). The field exists and returns zero. The card must not imply zero means free — flagged to ticket 024.
- [x] Whether the 7-day Done window should be configurable per project is unspecified. Shipped as a constant; trivial to lift into config if a week proves wrong.
