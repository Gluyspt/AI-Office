---
id: "030"
title: Step 3 acceptance pass
build_step: 3
department: qa
estimated_model: sonnet
blocked_by: ["025", "026", "027", "029", "031"]
---

# 030 — Step 3 acceptance pass

**Build step:** 3 — Tasks page and chat panel
**Department:** qa
**Estimated model:** sonnet — the criteria come from tickets 022–031 and the design's step-3 gate.
**Blocked by:** 025, 026, 027, 029, 031

## Why

Step 3's gate is "the UI becomes usable", and steps 1–3 are where the design says the risk lives. This
ticket is the judgement call on whether the team can actually run a day's work through the UI — and the
written record of what it cannot do yet, so step 4 starts from facts rather than assumptions.

## Scope

### Files created

- `tests/ui/board.test.tsx` — board rendering, live updates, filters, draft promotion
- `tests/ui/chat.test.tsx` — transcript, send states, blocked banner, agent switching
- `docs/runbooks/step3-acceptance.md` — the manual walkthrough and its results, including the known-gaps list

### Files modified

None.

## Acceptance criteria

- [ ] **The full loop runs end to end, by hand, against a throwaway repo, and is recorded in the runbook:** plan a batch with Management → review it in the Draft column → Start working → leads spawn and claim automatically → watch it on the board → open a task's detail page → chat with its agent → interrupt it → pause the project → resume it → kill the agent.
- [ ] **Resume shows continuous chat history** across the pause, with a labelled session boundary — the visible proof that ticket 010's conversation model works.
- [ ] **A dependency chain flows through the UI:** a batch with A→B, A advanced via ticket 032's interim control, B becoming claimable and its agent starting — the walkthrough that proves coordination and the UI agree.
- [ ] **The spawn cap is exercised deliberately:** set it below the batch's lead count, promote, and confirm the excess queues with its reason shown rather than failing or spawning anyway.
- [ ] **The guard outage path is exercised deliberately:** stop the orchestrator, have an agent edit a file owned by another task, restart, and confirm the degraded banner appeared, the buffer flushed, and both tasks were flagged for review.
- [ ] Automated tests cover board rendering, live task movement, filter combination, draft validation display, and promotion — against a mocked API, so they run without a `claude` binary.
- [ ] Automated tests cover the chat panel's send states (pending, sent, failed with retry), the blocked banner appearing and clearing, and switching between two agents without transcript bleed.
- [ ] A two-agent scenario is verified in the browser: both running, both chattable, one interrupted without affecting the other.
- [ ] The disconnected state is verified by stopping the event server with the UI open: the board says it is stale, and recovers with correct data when the server returns.
- [ ] Every page in scope is checked at 400 px width.
- [ ] Keyboard-only navigation reaches the board, the card's primary action, the chat composer, Interrupt and Kill.
- [ ] Measured and recorded in the runbook: time from an agent's turn ending to its reply appearing; time from clicking Interrupt to the turn stopping; board render time with 200 tasks.
- [ ] The runbook's **Known gaps** section lists every step-3 seam that is deliberately inert — WIP commit and handoff on pause, git and PR in `complete_task`, token cost, live model switching, authentication — each naming the step that fills it.
- [ ] A verdict is written: can the team run a day's work on this, and what is the first thing that will hurt.

## Open questions

- [ ] Browser-test tooling is not specified anywhere in the design. Assumed the component-level testing library that pairs with ticket 001's runner, with the full-loop walkthrough done by hand rather than automated — automating a flow that spawns real agents costs tokens on every run. Confirm before adding a browser driver.
- [ ] The walkthrough runs against a **throwaway repo**, per the first-project decision. It therefore proves the machinery, not that the machinery survives a real codebase's conventions. Repointing at a real project is the next thing to do after this pass clears, and the runbook should say so.
- [ ] Step 3 has one user and no authentication, so nothing here tests multi-user behaviour, presence, or cross-owner instruction. That is step 9's acceptance work; note it in the runbook so the gap is not mistaken for coverage.
- [ ] Whether this verdict gates starting step 4 is a human decision, not one this ticket can make.
