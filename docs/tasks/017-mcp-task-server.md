---
id: "017"
title: "MCP task server: claim_task and complete_task"
build_step: 2
department: dev
estimated_model: opus
blocked_by: ["013", "014", "015", "016"]
---

# 017 — MCP task server: claim_task and complete_task

**Build step:** 2 — Coordination
**Department:** dev
**Estimated model:** opus — this is the contract between agents and the coordination layer, and every refusal it returns is a prompt the model has to act on.
**Blocked by:** 013, 014, 015, 016

## Why

This is how an agent actually takes work. The design specifies both tools precisely:

- `claim_task(task_id)` — checks owner match, dependency state, and file-scope overlap, then locks
- `complete_task(task_id, summary, learning)` — requires a learning entry, a rebase, then pushes and opens a PR

The git half of `complete_task` belongs to step 4, so this ticket builds the coordination half and
leaves a named seam for it.

## Scope

### Files created

- `packages/mcp-tasks/package.json`
- `packages/mcp-tasks/tsconfig.json`
- `packages/mcp-tasks/src/index.ts` — server entry, transport per ticket 016's recommendation
- `packages/mcp-tasks/src/office-client.ts` — typed HTTP client to the orchestrator, carrying the session identity ticket 016 settled on
- `packages/mcp-tasks/src/tools/claim-task.ts`
- `packages/mcp-tasks/src/tools/complete-task.ts`
- `packages/server/src/tasks/claim.ts` — the transactional claim: owner check, dependency check, lock acquisition, state transition
- `packages/server/src/tasks/complete.ts` — summary and learning required, locks released, transition to ready for QA
- `packages/server/src/routes/task-actions.ts` — `POST /tasks/:id/claim`, `POST /tasks/:id/complete`

### Files modified

None.

## Acceptance criteria

- [ ] `claim_task` succeeds only when all three checks pass; each failure returns a distinct, actionable message naming what blocked it and who owns the conflict.
- [ ] A claim by a session whose user is not the task owner is refused — asserted against a forged `owner` argument, proving the identity comes from the transport and not from the call.
- [ ] Claim is atomic: owner check, dependency check, lock acquisition and state transition happen in one transaction; a failure at lock acquisition leaves the task `pending` and no locks held.
- [ ] Two agents claiming the same task concurrently: exactly one wins, the loser gets a refusal naming the winner.
- [ ] `complete_task` rejects a call with an empty or whitespace-only `learning` and says why — the design makes the learning entry mandatory.
- [ ] `complete_task` moves the task to `ready for QA`, never `done`, and releases the task's file locks.
- [ ] The rebase and PR requirements are present as an explicit, named seam that currently returns "not implemented in step 2" rather than silently passing. A test asserts the seam is reachable, so step 4 cannot forget it.
- [ ] Tool errors reach the agent as readable text, verified with a real session calling both tools.
- [ ] Every claim and completion emits an event so the board updates live.

## Open questions

- [ ] `complete_task` in the design "requires rebase onto current `main-dev`, pushes the branch, opens the PR, triggers CI" — none of which exists before step 4. This ticket deliberately ships the tool without the git half. Confirm that a step-2 agent completing a task without pushing is acceptable for the interim, or whether step 2 should wait for step 4.
- [ ] The design does not say what happens to a claimed task whose agent dies before completing. Ticket 015's TTL releases the locks; nothing returns the task from `in progress` to `pending`. Assumed a human resumes it via ticket 028's pause/resume machinery. Confirm.
- [ ] Where the `learning` entry is stored is unspecified — the knowledge graph is step 5. Stored on the task row for now, with a note that step 5 migrates it.
- [ ] `approve_task`, `reject_task` and `deliver_task` are out of scope here; they belong to the QA gate in step 6. Listing them so the omission is visible.
