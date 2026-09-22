---
id: "027"
title: Agent controls and blocked banner
build_step: 3
department: dev
estimated_model: sonnet
blocked_by: ["008", "026"]
---

# 027 — Agent controls and blocked banner

**Build step:** 3 — Tasks page and chat panel
**Department:** dev
**Estimated model:** sonnet — three buttons over an API that already exists, plus one event handler.
**Blocked by:** 008, 026

## Why

"Interrupt is the one you'll use constantly. Put it on the agent card, not buried in a menu." This is
the ticket that completes step 1's stated gate — the Interrupt button — and adds the blocked banner
that makes a stuck permission prompt visible instead of looking like a slow agent.

## Scope

### Files created

- `packages/web/src/features/chat/AgentControls.tsx` — Interrupt, Kill, and the model chip
- `packages/web/src/features/chat/BlockedBanner.tsx` — permission-request banner naming what the agent asked for
- `packages/server/src/features/permissions/handlers/permission.ts` — records a PermissionRequest, marks the session blocked, clears it when the session moves on
- `packages/shared/src/permissions.ts` — the blocked-state record

### Files modified

None.

## Acceptance criteria

- [ ] Interrupt is a single click with no confirmation, and reflects its effect within two seconds — it is meant to be used reflexively.
- [ ] Kill requires confirmation naming the agent and warning that unsaved work is lost, per the design's "A killed agent cannot save anything".
- [ ] Both controls are visible on the panel header without scrolling or opening a menu.
- [ ] A PermissionRequest event raises the blocked banner within a second, naming the permission the agent asked for.
- [ ] The banner tells the human what to do — open that tmux session and answer there. The design forbids keystroke injection for prompts, so the UI must not offer an Approve button it cannot honour.
- [ ] The banner clears when the session produces its next event, and does not linger after the human answers in tmux.
- [ ] A blocked agent is visually distinct on its task card as well as in the panel, so it is noticeable without the panel open.
- [ ] The model chip shows the current model and its reason from ticket 008. Clicking it explains that switching is not available until step 11, rather than presenting a control that silently does nothing.
- [ ] Interrupting or killing an already-ended session shows a clear message rather than an error dialog.
- [ ] Both actions are recorded with the acting identity and are visible in the transcript, so a teammate's interrupt is not a mystery to the agent's owner.

## Open questions

- [ ] Live model switching is step 11. The design puts a clickable model chip in the panel, so this ticket shows the chip and disables the action. Confirm that is preferable to hiding the chip until step 11.
- [ ] The design's "anyone can instruct any agent" office setting does not exist until step 9, and there is one user in step 3. Kill and interrupt are therefore unrestricted. Recorded here so it is not forgotten when multiple accounts arrive — an unrestricted Kill across owners is a bigger deal than an unrestricted message.
- [ ] Nothing specifies whether the blocked banner should also fire a notification. Discord is step 6; the event is emitted and nothing consumes it yet.
- [ ] Whether a blocked agent should count against the project's session cap is unspecified. It currently does, since it holds a process.
