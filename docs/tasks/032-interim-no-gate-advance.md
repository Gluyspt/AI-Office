---
id: "032"
title: Interim no-gate advance control
build_step: 2
department: dev
estimated_model: sonnet
blocked_by: ["014", "017"]
---

# 032 — Interim no-gate advance control

**Build step:** 2 — Coordination
**Department:** dev
**Estimated model:** sonnet — one endpoint, one record, one control. Small by design, because it has to be deleted whole.
**Blocked by:** 014, 017

## Why

Dependents unblock at `delivered`, but nothing in steps 1–3 can reach `delivered`: `complete_task`
stops at `ready for QA`, the squash-merge that `delivered` represents is step 4, and CI and the QA
agent are step 6. Without something in between, a dependency chain advances exactly one link and then
stalls — unattended, because leads now claim automatically.

This ticket is the stand-in. It exists to exercise dependency unblocking end to end during steps 2–3,
and **it is designed to be deleted in step 6**, not extended.

## Scope

### Files created

- `db/migrations/0012_gate_bypass.sql` — `gate_bypassed`, `bypassed_by`, `bypassed_at` on tasks. Highest migration number deliberately, so its removal unwinds last
- `packages/server/src/tasks/advance-no-gate.ts` — the transition to `delivered`, the bypass record, and the unblock call into ticket 014
- `packages/server/src/routes/task-advance.ts` — `POST /tasks/:id/advance-no-gate`
- `packages/web/src/features/board/AdvanceNoGate.tsx` — the control and its confirmation

### Files modified

None.

## Acceptance criteria

- [ ] **The control is labelled "Advance (no gate yet)"**, never "Mark delivered" or "Approve". Its confirmation states plainly that no merge and no QA pass has happened and that this is standing in for a gate that does not exist yet.
- [ ] Advancing records **who clicked it and when**, flagged as gate-bypassed on the task.
- [ ] A gate-bypassed task is visibly marked as such wherever it appears — the board card and the task detail page — so it stays identifiable after the fact.
- [ ] `GET /tasks?gate_bypassed=true` lists every task that never went through a real gate, so the set is enumerable later rather than needing a history trawl.
- [ ] Advancing moves the task to `delivered` through ticket 012's `transition()`, never by writing the column directly.
- [ ] **End-to-end test:** create A and B with B blocked by A, confirm B is unclaimable, advance A, confirm B becomes claimable and the unblock event fires exactly once.
- [ ] The control is unavailable for a task not in `ready for QA`, and the refusal says why.
- [ ] Every file in this ticket's scope is listed in a header comment in `advance-no-gate.ts` as the deletion manifest for step 6.

## Required acceptance criterion for step 6

When the QA gate is built, this must be an acceptance criterion on its ticket — a checkbox, not a note:

> - [ ] The no-gate advance control is deleted and the QA gate replaces it: `advance-no-gate.ts`, `task-advance.ts`, `AdvanceNoGate.tsx` removed, and `0012_gate_bypass.sql` unwound once no task depends on the flag.

Tasks already flagged gate-bypassed keep their record — the flag is history, and the point of recording it was to know later which work never passed a real gate.

## Open questions

- [ ] Whether a gate-bypassed task should be re-reviewable once the real gate exists — pushed back through QA retroactively — is unaddressed. Not built; the flag makes the set findable if someone decides to.
- [ ] The control asserts a state whose meaning (squash-merged into `main-dev`) is not true in steps 2–3. The label carries that honesty, but anyone reading the database directly will see `delivered`. Accepted deliberately; the bypass flag is what distinguishes them.
