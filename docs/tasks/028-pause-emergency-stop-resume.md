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
- [x] After either, every affected task is `paused` and its locks are **kept and marked paused**, exempt from TTL expiry — asserted against ticket 015 by advancing the clock past the TTL.
- [x] While paused, `start_session` is refused with a message saying the project is paused — this fills the stub left in tickets 008 and 018, and a test asserts a lead cannot quietly restart work.
- [ ] A pause does not drain ticket 018's spawn queue: queued spawns stay queued and do not start while the project is paused, asserted with entries present at pause time.
- [ ] Each session ended by a pause or stop records its restart reason, so ticket 026's conversation divider can label the boundary correctly.
- [x] Scope is respected: pausing one project leaves another project's sessions running, asserted with two projects active.
- [x] Resume of a single task respawns its agent with the task brief and the handoff, and clears the paused flag on its locks.
- [x] Resume of a whole project respects dependencies via ticket 014 — a task whose dependency is still paused does not start.
- [x] Resume is idempotent and safe to retry after a partial failure: a project half-resumed and then resumed again ends fully resumed with no duplicate sessions.
- [x] Pause during an in-flight pause is rejected rather than interleaved.
- [x] Every pause, stop and resume records who triggered it and its scope.

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

## Criteria audit 2026-10-10

Walked all 13 acceptance criteria against the implementation. **8 ticked, 5 left open** — all
five for the same reason, below. 12 tests added (7 in `pause.test.ts`, 5 in `resume.test.ts`).

**Five criteria were implemented carefully and asserted by nothing.** The code was right in
every case; the gap was coverage, which is exactly what a green suite cannot tell you:

- **45 — locks kept and marked paused, exempt from TTL.** `pauseScope` calls `setLocksPaused`
  in three places and 015 asserts the sweeper exemption, but nothing asserted the half that
  belongs here: that a pause actually *marks* them. Verified by mutation — replacing the three
  `setLocksPaused` calls with a no-op fails the two new tests **and nothing else in the suite**,
  which is the proof the criterion was unasserted. Without the call the locks stay unpaused,
  their TTL lapses while the office is stopped, the sweeper reclaims them, and a paused task
  silently loses the files it owns. The new test runs the real `expireLocks()` against an
  artificially aged lock, so it is the join with 015 the criterion asks for, not a flag check.
- **50 — resume clears the paused flag on its locks.** Same shape, other direction, plus one
  thing the criterion does not say and the code gets right: `resumeOneTask` clears `paused` **and
  restarts the TTL via `heartbeat` in the same transaction**. It has to. A paused lock's TTL has
  almost certainly expired by the time anyone presses Resume, so clearing the flag alone hands
  the sweeper a live-but-expired lock — and the resulting sweep looks like ordinary TTL
  reclamation, timed for the moment someone resumed. Asserted by sweeping after the resume.
- **51 — resume respects dependencies.** `needsDependencyCheck` → `isClaimable` →
  `blocked_by_dependency` was fully built and untested. Now asserted both ways: the dependent
  stays `paused` and names its blocker, *and* the blocker itself resumes — a dependency gate that
  held everything back would have passed a one-sided test.
- **52 — resume is idempotent after a partial failure.** Now asserted on both paths, and they
  differ in a way worth writing down: `resumeProject` selects paused tasks, so an
  already-resumed task is **absent from the report**, while `resumeTask` reaches a task whatever
  state it is in and reports `not_paused`. Absent and skipped mean different things to 029's UI.
  My first version of this test asserted `not_paused` from the project path and was wrong.
- **53 — pause during an in-flight pause is rejected.** The precedence rules in `openPause` are
  the subtlest thing in the ticket and had no test at all. Now five: a second graceful pause
  refused, overlap by global-vs-project scope refused, an emergency stop allowed to take over a
  stuck pause (asymmetric on purpose — refusing it would make a hung pause unstoppable), a
  second emergency stop refused, and a one-project stop **not** lifting a global pause.

**Note that 53 is not the idempotence on line 162 of the test file, and the distinction is the
criterion.** A *completed* pause over the same scope is a no-op; one still *in flight* is
refused. The implementation already separated them correctly; nothing had pinned it.

**Why the five remaining are open: they all need a live desk.** Criteria 42 (the interrupt →
instruct → wait → kill choreography), 43 (an agent that misses the deadline is killed anyway),
44 (ten sessions stopped in under five seconds) and 48 (the restart reason recorded on a session
a pause ended) all require real sessions, and pause drives those through 008's
`interruptSession` / `killSession` / `messageSession`, which drive tmux. That is why every
existing test keeps sessions out of scope. Marked UNVERIFIABLE-HERE rather than faked: a mock
tmux would assert that this file calls the functions it obviously calls, and the risk these
criteria carry is in the real interaction — a desk killed mid-commit, or a kill reported as a
clean stop. **This is 011/021 work, and 44 additionally needs the VPS**, since "under five
seconds with ten sessions" is a statement about a 3.2 GB box, not about the code.

Criterion 47 (a pause does not drain 018's spawn queue) is blocked on 018 existing. The queue
it names has no implementation to assert against yet.

**One trap, found by walking into it.** A draft of the in-flight tests leaked a single
`pause_state` row for the whole office and **took 20 unrelated tests down with it** — including
ones in other files. `afterAll`'s `delete from projects` cannot reach it: a global pause has
`project_id = null`, so no cascade touches it, and `lifted_at is null` means "still in effect",
so `assertStartAllowed` then refuses every project and `pauseScope` refuses every later pause as
interleaving. The new tests register every row they create and delete it in `afterEach`, with
the reason written at the top of the block. **Any future test that opens a pause must do the
same** — this is the one piece of shared state in this ticket that outlives its project.

Three further drafts of these tests were refused by schema constraints rather than by the code,
which is worth recording as evidence the constraints earn their place:
`pause_state_deadline_matches_kind` (an emergency stop must carry no deadline),
`file_locks_expires_after_acquired` (ageing a lock means moving both columns, not one), and
012's guard that the `paused` transition requires a reason.
