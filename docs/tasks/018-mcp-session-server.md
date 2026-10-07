---
id: "018"
title: "MCP session server: start_session, message_session, and per-project caps"
build_step: 2
department: dev
estimated_model: opus
blocked_by: ["008", "016"]
---

# 018 — MCP session server: start_session, message_session, and per-project caps

**Build step:** 2 — Coordination
**Department:** dev
**Estimated model:** opus — cap enforcement and the model-choice contract are judgement calls, not plumbing.
**Blocked by:** 008, 016

## Why

"Leads call it; they never spawn directly, so per-project caps apply to every spawn." A lead that can
spawn agents is what turns the spine into a company. The cap is the point of routing spawns through the
orchestrator at all — without it, a lead in a loop can exhaust the VPS.

## Scope

### Files created

- `packages/mcp-session/package.json`
- `packages/mcp-session/tsconfig.json`
- `packages/mcp-session/src/index.ts`
- `packages/mcp-session/src/office-client.ts`
- `packages/mcp-session/src/tools/start-session.ts`
- `packages/mcp-session/src/tools/message-session.ts`
- `packages/server/src/features/orchestrator/caps.ts` — per-project concurrency limit and the global memory floor, evaluated inside ticket 008's start path
- `packages/server/src/features/orchestrator/spawn-queue.ts` — queued spawns, the reason each was refused, and draining as capacity frees
- `db/migrations/0008_spawn_queue.sql` — the queue, durable across an orchestrator restart

### Files modified

None.

## Decided

Two limits, both checked at spawn time. This is the **early-stage protection against runaway spawning**, standing in for the circuit breaker until step 7 builds it.

1. **Per-project max concurrent agents** — required config, no default shipped. Set from the RSS measurement against the VPS's actual RAM: the bare floor is ticket 007's (taken 2026-10-07), the loaded figure the cap is actually set from is this ticket's.
2. **Global memory floor** — refuse any spawn, in any project, when available memory is below a configured threshold. A plain check against `/proc/meminfo`, not adaptive headroom management.

A refused spawn is **queued, not dropped**, and the queue records which of the two limits refused it.

Source: `docs/spikes/002-tmux-tui-control.md`.

- **~~The RSS measurement this ticket's cap is meant to come from does not exist.~~ Half of it now
  does.** 003 deliberately took no readings; ticket 007 took the **bare-agent floor** on the VPS
  2026-10-07 (below). The figure the cap is actually set from is still missing, because it needs a
  *loaded* agent and that is this ticket's own measurement — see the cycle note at the end of this
  section. So: a defensible floor exists, a defensible cap does not.
- **~~The provisional figure is not usable as a default.~~ Superseded by a VPS reading, 2026-10-07.**
  The worry was a 2× spread: WSL measured ≈0.26 GB process-tree RSS for an idle agent while the
  *previous* Claude Code build measured 0.57–0.58 GB on the same machine, and WSL2 memory accounting
  is not a bare VPS's. **Measured on `rtdvps` through `sudo -n -u agent1`: ≈0.29 GB median, 0.34 GB
  peak**, over two independent 20-sample runs that agree to within 1 MB on peak. The spread
  resolves toward the low end — within ~10% of the WSL figure — so the 0.58 GB belonged to a
  different *build*, not a different kernel, and WSL2's accounting was not misleading for this
  quantity. Still a **bare-agent floor**: no MCP servers, no hooks, no role file, empty repo.
- **Mid-turn RSS is now measured, and it did not behave as this ticket assumed.** This ticket said
  mid-turn "is what actually determines whether the box survives N concurrent agents". Measured:
  mid-turn peaked at **327 MB, *below* the 343 MB idle peak.** But the series was still rising
  monotonically when the turn ended after ten samples, so that is a lower bound truncated by a
  trivial turn — not a ceiling. **Mid-turn under real work, with tools and a large context, remains
  unmeasured**, and is part of this ticket's loaded measurement below. Do not read the 327 MB as
  "mid-turn is cheap"; read it as "a short turn is not where the cost is".
- **Idle is not flat, so one sample is the wrong sample.** Both runs sit near 290 MB and spike
  transiently to ~350 MB before falling back. A reading taken shortly after startup understates the
  peak by roughly 20%. The cap must come from a peak over a window, not from a point.
- **The arithmetic, with real numbers.** `MemTotal` 3 360 800 KB; `MemAvailable` **2 310 768 KB
  (2.20 GB)** with one agent running — the figure this ticket's floor reads. At 0.34 GB peak per
  bare agent: **≈6 bare agents.** Every remaining term reduces it — the orchestrator and Postgres
  are not yet on the box, a graph server per project arrives at step 5, and real agents carry the
  four things these did not. A per-project cap above 4 on this host would be optimistic, and that
  is a statement about arithmetic, not a default: the config still ships with none.
