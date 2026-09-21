---
id: "025"
title: Tasks page composition, Draft column, and Start working
build_step: 3
department: dev
estimated_model: opus
blocked_by: ["019", "023", "024"]
---

# 025 — Tasks page composition, Draft column, and Start working

**Build step:** 3 — Tasks page and chat panel
**Department:** dev
**Estimated model:** opus — Start working is the button that turns a plan into running agents spending money; its review affordances are the design work.
**Blocked by:** 019, 023, 024

## Why

This ticket assembles the page and builds the one interaction the design treats as a gate: "You review
the batch in the Draft column. Reassign owners, change scope, split or merge, fix dependencies, delete,
add. **Start working** promotes the batch."

Everything before this is inert. After this, agents run.

## Scope

### Files created

- `packages/web/src/routes/tasks.tsx` — the page: filters, board, draft header, card wiring
- `packages/web/src/features/board/DraftColumn.tsx` — draft batch listing with per-task edit affordances
- `packages/web/src/features/board/StartWorkingDialog.tsx` — the confirmation: what will start, on which models, owned by whom
- `packages/web/src/features/board/useDraftBatch.ts` — batch loading, editing, and promotion against ticket 019's API

### Files modified

None.

## Acceptance criteria

- [ ] `/tasks` renders the four-column board with filters and cards, driven by live updates from ticket 023.
- [ ] The Draft column shows the pending batch and supports every edit the design lists: reassign owner, change file scope, split, merge, delete, add, fix dependencies.
- [ ] Validation errors from ticket 019 are shown **per task**, on the offending card, not as one page-level error — a batch that fails on three tasks shows three problems.
- [ ] The Start working dialog states, before anything starts: **how many tasks are being promoted and which leads will start**, plus the owners, the models, and any task whose model differs from the role default.
- [ ] Start working is disabled while the batch has validation errors, and the reason is visible without opening the dialog.
- [ ] Unordered scope overlap is shown as a validation error naming both tasks; the same overlap ordered by a dependency is not an error. Both cases are rendered.
- [ ] A failed promotion leaves the Draft column exactly as it was and shows the errors; no task silently moves and nothing spawns.
- [ ] After a successful promotion, the board reflects the new `pending` tasks through the event stream, without a manual refresh.
- [ ] Leads whose spawn was queued against the cap are reported in the result with the reason, not presented as started.
- [ ] Promotion is double-submit safe — a second click while the request is in flight does not promote twice.
- [ ] With no draft batch present, the Draft column explains how to create one (talk to Management) rather than rendering empty.
- [ ] The page works at 400 px width.

## Decided

**Start working is the only gate.** Reviewing the draft batch *is* the approval; the dialog confirms rather than re-approves. It promotes the tasks, spawns the department leads, and the leads claim immediately — so its copy must say plainly what is about to run, and how many agents that means.

## Open questions

- [ ] The design does not say whether a human can promote *part* of a batch. Not built; a batch promotes whole. Splitting a batch before promoting is the workaround, and it exists.
- [ ] Nothing specifies what happens to a draft batch that is never promoted. It sits forever. A stale-batch indicator may be wanted; not building one on speculation.
- [ ] There is no cost estimate available before starting, since token cost has no source until step 7. The dialog cannot answer "what will this cost" — the most obvious question a human will have at a button that now starts agents immediately.
