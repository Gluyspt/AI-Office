---
id: "029"
title: Pause, emergency stop, and resume UI
build_step: 3
department: dev
estimated_model: sonnet
blocked_by: ["018", "020", "022", "028"]
---

# 029 — Pause, emergency stop, and resume UI

**Build step:** 3 — Tasks page and chat panel
**Department:** dev
**Estimated model:** sonnet — the behaviour is defined by tickets 018, 020 and 028; this is the surface over them.
**Blocked by:** 018, 020, 022, 028

## Why

These are the controls a human reaches for when something is going wrong — often quickly, often on a
phone. They need to be findable, honest about what they cost, and impossible to trigger by accident.

The route is also where the two things that stop work without anyone asking become visible: spawns
sitting in the cap queue, and edits that bypassed the guard while the orchestrator was down.

## Scope

### Files created

- `packages/web/src/routes/control.tsx` — the controls route, linked from the shell nav
- `packages/web/src/features/control/overlay.tsx` — registers a compact status-and-stop overlay available from any page
- `packages/web/src/features/control/StopControls.tsx` — pause, emergency stop, resume, per project and global
- `packages/web/src/features/control/ConfirmStopDialog.tsx`
- `packages/web/src/features/control/SpawnQueue.tsx` — queued spawns with the limit that refused each
- `packages/web/src/features/control/UnguardedEdits.tsx` — edits that bypassed the guard during an outage, and the tasks flagged for review
- `packages/web/src/features/control/useControl.ts`
- `packages/web/src/features/control/control.css`

### Files modified

None.

## Acceptance criteria

- [ ] Pause and Emergency stop are reachable from any page in at most two interactions, via the overlay.
- [ ] Each control states its scope before confirming — this project, or everything — and the scope is impossible to misread.
- [ ] Pause's dialog states what it does and what it costs: agents are interrupted, asked to save, then killed after the deadline, and it takes up to that long. The deadline value is shown, not hidden in config.
- [ ] Emergency stop requires a distinct, more deliberate confirmation than Pause, and states that the current turn's reasoning is lost.
- [ ] **The dialog states the step-3 limitation honestly:** WIP commit and handoff are not implemented yet (ticket 028's seams), so a pause preserves task state and locks but not in-flight work. This copy is removed when steps 4 and 5 land.
- [ ] Progress is visible during a pause: which agents have stopped, which are still saving, which missed the deadline.
- [ ] A paused project is unmistakable on the Tasks page too, not only on the controls route — a human arriving at a quiet board must be able to tell paused from idle.
- [ ] Resume offers both levels from the design: one task, or everything in a project, and shows what will not resume because a dependency is still paused.
- [ ] While paused, any action that would start work is disabled with the reason shown, rather than failing after the click.
- [ ] Queued spawns are listed with **which limit refused each one** — the project cap or the global memory floor. "The project is under its cap but nothing is spawning" must never be unexplained.
- [ ] A queued spawn that starts as capacity frees disappears from the list without a refresh.
- [ ] Unguarded edits from a guard outage are listed, grouped by the outage window, with the tasks flagged for review linked from each.
- [ ] Controls are usable at 400 px width, since this is the one screen most likely to be used from a phone.
- [ ] A failed or partial pause is shown as such, with a retry — never reported as complete when some agent survived.

## Open questions

- [ ] The design puts these controls on the Company overview page, which is step 12. This ticket gives them their own route plus an overlay, so they exist before agents run unattended as the design requires. Moving them onto Company overview later is a nav change, not a rewrite.
- [ ] Nothing says whether a viewer-role member can pause. Roles are step 9; in step 3 anyone can. Recorded so it is decided when roles land — pause is one of the more consequential things a viewer could reach.
- [ ] No confirmation-by-typing is specified for emergency stop (the design only requires typing a name when deleting an office). Assumed a two-step confirm is enough. Revisit if someone triggers it by accident.
