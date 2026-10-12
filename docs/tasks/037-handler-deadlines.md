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

~~**The default is derived from the ingest budget, not chosen freely.**~~ **WRONG, and corrected
during implementation 2026-10-13 — see below.** The reasoning confused a p95 with a worst case.

**An exceeded deadline is an event, not just a log line.** A handler that silently stops running is
how the chat panel or the board quietly stops updating; it needs to be visible in the same place as
every other degradation (020's banner, 029's control page) rather than in a log nobody reads. Once
is a warning, repeatedly is a broken handler, and `slow-handlers.ts` is what tells them apart.

## Decided during implementation, 2026-10-13

**The deadline is NOT derived from the ingest budget, and the criterion that said boot should refuse
a configuration whose worst case exceeds it was wrong.** The 50 ms figure is a **p95**; a deadline
is a **worst case**. Those are different statistics, and the check as specified would have refused
every configuration generous enough to be useful: a deadline high enough not to abandon healthy
handlers (seconds) multiplied by any handler count is always far above a 50 ms p95. Shipping that
check would have meant a server that refuses to start, or a deadline so short it abandons working
handlers constantly — the failure the ticket was written to prevent, introduced by its own
acceptance criterion.

What a deadline is actually for is turning *forever* into *two seconds*. It bounds the tail; it says
nothing about the p95. The honest link to the budget is **measurement, not arithmetic**:
`slow-handlers.ts` records per-handler durations and `overBudget(budgetMs)` names the handlers whose
mean completed run is eating the budget. That answers "which handler is pushing the p95", which is
the question the original criterion was reaching for.

**The reporter is injected, not imported — and the boundary rule is why.** `deadline.ts` is
platform, so it may import nothing from `features/`, which means it cannot reach
`features/events/ingest.ts` to record an event. That constraint produced a better shape than this
ticket described: the mechanism is pure and testable, and the caller that already owns event
emission supplies the reporter. 033's rule earned its keep here on its first real use.

**The exceeded-deadline event is emitted un-awaited, and never for its own type.**
`recordSystemEvent` runs the whole pipeline — persist, publish, dispatch — so awaiting it inside the
dispatch loop would put a database round trip on the hot path at the moment the hot path is already
late. And because it dispatches, a handler registered for `HandlerDeadlineExceeded` that itself hung
would emit another, and another: one level of nesting is useful, unbounded recursion on the ingest
path is a way to take the server down with a diagnostic.

**`handler-loader.ts` now attaches each handler's file** as `LoadedHandler.source`. A deadline that
expires has to name what hung, and "a handler for PreToolUse" is not actionable when three features
register for that type. `source` is attached by the loader rather than declared by the module, so
nothing a handler module writes changes, and `LoadedHandler` is structurally a superset of
`EventHandler` so every existing consumer still typechecks. The handler is wrapped by delegation
rather than spread, which costs nothing and cannot break a handler that uses `this`.

**A run is counted once.** `exceeded` and the `late-success` that follows are the same run, so
`late-*` outcomes must not increment `runs` again — otherwise one hung handler looks like two runs
and the exceeded rate halves, which is the number an operator would act on.

### Two things found by running it

**Node's ESM loader caches by URL, and a test that forgets this proves nothing.** The first version
of the end-to-end test wrote a hanging handler to the same path an existing test had already
imported, so the import was a cache hit and the planted handler never ran — the test failed in 30 ms
with the handler untouched. `handler-loader.ts`'s own header says this ("re-importing an
already-loaded handler file is a cache hit, not a re-execution"); the fix is one file per test. Had
the assertion been weaker, this would have passed while testing the wrong handler.

**The tests originally waited out the real 2 s default, and that tipped a different suite over.**
`packages/web`'s "renders 200 cards in under 200 ms" started failing — not from any code change, but
because four idle seconds of extra suite load pushed a timing assertion with no margin past its
budget. Fixed by setting `HANDLER_DEADLINE_MS=50` for the two tests and restoring it in `finally`,
which cut them from ~2100 ms to ~90 ms each **and** made them stronger: they now also prove the
config is read, where a hard-coded 2 s would have passed either way. Worth noting the pattern —
this repo now has three timing assertions with no stated margin (`guard-script`'s buffer cap,
`board`'s 200 cards, and the ingest p95 that `deploy/README.md` already flags).

## Acceptance criteria

- [x] A handler that never settles does not stall dispatch: the handlers after it still run, and the
      ingest POST still returns. **Asserted twice** — as a unit, against a promise that genuinely
      never settles rather than a long timer (a long timer would pass against an implementation that
      merely waited), and end to end through `ingestHookPayload` with a real planted handler file.
- [~] ~~The ingest POST for an event with a hung handler stays inside the 50 ms p95 budget.~~
      **Restated, because the original is impossible by construction:** a hung handler's POST is
      bounded by the *deadline*, not by the p95 — abandoning at 50 ms would mean abandoning healthy
      handlers. What is asserted is that the POST returns at all, bounded, where before it did not
      return; and that a healthy handler adds nothing measurable to 005's existing p95 test, which
      still passes.
- [x] An abandoned handler that later *throws* does not become an unhandled rejection and is
      attributed to the handler that was abandoned.
- [x] An abandoned handler that later *succeeds* is recorded as having exceeded its deadline, not as
      having succeeded.
- [x] A handler that completes normally has no deadline overhead measurable against the existing
      ingest timing test — all 25 of 005's tests pass unchanged, the p95 one included.
- [x] A deadline exceeded emits its event once, naming the handler **file** and the event type.
      Asserted on the event's payload, not just its type.
- [x] ~~Boot refuses a configuration whose worst case exceeds the ingest budget.~~ **Removed as
      wrong** — see "Decided during implementation". Replaced by `overBudget(budgetMs)`, which names
      the handlers whose measured mean run is eating the budget.
- [x] The existing handler tests for 010, 020 and 027's handlers pass unchanged — this is invisible
      to a well-behaved handler.
- [x] **005 reopened** with a dated section: the `dispatch` wiring, `LoadedHandler.source` in
      `handler-loader.ts`, the two end-to-end tests, and a `cleanupByType` helper (the deadline event
      has a null `session_id`, so the existing cleanup could not reach it — and a leftover row would
      make the next run of its own assertion pass against stale data in a suite that shares one
      database).
- [x] A timer is always cleared, including when the handler throws — otherwise a one-hour deadline
      keeps the event loop alive for an hour, which in a suite is a hang attributed to the wrong
      file.
- [x] A reporter that throws does not become the failure it was reporting.

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
