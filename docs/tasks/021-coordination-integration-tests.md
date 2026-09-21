---
id: "021"
title: Coordination integration tests
build_step: 2
department: qa
estimated_model: sonnet
blocked_by: ["014", "017", "019", "020", "032"]
---

# 021 — Coordination integration tests

**Build step:** 2 — Coordination
**Department:** qa
**Estimated model:** sonnet — the behaviour under test is fully specified by tickets 012–020.
**Blocked by:** 014, 017, 019, 020, 032

## Why

Step 2's guarantees are the ones that are expensive to discover broken: two agents editing the same
file, a task starting before its dependency finished, a batch promoting halfway. Unit tests inside each
ticket cover their own module; this ticket covers the paths that cross all of them, with real
concurrency against a real database.

## Scope

### Files created

- `tests/coordination/claim-complete.test.ts` — the claim/complete lifecycle including concurrent claims
- `tests/coordination/dependencies.test.ts` — dependency refusal, unblocking, cycles
- `tests/coordination/guard.test.ts` — the PreToolUse guard against live locks, including fail-open
- `tests/coordination/planning.test.ts` — draft batch editing, validation, atomic promotion
- `docs/runbooks/coordination-verification.md` — the manual checklist for verifying coordination on the VPS

### Files modified

None.

## Acceptance criteria

- [ ] **Two agents, one file:** two sessions claim tasks with overlapping scopes; exactly one claims, and the other's edit attempt is blocked by the guard with a message naming the owner. Run as a real end-to-end test with two sessions.
- [ ] **Dependency ordering:** a task blocked by an unfinished dependency cannot be claimed; when the dependency reaches `delivered` — via ticket 032's no-gate advance, since no real gate exists yet — it becomes claimable and the unblock event fires exactly once.
- [ ] **A chain flows:** three tasks A→B→C, each advanced in turn, with each dependent becoming claimable only at the right moment. This is the test that proves dependency machinery works before step 4 makes it real.
- [ ] **Atomic promotion:** a batch with one invalid task promotes nothing, and every validation failure is reported in one response.
- [ ] **Lock release, all three paths:** normal completion, SessionEnd after a kill, and TTL expiry after a simulated hard crash each release locks — one test per path, since the design relies on all three.
- [ ] **Cap enforcement:** spawning past the project cap is refused and the count is accurate afterwards.
- [ ] **Learning required:** `complete_task` without a learning entry is refused, asserted through the MCP tool rather than the HTTP endpoint, so the agent-facing path is what is tested.
- [ ] **Crash recovery:** killing the orchestrator mid-claim leaves no task in a half-claimed state — the task is either `pending` with no locks or `in progress` with all of them.
- [ ] Every test cleans up its sessions; the suite leaves no tmux sessions behind, asserted by a final check.
- [ ] `docs/runbooks/coordination-verification.md` covers what to check when an agent reports it cannot claim a task it believes it owns — the most likely real-world support question.

## Open questions

- [ ] These tests need two real agent sessions and therefore two accounts to be fully honest, but step 2 has one. The cross-owner cases are tested by forging the identity argument against the API instead. Note the gap in the runbook so step 9 re-runs them properly.
- [ ] TTL expiry testing requires either a configurable clock or a very short TTL. Assumed an injectable clock in ticket 015; if it was not built that way, this test needs a real wait and the suite gets slow.