- **So the cap ships as required config with no default, and its config comment records that it is
  unmeasured**, naming 007 as the ticket that replaces the guess. This is not a formality: 019 inherits
  this cap as its only safety property, and 029 renders it to the user as though it meant something.
- **This ticket now owns the *loaded* RSS measurement; 007 owns only the floor.** Settled
  2026-10-07. Pointing at 007 for the whole figure was a cycle: a real agent carries hooks and an
  `--agent` role file, both of which are **009's** output, and MCP servers, which are this
  ticket's — while the chain is `007 → 008 → 009 → 016 → 018`. 007 cannot measure what 009 has not
  yet installed. So 007 measures a bare agent on the real kernel as a **floor**, and the figure the
  cap is actually set from is measured here, by the first ticket that can load an agent to be
  measured. Re-run `spikes/tmux/drive-session.sh rss --samples 20 --interval 1 [--midturn]` against
  an agent provisioned by 009 and wired by 016, and record it against the host profile in
  `docs/spikes/002-tmux-tui-control.md`.
- **The target host is small, and that is now a measured fact rather than an assumption.** `rtdvps`:
  **`MemTotal` 3.2 GB**, 4 threads of an i3-7100T — and it must also hold the orchestrator, Postgres
  and a graph server per project. The global `/proc/meminfo` floor is therefore the load-bearing
  limit on this box, not the per-project cap: a floor configured as though there were 8 GB to spend
  would never refuse a spawn until the host was already swapping. Note the floor must be set against
  `MemAvailable` **with the office already running**, which is not what was measured — the 2.20 GB
  above was read on an otherwise idle box with one agent on it.

## Acceptance criteria

- [ ] `start_session(role, dept, owner, project, brief, backend, model)` starts a session through ticket 008's API and returns its id and tmux name.
- [ ] A spawn that would exceed the project's agent cap is **queued**, not dropped, and the response says it was queued and why.
- [ ] A spawn refused by the global memory floor is queued with that reason recorded distinctly from the per-project reason — "project is under its cap but nothing is spawning" must never be unexplained.
- [ ] The queue drains automatically as agents end: a queued spawn starts within one poll interval of capacity freeing, asserted end to end.
- [ ] The queue survives an orchestrator restart with its entries and reasons intact.
- [ ] Cap evaluation is race-free: N concurrent spawns against a cap of K start exactly K and queue the rest, asserted with a real concurrent test.
- [ ] The memory floor is read from `/proc/meminfo` at spawn time, not cached, and a test with a stubbed reading asserts both the refusal and the recovery.
- [ ] **The loaded RSS figure is measured and the cap is set from it.** An agent provisioned by 009
      (hooks, `--agent` role file) and wired by 016 (MCP servers), in a real repo, sampled idle and
      mid-turn on the target host; recorded in `docs/spikes/002-tmux-tui-control.md` against that
      host's profile. Until this runs, the config comment keeps naming the cap unmeasured — 007's
      bare-agent floor does not satisfy this criterion and must not be copied into the default.
- [ ] `start_session` requires a one-line reason for the chosen model and rejects a call without one, per the design's spawn-feed requirement.
- [ ] Spawning is non-blocking: the tool returns before the agent's first turn, and an event records what model was picked and why.
- [ ] A lead may only spawn for owners it is permitted to spawn for; a cross-owner spawn is refused. (In step 2 there is one owner, so this is asserted against a forged argument.)
- [ ] `message_session` delivers to a running session and returns a clear refusal for an ended one.
- [ ] A worker-role session cannot call `start_session` for a lead role — a test asserts the role check.
- [ ] Both tools are callable from a real Dev lead session end to end.

## Carried to later steps

- **Step 7 (Usage page):** surface observed peak per-agent memory, so the per-project cap can be revisited against real data instead of staying at its first guess.
- **Step 8 (Previews):** preview containers must be subject to the same global memory floor. They are heavier than agents.

## Open questions

- [ ] Whether a queued spawn should expire. A batch promoted against a full cap could sit queued for hours; nothing currently ages entries out. Not implemented, because silently dropping a lead's spawn is worse than a long queue — but it needs a decision before a queue gets deep.
- [ ] Queue ordering is FIFO. Whether a lead's spawn should outrank an agent's, or one project should not be able to fill the queue ahead of another, is unaddressed by the design.
- [ ] The design says the orchestrator refuses `start_session` while paused. The pause flag arrives in ticket 028; the check is a named stub here and 028 fills it. Do not ship step 3 with the stub still empty.
- [ ] The design lists four session tools — `start_session`, `message_session`, `report_progress`, `ask_model`. `report_progress` has no defined payload or consumer anywhere in the design, and `ask_model` needs the LiteLLM gateway from step 11. Both are out of scope here; `report_progress` needs a definition before anyone builds it.
- [ ] Nothing says whether a lead may kill sessions it started. Not exposed as a tool; humans kill through the UI. Confirm that is intended — a lead cleaning up after itself seems reasonable.
