---
id: "036"
title: "DAS lanes: reserved connections for the hot path"
build_step: boundaries
department: dev
estimated_model: opus
blocked_by: ["034"]
---

# 036 — DAS lanes: reserved connections for the hot path

**Build step:** boundaries
**Department:** dev
**Estimated model:** opus — it is a concurrency change on the one path where latency is an agent sitting still, and the test has to create real starvation to mean anything.
**Blocked by:** 034

## Why

This is the fault-isolation driver, for the failure mode that is not a crash. It is also a defect
that exists today.

`core/db/pool.ts` is one pool, one `max`, one `statement_timeout` for the whole server. So a board
query storm, a 200-task dependency walk, or one long transaction in `planning` can hold every
connection in the pool while the **PreToolUse guard** waits for one. The guard is not a background
job: it is called synchronously by a hook while a live agent sits mid-tool-call, on a ~2 s fail-open
budget. Exhaust the pool and the guard fails open on every edit until the storm passes — which means
the window where two agents can edit the same file is opened by an unrelated feature being busy.

The same pool also serves `events/ingest`, which has a measured 50 ms p95 budget and, on the real
VPS, already produced one run at 26.76 ms under ordinary contention. Half the budget gone to
neighbours, with nothing isolating it.

Zero RAM, no new process, no network hop. This is the fault isolation that one process can actually
give you.

## Scope

### Files created

- `packages/server/src/platform/das/lanes.ts` — lane definitions, per-lane ceilings and statement timeouts, checkout routing by grant, and the queue behaviour when a lane is full
- `packages/server/src/platform/das/lanes.test.ts` — including the starvation test below
- `packages/server/src/platform/das/saturation.ts` — what a caller is told when its lane is full: a typed refusal carrying the lane, its ceiling and the current holders, and the event that makes saturation visible rather than merely slow

### Files modified

- `.env.example` — appended (manifest exception): lane ceilings and timeouts
- `packages/server/src/core/config.ts` — appended `loadLaneConfig()` (manifest exception)

Pointing the guard at the reserved lane edits `features/locks/` files owned by 020, so that is a
dated section on **020**, not here. This ticket builds the lanes and proves them with a synthetic
grant.

## Decided

**Two lanes, not one per service.** `hot` for the guard and ingest; `general` for everything else. A
lane per service sounds tidier and is worse: with eight services and a pool whose total is set by
`DATABASE_POOL_SIZE` on a 4-thread box, per-service ceilings would each be two or three connections,
and the first feature to need four would be starved by its own ceiling rather than by a neighbour.
Two lanes put the boundary exactly where the latency requirement is.

**Lane ceilings overcommit; the reservation does not.** `hot` holds a *minimum* reserved count that
`general` can never consume, while both may burst into unused capacity. The guarantee that matters
is "the guard always has a connection", not "the guard has its own pool" — a dedicated pool sized
for the worst case would idle most of the day on a box with 3.2 GB.

**A full `hot` lane refuses immediately rather than queueing.** The guard's budget is ~2 s and its
fail-open path is already built, buffered and visible in the UI (020, 022, 029). Waiting 1.9 s to
then fail open is strictly worse than failing open at once: same outcome, 1.9 s of an agent's life,
and a hook timeout that looks like a different bug. `general` queues as today.

**Saturation emits an event.** A fail-open caused by lane saturation must be distinguishable from a
fail-open caused by the orchestrator being down, because the fixes are opposite — one is a pool
size, the other is a restart. 020's degraded banner already exists; this gives it a second reason to
show, with its own text.

**Statement timeout is per lane** — answering 034's open question in the direction 034 guessed. The
`hot` lane's timeout is below the guard's own budget, so the database gives up before the hook does;
otherwise a slow query burns the agent's wait and then fails open anyway.

## Acceptance criteria

- [ ] With `general` holding every connection it is permitted, a `hot` checkout still succeeds.
      Asserted by actually saturating the lane with held transactions, not by mocking the pool —
      this is the criterion the ticket exists for.
- [ ] With `hot` saturated, a `hot` checkout refuses immediately (within one event-loop turn, not
      after a timeout) and the refusal names the lane, its ceiling and the holders.
- [ ] `general` still queues and still succeeds once a connection frees.
- [ ] `hot` can burst above its reservation when `general` is idle.
- [ ] A statement exceeding its lane's timeout is cancelled by the database, and the error says which
      lane's budget it exceeded.
- [ ] The `hot` lane's timeout is asserted to be strictly less than the guard's configured budget,
      refusing at boot if it is not — the two numbers live in different config sections and will
      otherwise drift.
- [ ] A saturation refusal emits its event exactly once per occurrence, not once per retry.
- [ ] Lane metrics (in use, reserved, waiting, refused) are exposed per lane via 034's counters.
- [ ] Ingest p95 measured with `general` saturated. The number before this ticket is the finding;
      the number after is the acceptance.
- [ ] No lane configuration ships a default. Per 015's precedent on lock TTL: the system refuses to
      start without them, so the numbers get chosen deliberately on the box they run on.

## Open questions

- [ ] **What are the numbers?** Total pool size, the `hot` reservation, and the two timeouts all want
      measuring on the real VPS rather than guessing on Windows. This is the same shape as the
      design's own "Default caps" open question and the same resolution: config with no default,
      measured on `rtdvps`, recorded here. Needs the box.
- [ ] Should the WebSocket fan-out be `hot`? It is latency-sensitive to a human watching the board,
      but a slow board update costs a second of someone's attention, not an idle agent. Currently
      `general`. Revisit if the Lobby feels laggy under load.
- [ ] Lane assignment is per grant, so a service is entirely in one lane. `locks` is a problem for
      that: the guard is hot, but the sweeper and `listActive` are not. Either `locks` gets two
      grants or lane becomes a per-call override. Leaning two grants, because a per-call override is
      a decision at every call site and will be got wrong once.
