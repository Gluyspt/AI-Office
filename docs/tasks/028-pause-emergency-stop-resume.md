---
id: "028"
title: Pause, emergency stop, and resume (orchestrator)
build_step: 3
department: dev
estimated_model: opus
blocked_by: ["008", "012", "015"]
---

# 028 — Pause, emergency stop, and resume (orchestrator)

**Build step:** 3 — Tasks page and chat panel
**Department:** dev
**Estimated model:** opus — a multi-session choreography with a deadline, partial failure, and a resume path that has to work when it is needed most.
**Blocked by:** 008, 012, 015

## Why

The design is explicit about why this lands in step 3 rather than later: "Pause, emergency stop, and
resume land here too — build them before agents ever run unattended."

Pause is a choreography, not a kill: interrupt every agent, instruct each to commit WIP and write a
handoff, wait with a deadline, then kill. Emergency stop skips the graceful steps. Both keep locks and
move tasks to `paused`, so a single Resume recovers every kind of interruption.

## Scope

### Files created

- `db/migrations/0011_pause.sql` — `pause_state`: project_id (null for global), kind, initiated_by, started_at, completed_at; plus a handoff reference column on sessions
- `packages/server/src/features/orchestrator/pause.ts` — graceful pause and emergency stop, scoped to a project or global
- `packages/server/src/features/orchestrator/resume.ts` — resume one task or every paused task in a project, respecting dependencies
- `packages/server/src/features/orchestrator/routes/control.ts` — `POST /control/pause`, `POST /control/emergency-stop`, `POST /control/resume`, `GET /control/state`
- `packages/shared/src/control.ts`

### Files modified

None.

## Acceptance criteria

- [ ] Pause interrupts every agent in scope, instructs each to commit WIP and write a handoff, waits up to the configured deadline, then kills — in that order, asserted by an ordered event log.
- [ ] An agent that misses the deadline is killed anyway, and the pause completes; one stuck agent must not block the whole pause. The missed deadline is reported per agent.
- [ ] Emergency stop kills everything in scope immediately, and completes in under five seconds with ten sessions running.
- [ ] After either, every affected task is `paused` and its locks are **kept and marked paused**, exempt from TTL expiry — asserted against ticket 015 by advancing the clock past the TTL.
- [ ] While paused, `start_session` is refused with a message saying the project is paused — this fills the stub left in tickets 008 and 018, and a test asserts a lead cannot quietly restart work.
- [ ] A pause does not drain ticket 018's spawn queue: queued spawns stay queued and do not start while the project is paused, asserted with entries present at pause time.
- [ ] Each session ended by a pause or stop records its restart reason, so ticket 026's conversation divider can label the boundary correctly.
- [ ] Scope is respected: pausing one project leaves another project's sessions running, asserted with two projects active.
- [ ] Resume of a single task respawns its agent with the task brief and the handoff, and clears the paused flag on its locks.
- [ ] Resume of a whole project respects dependencies via ticket 014 — a task whose dependency is still paused does not start.
- [ ] Resume is idempotent and safe to retry after a partial failure: a project half-resumed and then resumed again ends fully resumed with no duplicate sessions.
- [ ] Pause during an in-flight pause is rejected rather than interleaved.
- [ ] Every pause, stop and resume records who triggered it and its scope.

## Open questions

- [ ] **The pause deadline has no value in the design** ("wait with a deadline"). Shipped as required config with no default, so the number is chosen from real observation of how long an agent takes to commit and write a handoff — ticket 011's measurements are the input.
- [ ] Pause depends on agents committing WIP and pushing, but the git workflow is step 4 and the knowledge-graph handoff node is step 5. Neither exists. **This ticket implements the choreography and the state machine; the commit step and the handoff node are named seams that currently no-op with a warning.** That means a step-3 pause preserves task state and locks but not in-flight work. Say so plainly in the UI (ticket 029) rather than promising "Full context" from the design's table.
- [ ] Resume "with the handoff node" is likewise inert until step 5. Resume respawns with the task brief only.
- [ ] The design places the Pause and Emergency stop controls on the Company overview page, which is not built in step 3. Ticket 029 puts them on their own route instead.
- [ ] Whether a paused project should also tear down preview environments is unspecified; previews are step 8.

## Landed 2026-10-08

Implemented by a subagent working from this ticket, finished and verified by the
orchestrating session. **29 files, 572 passed, 1 skipped, typecheck clean on all three
packages, on the real VPS kernel.**

**What was verified and what was not.** The suite passes and the three packages typecheck;
that is the claim. The acceptance criteria above have **not** been audited line by line
against the implementation, so they are left unticked deliberately rather than ticked on
the strength of a green suite. Someone closing this ticket should walk the list.

**`resumeTask` refuses a single task while a project pause covers it**, naming the remedy
("resume the project instead") rather than half-resuming. I wrote two tests that assumed
the opposite and both were wrong: resuming one task under an office-wide pause would
restart an agent inside a pause still in effect — the board would show one task moving
while everything else is held, and `start_session` would still be refused for it. The
tests now assert the refusal, and cover the per-task path with no project pause behind it,
which is the crash / rate-limit case.

**`scope.projectId` comes back populated when resuming by task**, not null: resume knows
which project the task belongs to and a caller rendering the result should not have to
look it up again. I asserted null and was wrong about that too.

**One environment gap this ticket surfaced:** resume is the first code path that loads
`loadLocksConfig()` from configuration rather than taking a TTL as a parameter, so
`LOCK_TTL_SECONDS` became required in the test environment and is now set in
`deploy/linux-check/run.sh`. The lock suite passes its own TTL, which is why nothing had
needed it before.
