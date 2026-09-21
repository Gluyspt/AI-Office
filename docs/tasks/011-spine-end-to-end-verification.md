---
id: "011"
title: Spine end-to-end verification
build_step: 1
department: qa
estimated_model: sonnet
blocked_by: ["006", "009", "010"]
---

# 011 — Spine end-to-end verification

**Build step:** 1 — Spine
**Department:** qa
**Estimated model:** sonnet — the behaviour under test is fully specified by tickets 005–010.
**Blocked by:** 006, 009, 010

## Why

The design's gate for step 1 is concrete: "Orchestrator starts and messages them. `Stop` hook returns
replies. Interrupt button works." This ticket is the executable form of that gate, and the runbook a
human follows when the spine misbehaves on the VPS.

## Scope

### Files created

- `tests/spine/harness.ts` — starts the server against a scratch database, provisions a throwaway agent config, exposes helpers to drive and observe a real session
- `tests/spine/spine.e2e.test.ts` — the end-to-end suite
- `tests/README.md` — how to run each tier of tests, and which need a real `claude` binary
- `docs/runbooks/spine-verification.md` — the manual VPS checklist, with the expected output of each step

### Files modified

None.

## Acceptance criteria

- [ ] The suite starts a real Management lead session through `POST /sessions` and asserts a SessionStart event arrives within a stated timeout.
- [ ] It sends a message over `POST /sessions/:id/messages` and asserts the agent's reply arrives on the WebSocket stream as a chat message, matching the text the agent produced.
- [ ] It asserts round-trip latency from message sent to reply received, and records the observed value in the runbook — a number to notice regressions against, not a pass/fail threshold.
- [ ] It sends a message containing quotes, a backtick, a dollar sign and a newline, and asserts the agent received it intact (the agent is asked to echo it back).
- [ ] It interrupts a mid-turn agent and asserts the turn stops, the session stays `running`, and the interrupt is visible as an event.
- [ ] It kills the session and asserts SessionEnd arrives and the row becomes `ended`.
- [ ] It starts a Dev lead alongside Management and asserts the two transcripts stay separate.
- [ ] Failure path: with the event server stopped, an agent turn still completes, and after the server restarts the system is consistent — no duplicated or lost chat messages beyond what ticket 002 recorded about hook retries.
- [ ] Every test that needs a real `claude` binary is tagged so the suite can run without one in CI, and `tests/README.md` says which tier is which.
- [ ] `docs/runbooks/spine-verification.md` can be followed by someone who did not build the spine, and each step states what correct output looks like.

## Open questions

- [ ] Running these tests spends real tokens on a real account. The design has no test account and no budget for it. The target is a **throwaway repo** (decided), on the cheapest available model, stated in the runbook — but who pays is still unanswered.
- [ ] Whether the suite belongs in CI at all is undecided — the CI runner is step 6. For now it is run by hand.
- [ ] An agent is a non-deterministic system under test. Assertions here match on the echoed content the agent was asked to produce, not on phrasing. If that proves flaky, the fallback is a stub binary that mimics the hook contract; that stub does not exist yet.
