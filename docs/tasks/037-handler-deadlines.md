---
id: "037"
title: "Handler deadlines: a hung handler must not stall ingest"
build_step: boundaries
department: dev
estimated_model: sonnet
blocked_by: ["033"]
---

# 037 — Handler deadlines: a hung handler must not stall ingest

**Build step:** boundaries
**Department:** dev
**Estimated model:** sonnet — one well-understood change (a deadline around a dispatch loop) with a clearly bounded blast radius. The hard part was deciding it was needed, which §5.4 of the design already did.
**Blocked by:** 033

## Why

The fault-isolation driver, for the one failure in the event path that nothing catches.

What is already handled, and needs **no** work — checked before this ticket was written:

- a bus subscriber that throws is isolated (`bus.ts:68-75`: *"a throw here would fail a hook POST
  over a WebSocket problem"*),
- a handler module that fails to load, or does not export the right shape, is logged and skipped
  (`handler-loader.ts`, whose contract comment says exactly why),
- a handler whose `handle()` throws is caught per handler (`ingest.ts:209-212`).

What is **not** handled is a handler that *hangs*. Dispatch is a sequential `for (const handler of
handlers) { await handler.handle(...) }`, so one handler that never settles stalls every handler
behind it and the ingest POST itself. A `try/catch` cannot see that, and the system has several
plausible ways to produce it: a handler waiting on a lane that is saturated (036), a handler that
messages a tmux pane whose session is wedged, a handler holding a transaction behind a lock another
transaction holds.

Ingest is what a **blocking hook** waits on. A stalled dispatch is therefore not a slow background
job; it is an agent stopped mid-turn, with the 50 ms p95 budget missed by orders of magnitude and
nothing in the logs saying which handler did it.

## Scope

### Files created

- `packages/server/src/platform/events/deadline.ts` — `withDeadline(handler, ms)`: runs a handler under a timer, and on expiry abandons it, records which handler exceeded its deadline, and lets dispatch continue
- `packages/server/src/platform/events/deadline.test.ts`
- `packages/server/src/platform/events/slow-handlers.ts` — the record of handlers that exceeded or neared their deadline, so a repeat offender is visible instead of being re-discovered

### Files modified

Wiring `withDeadline` into the dispatch loop touches
`packages/server/src/features/events/ingest.ts`, which **005 owns permanently**. Per the repo's
reopening rule, that is a dated section on **005** carrying this one change and its criterion — not
a file this ticket claims. This ticket delivers the mechanism and its tests; 005's dated section is
three lines and is listed as a blocking criterion below.

## Decided

**A deadline abandons, it does not cancel.** There is no way to cancel an in-flight `await` in Node,
and handlers do not take an `AbortSignal` today. So expiry means dispatch stops *waiting* and moves
on; the abandoned handler may still complete later, and if it throws after abandonment that throw is
caught and attributed rather than becoming an unhandled rejection. Pretending to cancel would be a
lie in the type signature. Giving handlers an `AbortSignal` is a better end state and a bigger
change than this: see the open question.

**Per-handler deadline, not a whole-dispatch deadline.** A whole-dispatch budget would let the first
handler consume all of it and starve the rest, which is the current failure wearing a timer. Each
handler gets its own, so one hung handler costs its own deadline and nothing else.

**The default is derived from the ingest budget, not chosen freely.** `events/ingest` asserts a p95
under 50 ms and the real VPS has produced 26.76 ms under contention. A per-handler deadline that can
sum above the budget makes the budget unenforceable, so the deadline is configured as a fraction of
it with the handler count accounted for, and boot refuses a configuration where the worst case
exceeds the budget. Two numbers in two config sections that must agree, so the code makes them
agree — the same reasoning as 036's guard-timeout check.

**An exceeded deadline is an event, not just a log line.** A handler that silently stops running is
how the chat panel or the board quietly stops updating; it needs to be visible in the same place as
every other degradation (020's banner, 029's control page) rather than in a log nobody reads. Once
is a warning, repeatedly is a broken handler, and `slow-handlers.ts` is what tells them apart.

## Acceptance criteria

- [ ] A handler that never settles does not stall dispatch: the handlers after it still run, and the
      ingest POST still returns.
- [ ] The ingest POST for an event with a hung handler stays inside the 50 ms p95 budget — the real
      point of the ticket, asserted as a timing test at the same shape 005's budget test uses.
- [ ] An abandoned handler that later *throws* does not become an unhandled rejection and is
      attributed to the handler that was abandoned.
- [ ] An abandoned handler that later *succeeds* is recorded as having exceeded its deadline, not as
      having succeeded — otherwise a handler that is always 10 ms too slow looks healthy forever.
- [ ] A handler that completes normally has no deadline overhead measurable against the existing
      ingest timing test.
- [ ] A deadline exceeded emits its event once, naming the handler file and the event type.
- [ ] Boot refuses a configuration whose worst case (deadline × registered handlers) exceeds the
      ingest budget, naming both numbers.
- [ ] The existing handler tests for 010, 020 and 027's handlers pass unchanged — this must be
      invisible to a well-behaved handler.
- [ ] **005 is reopened with a dated section** for the `ingest.ts` wiring, and that section's own
      criterion (dispatch calls `withDeadline`) is checked before this ticket closes.

## Open questions

- [ ] **Should handlers receive an `AbortSignal`?** It is the honest fix: a handler holding a
      transaction should learn its deadline passed and roll back, rather than finishing work nobody
      is waiting for and writing it. It changes the `EventHandler` interface, which means every
      handler file across 010, 020 and 027, so it is a separate ticket if wanted. Flagged because
      "abandon" leaves a handler able to commit after dispatch gave up on it, and under 034's
      transaction semantics that write is real.
- [ ] What should a *blocking* hook be told when the handler that decides its answer was abandoned?
      Today's dispatch has no notion of a handler whose result the response depends on, and 020's
      guard answers in its own route rather than a handler, so nothing is broken. It would be if a
      future blocking hook were answered from a handler. Noting the shape so nobody builds that
      without seeing this.
- [ ] Is a deadline the right tool for the saturated-lane case, or does that want the lane refusal
      from 036 instead? Probably both, at different layers — but if 036 lands first, one of these
      tests may become redundant.
