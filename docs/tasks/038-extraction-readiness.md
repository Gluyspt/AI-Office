---
id: "038"
title: "Extraction readiness: the service graph and its test"
build_step: boundaries
department: dev
estimated_model: opus
blocked_by: ["033", "034"]
---

# 038 — Extraction readiness: the service graph and its test

**Build step:** boundaries
**Department:** dev
**Estimated model:** opus — it is the ticket that decides whether "independent deploy" stays true a year from now, and the judgement is in what it refuses rather than what it builds.
**Blocked by:** 033, 034

## Why

This is the independent-deploy driver, and it is the only honest way to have it in one process.

One process is one deploy. The design says so plainly (§2 of the boundaries design): contracts give
agent-parallel ownership in full, in-process isolation gives fault isolation for everything but a
crash, and independent deploy gets **nothing** until a service runs on its own. What this ticket buys
is that the *second* split costs a day rather than a quarter — that extraction stays a scheduling
decision instead of becoming a rewrite, which is what happens when a boundary is documented and not
measured.

The failure it prevents is specific and slow. 033 stops a *deep import*. It does not stop a contract
from growing a method that takes a Fastify instance, or returns a live pool client, or depends on
the caller sharing its process memory. Six months of those and every boundary is still formally
intact while nothing can be moved. Nobody notices, because nothing fails — right up to the day
somebody tries.

## Scope

### Files created

- `tests/boundaries/extractable.test.ts` — for each service: its contract's surface is serialisable, its declared dependencies are reachable over RPC, and it shares no module-level mutable state with another service
- `tests/boundaries/shared-state.ts` — the detector for the one thing a process split silently breaks: module-level state two services both read or write
- `scripts/service-graph.mjs` — prints the service graph (nodes, edges, grants, lanes, crossings, extractability verdict per service) as a table and as Mermaid, for the design doc and for review
- `docs/service-graph.md` — the generated graph, committed, so a diff shows a boundary change as a boundary change rather than as a line in a test file

### Files modified

None.

## Decided

**Extractability is asserted per service, and a service may legitimately be unextractable** — as
long as it says so and says why. `control` is unextractable *by design* in the other direction: it
must stay on the host. `tasks` and `locks` are extractable only **together**, because `claim_task`
passes a transaction handle between them (034, and the single entry on 033's crossings list). So the
test asserts a declared verdict per service rather than a universal rule, and fails when reality and
the declaration disagree. A declaration that says "not extractable, because the transaction" is a
pass. Silence is not.

**Module-level mutable state is the thing worth detecting**, over anything else a split breaks. It is
invisible to a type checker, invisible to 033's import rule, and it is the one that produces the
worst debugging session: two services that agreed on a cache, a counter, a subscription list, now
each with their own copy and no error anywhere. `bus.ts`'s subscription map is the existing instance,
and it is correct precisely because `realtime` and `events` are both platform-adjacent and will not
be split — which is the kind of thing that must be written down rather than remembered.

**The graph is generated and committed.** A reviewer should see "chat now depends on control" as one
line in a diff of `docs/service-graph.md`. Keeping it only in a test means the change is invisible
until someone reads the test's baseline, which nobody does.

**No RPC is built here.** This ticket proves a service *could* be extracted; 040 extracts one and
builds the transport it needs. Building a general-purpose RPC layer for services that are all in one
process is the microservices tax this whole design exists to avoid paying twice.

## Acceptance criteria

- [ ] Every service has a declared extractability verdict with a reason, and the test fails on a
      service that has none.
- [ ] A contract method added with a non-serialisable parameter or return type fails the test, naming
      the service and the signature, unless the pair is on 033's crossings list.
- [ ] Module-level mutable state shared between two services fails, naming the module and both
      services. Asserted against a fixture, and against `bus.ts` as a known allowed case with its
      reason recorded.
- [ ] `tasks` and `locks` are declared extractable-together, citing their crossings entries, and the
      test fails if either is declared independently extractable while an entry exists.
- [ ] `control` is declared host-only, and the test fails if any service declares a dependency *on*
      `control` that is not serialisable — because that is the edge 040 has to cross for real.
- [ ] **`control`'s own two crossings are reported, not only dependencies *on* it.** `pause` and
      `resume` each hold one transaction spanning control + tasks + locks (design §3.1, rows 3 and
      4), so the graph must place `control` inside the transactional set until 028's split lands. A
      graph showing `control` as cleanly extractable while those entries exist is the exact wrong
      answer, and 040 is the ticket that would act on it.
- [ ] `platform/*` is asserted to import nothing from `features/`, with 039's exception removed by
      the time this closes.
- [ ] `scripts/service-graph.mjs` output is deterministic — same tree, same bytes — so the committed
      graph diffs cleanly.
- [ ] `docs/service-graph.md` is regenerated and matches the tree; the test fails if it is stale.
      (The same shape as a lockfile check: the generated artefact is part of the review, so it cannot
      be allowed to drift.)
- [ ] The graph reports, per service: contract surface size, dependencies, grant tables, lane, and
      verdict. 040 reads this to size its own work.

## Open questions

- [ ] **Does a stale committed graph fail the suite or just a pre-commit hook?** Failing the suite is
      stricter and will annoy somebody mid-refactor; a hook can be skipped. Leaning: fail the suite,
      because this repo's convention is that conventions are verifiable, and the regeneration is one
      command.
- [x] ~~What counts as serialisable at the boundary — JSON, or structured-clone?~~ **Answered
      2026-10-12: one shared serialiser, with a round-trip test over every contract type.** The
      transport is loopback HTTPS (040), so JSON is what the wire carries and a `Date` comes back a
      string unless something converts it. One converter rather than per-type codecs, because the
      failure being guarded against is *a field added later by someone who has not read this* — and
      only a test that enumerates every contract type catches that, in CI, rather than in front of
      an agent. This ticket's `extractable.test.ts` takes it as the definition of "serialisable";
      040 builds the converter it implies.
- [ ] Should the extractability verdict live in the contract file (near the code, splits cleanly) or
      in one declaration file (reviewable in one place, but a file every ticket edits)? Leaning the
      contract file, consistent with 033's dependency declarations and for the same reason.
