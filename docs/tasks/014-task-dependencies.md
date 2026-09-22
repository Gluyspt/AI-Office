---
id: "014"
title: Task dependencies and unblocking
build_step: 2
department: dev
estimated_model: sonnet
blocked_by: ["012", "013", "015"]
---

# 014 — Task dependencies and unblocking

**Build step:** 2 — Coordination
**Department:** dev
**Estimated model:** sonnet — a graph table, a cycle check, and a notification on close.
**Blocked by:** 012, 013, 015 (the scope-ordering validator needs the overlap logic)

## Why

"Without this, Management cannot express 'build the API before the UI that consumes it,' and agents
start work that can't finish." Dependencies are also what makes Resume-everything meaningful, since the
design requires resuming a project's paused tasks "respecting dependencies."

## Scope

### Files created

- `db/migrations/0006_task_dependencies.sql` — `task_dependencies` (task_id, blocked_by_task_id), with a uniqueness constraint and an index in both directions
- `packages/server/src/features/tasks/dependencies.ts` — add, remove, cycle detection, transitive-order queries, `isClaimable`, and `unblockDependents` called when a task is delivered
- `packages/server/src/features/tasks/scope-ordering.ts` — the shared validator: is an overlap between two tasks safely ordered by a direct or transitive dependency? Called by this ticket's mutation routes and by ticket 019's batch validation
- `packages/server/src/features/tasks/routes/dependencies.ts` — `PUT /tasks/:id/dependencies`, `GET /tasks/:id/dependencies`

### Files modified

None.

## Decided

**Dependents unblock at `delivered`, not `done`.** The squash-merge into `main-dev` is the moment the code a dependent needs actually exists; waiting for a human to accept the delivery report stalls every chain at a human gate, which with auto-claiming is the common case rather than the exception. The `done` state is unchanged — only the unblock point moves earlier.

## Acceptance criteria

- [x] A task whose dependencies have not all reached `delivered` is reported unclaimable, with the blocking task ids in the response.
- [x] `scope-ordering.ts` reports an overlap as safe when a direct **or transitive** dependency orders the two tasks, and unsafe otherwise — asserted on a chain A→B→C where A and C overlap.
- [x] Removing a dependency edge is refused when it would leave unordered overlap between two not-yet-done tasks, and the refusal names both tasks and the overlapping paths.
- [x] Editing a task's file scope is refused on the same grounds — a test covers widening a scope into a sibling task's files.
- [x] Adding a dependency that would create a cycle is rejected, including the indirect case A→B→C→A, asserted by test.
- [x] Self-dependency is rejected.
- [x] A dependency on a task in another project is rejected.
- [x] When a task is delivered, every dependent that now has all dependencies satisfied is marked claimable and an event is emitted naming the dependent and its owner's lead, per "the orchestrator unblocks its dependents and notifies their owners' leads."
- [x] Unblocking is idempotent: delivering an already-delivered task twice produces one notification, not two.
- [x] A dependency graph 200 tasks wide resolves claimability in under 100 ms.
- [x] Deleting a task removes its dependency edges and re-evaluates anything it was blocking.
- [x] `GET /tasks/:id/dependencies` returns both directions — what this blocks and what blocks it — since the board needs both.

## Carried to step 4 (git workflow and send-back)

Unblocking early means a send-back can strand dependents that already started. Two requirements follow, to be implemented when the revert path is built:

- **On revert, notify leads of affected tasks by both paths: file-scope overlap and dependency edge.** A dependent that touches none of the reverted files is still affected. The design only names the overlap path.
- **The send-back dialog states how many dependent tasks have already started work on this one.** It warns; it does not block.
- **Send-back of a delivered task whose files are now held by an active dependent must not auto-reopen into `in progress`.** Flag it and let a human choose to pause the dependent or queue the reopen.

## Decided during implementation

- **A task's file scope is read from `file_locks` (ticket 015), because nothing stores a *declared*
  scope.** No table has a column for it and the ownership map gives no ticket one; `file_locks`
  holds *acquired* scope keyed by task, and `acquireScope` does not check task state, so a task can
  hold its scope from draft onward. That makes the reading coherent — but it is an interpretation,
  not something the design states.

  The consequence to know: **a task that has never acquired locks has an empty scope here and so
  can never conflict.** Ticket 019 produces draft batches with scopes before anything is claimed,
  and is where this assumption either holds or has to be replaced with real storage. Flagged rather
  than resolved by inventing a column.

- **`PUT /tasks/:id/dependencies` replaces the whole set** rather than offering add/remove
  endpoints. The scope-ordering check has to run against the *resulting* graph, and a caller
  removing two edges one at a time would be refused on the first even when the pair together is
  legal. Declaring the end state lets the check run once, on what the caller actually wants.

- **Cycle detection is reachability, not a path search.** "Can I already reach the dependent from
  the blocker?" covers the indirect case A→B→C→A as naturally as the direct one, because
  reachability is transitive by construction — one recursive CTE rather than a walk issuing a query
  per level.

- **Migration ordering: `0006` was written after `0007` already existed**, so on every database
  where 015 has run, this file applies *after* it. That is the hazard `0005_tasks.sql` documented,
  now materialised and observed (`Applied 0006_task_dependencies.sql` after 0007 was already in
  place). Safe here because this migration references only `tasks` and `projects`, both
  lower-numbered and already applied. The rule holds: a migration must not depend on any table a
  lower-numbered, not-yet-written migration will create.

## Open questions

- [ ] The notification target is "their owners' leads", but the notification transport does not exist until step 6 (Discord). This ticket emits an event; nothing delivers it yet.
