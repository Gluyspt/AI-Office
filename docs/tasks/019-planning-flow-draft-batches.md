---
id: "019"
title: Planning flow — draft batches and Start working
build_step: 2
department: dev
estimated_model: opus
blocked_by: ["013", "014", "018"]
---

# 019 — Planning flow: draft batches and Start working

**Build step:** 2 — Coordination
**Department:** dev
**Estimated model:** opus — the read-only enforcement during planning is a security boundary, not a convention.
**Blocked by:** 013, 014, 018

## Why

"Nothing runs until a human says so." Planning produces a draft batch that sits inert until promoted.
The enforcement matters: during planning, Management runs read-only — it may read the repo and the
graph and spawn a research agent, but it cannot call `start_session` for workers or touch files, **and
the orchestrator enforces this** rather than trusting the prompt.

## Scope

### Files created

- `db/migrations/0009_batches.sql` — `batches`: id, project_id, title, state (draft, promoted, discarded), created_by, created_at; plus `batch_id` on tasks
- `packages/server/src/features/planning/batches.ts` — create, add and remove tasks, edit before promotion, revalidate on mutation
- `packages/server/src/features/planning/promote.ts` — the Start working transition: validate the whole batch, move draft to pending, spawn the department leads, let them claim
- `packages/server/src/features/planning/readonly-guard.ts` — the planning-mode restriction on a Management session
- `packages/server/src/features/planning/routes/batches.ts` — `POST /batches`, `GET /batches`, `PATCH /batches/:id`, `POST /batches/:id/promote`, `DELETE /batches/:id`
- `packages/shared/src/batches.ts`
- `agents/management-lead.planning.md` — the planning brief and the breakdown format the agent must produce

### Files modified

None.

## Decided

- **INHERITED FROM 014 — this ticket owns where a task's declared file scope is stored.** Decided
  2026-09-23: nothing stores it today. `file_locks` (015) holds *acquired* scope, and 014's
  `scope-ordering.ts` reads that, which means **overlap between two draft tasks is invisible** —
  a draft has acquired nothing, so the validator finds nothing to complain about. That is precisely
  the moment this ticket exists for: a human reviewing a draft batch before promotion.

  The choice was deliberately left here rather than settled in 014, because this ticket owns the
  planning flow and `0009_batches.sql` and may want scope on the **batch** rather than the task.
  Two shapes to pick between:

  - `tasks.file_scope text[]` — declared at planning, acquired at claim by 017. Separates
    declaration from exclusivity cleanly.
  - scope on the batch row — keeps a draft batch self-contained until promotion.

  Whichever: `scope-ordering.ts` is written so only `projectScopes()` knows where scopes come
  from. The rule itself (`orderedOverlapProblems`) is a pure function over supplied scopes and
  edges, so switching the source is one function, not a rewrite. The README decision "batch scope
  overlap is allowed when a dependency orders it" is already implemented against it.



**Reviewing the draft batch is the approval gate; there is no second one.** Start working promotes the tasks, spawns the department leads, and the leads claim immediately — the design's "agents begin", read literally.

The protection that makes this safe is the spawn cap from ticket 018, enforced at spawn time: a spawn that would exceed the per-project cap or the global memory floor is **refused and queued**, never silently dropped. That stands in for the circuit breaker, which does not exist until step 7.

**Overlapping file scopes within a batch are allowed when a direct or transitive dependency orders the tasks** — the two can never be active at once, so the registry's guarantee still holds. Unordered overlap is still rejected.

## Acceptance criteria

- [ ] A Management session in planning mode is refused by `start_session` for any worker role, and the refusal is enforced server-side — asserted by calling the API directly with that session's identity, bypassing the prompt.
- [ ] A Management session in planning mode may still spawn a research agent, per the design's explicit exception.
- [ ] Promotion validates the whole batch before changing anything: every task has a title, department, owner, file scope, proposed model and acceptance criteria; dependencies resolve; and any overlapping scopes are ordered by a dependency. A batch failing any check promotes nothing and reports every problem at once, not the first.
- [ ] Overlap ordered by a transitive dependency chain passes validation; the same overlap with the chain broken fails. Both asserted, using ticket 014's `scope-ordering.ts`.
- [ ] **The same validation re-runs on every later mutation** — removing a dependency edge, editing a task's file scope, adding a task to a promoted batch. A change that would leave unordered overlap between two not-yet-done tasks is refused, naming both tasks.
- [ ] Promotion is atomic — a failure mid-way leaves every task in `draft` and spawns nothing.
- [ ] After promotion, tasks are `pending`, the batch is `promoted`, and the department leads for the batch's tasks are spawned through ticket 018's capped path.
- [ ] A promotion whose lead spawns exceed the cap still promotes the tasks; the spawns queue, and the response reports which leads are queued and why.
- [ ] A promoted batch cannot be promoted again. Tasks may still be added to it, and go through the same validation.
- [ ] Draft tasks are fully editable before promotion: reassign owner, change scope, split, merge, delete, add, fix dependencies — each has an endpoint and a test, per the design's review step.
- [ ] Draft tasks hold no file locks; a test asserts the registry is empty for a project with only draft batches, so planning a batch cannot block running work.
- [ ] Planning a new batch while an earlier batch is running works, asserted with both present.

## Open questions

- [ ] Auto-claiming means a drafting mistake reaches a working agent with no further human action. The spawn cap bounds how much runs at once, but not whether it is the right work. The first few real batches should be watched rather than promoted and left.
- [ ] The design does not say whether planning mode is a property of the session, the project, or a toggle. Implemented as a session property, since "you can plan a new batch while earlier work runs" rules out a project-wide mode.
- [ ] Who owns which department by default is one of the design's open questions, and it bites here: the breakdown must assign an owner per task. Until it is answered, the agent proposes and a human assigns.
