---
id: "012"
title: Task schema and state machine
build_step: 2
department: dev
estimated_model: opus
blocked_by: ["004"]
---

# 012 — Task schema and state machine

**Build step:** 2 — Coordination
**Department:** dev
**Estimated model:** opus — the state machine is the backbone of every later step; getting the transitions and their guards right is design work.
**Blocked by:** 004

## Why

"Tasks live in our database, managed through our own MCP tools... the server is authoritative." Every
other coordination ticket, the whole Tasks page, the QA gate and the delivery loop are transitions on
this machine. It is defined once, here, and enforced in one place rather than re-checked by each caller.

The design's key property: `paused` is where every interruption lands — manual pause, crash, circuit
breaker, rate limit — so one Resume recovers all of them.

## Scope

### Files created

- `db/migrations/0005_tasks.sql` — `tasks` table: id, project_id, title, brief, department, owner, state, model, model_reason, branch, token_cost, turn_count, created_at, updated_at, plus `task_state_history`
- `packages/shared/src/tasks.ts` — task record, state union, department union
- `packages/server/src/features/tasks/states.ts` — the transition table and the single `transition()` function, with per-transition guards
- `packages/server/src/features/tasks/model.ts` — construction and validation of a task, independent of storage

### Files modified

None.

## Acceptance criteria

- [ ] The state union is exactly the design's set: draft, pending, in progress, paused, ready for QA, CI, QA review, lead approval, delivered, done.
- [ ] The transition table encodes exactly the edges in the design's lifecycle diagram, including both edges out of `delivered` (accept → done, send back → in progress) and both out of CI (fail → in progress, pass → QA review).
- [ ] A table-driven test asserts every legal transition succeeds and **every** illegal pair is rejected — the test enumerates the full matrix, not a sample.
- [ ] Every transition writes a `task_state_history` row with the actor, the reason, and a timestamp; a test reconstructs a task's full path from history alone.
- [ ] `transition()` is the only exported way to change state — a test asserts no other module writes the `state` column, by grep or by a repository-level guard.
- [ ] Any state can move to `paused`, and `paused` returns to the state it came from — verified from at least four different origin states.
- [ ] A dev completing work cannot reach `done` in one step; a test asserts `in progress → done` is rejected, per "A dev calling `complete_task` moves the task to **ready for QA**, never straight to done."
- [ ] `token_cost` and `turn_count` default to zero and are never null, so the card in step 3 always has a number to render.

## Added after the fact (2026-09-23)

- **`transition()` emits `TaskTransitioned`.** It did not originally, and nothing else announced a
  state change either — which meant ticket 023's board could reconcile correctly against a
  synthetic event and never see a real one. Found while building the board; fixed here because
  `states.ts` is this ticket's file.

- **The announcement is deliberately NOT inside the transaction.** `recordSystemEvent` writes
  through the shared pool, not the caller's client, so an event emitted mid-transaction survives a
  `ROLLBACK` — a claim to the rest of the system that something happened, which nothing then takes
  back. `transition()` announces only on the path where it owns the commit. A caller supplying its
  own client owns the commit and therefore the announcement: `announceTransition(result)` is
  exported for it, and **ticket 017's `claim`/`complete` must call it after committing.**

## Open questions

- [ ] The design names the pipeline states shown as chips inside the In progress column (in progress, paused, ready for QA, CI, QA review, awaiting lead) but writes "lead approval" in the lifecycle diagram and "awaiting lead" in the UI table. Assumed the same state under two labels; one name is picked in code and the other treated as display text. Confirm.
- [ ] Nothing in the design says whether `owner` is a Linux account, an office member, or both. They are explicitly separate concepts ("Office membership is what a person may do... an agent account is a Claude login"). This ticket stores an agent-account owner, since `claim_task` checks owner match against the session's user. The membership link is step 9.
- [ ] Task-level circuit-breaker budgets (token and turn caps, "defaults are per project, overridable per task") are columns here or config there — undecided. Left out of this schema; step 7 owns it. Adding the columns later is a one-line migration.
- [ ] Whether `draft` tasks belong in `tasks` with a state, or in a separate batch table, is a real fork. This ticket puts them in `tasks` as a state, per the lifecycle diagram; ticket 019 adds the batch grouping on top.
