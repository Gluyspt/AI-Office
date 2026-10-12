---
id: "033"
title: Service contracts and the boundary test
build_step: boundaries
department: dev
estimated_model: opus
blocked_by: []
---

# 033 — Service contracts and the boundary test

**Build step:** boundaries — cross-cutting, see [the boundaries design](../service-boundaries-design.md)
**Department:** dev
**Estimated model:** opus — the convention it establishes is load-bearing for seven other tickets, and the enforcement has to be right the first time or it gets switched off.
**Blocked by:** —

## Why

"Make everything microservices" was answered as **contracted modules in one process**, because on a
3.2 GB box agent sessions are the RAM budget and a process per feature costs about two desks. What
survives from the microservices idea is the part that was actually wanted: **an edit surface an
agent can own**.

Today there are 33 cross-feature import edges and no rule about them. Any file in `tasks` can import
any file in `locks`. That is fine for one human and fatal for an office: an agent that edits an
internal module six other features reach into produces a diff nobody declared a scope for, and the
ownership registry — which refuses by *declared file scope* — cannot see the collision coming.

This ticket writes the rule and makes it verifiable. It ships no behaviour change at all.

## Scope

### Files created

- `packages/server/src/platform/README.md` — what `platform/` means, the one-way rule (platform may be called by everyone and calls nobody), and why `events`, `das`, `mcp` and `identity` live there rather than under `features/`
- `tests/boundaries/contracts.test.ts` — the deep-import rule: a non-test file under `features/<a>/` may import from `features/<b>/` only via `features/<b>/contract.ts`
- `tests/boundaries/declared-deps.test.ts` — every cross-service import target appears in the importing service's declared dependency list, and every declared dependency is actually used (an unused declaration is a stale boundary, not a harmless one)
- `tests/boundaries/crossings.ts` — the **exception list**: the enumerated set of non-serialisable values allowed across a boundary, with the ticket that justifies each. Starts with **four** entries — see the inventory in §3.1 of the design
- `tests/boundaries/README.md` — how to add a contract, what the three failures mean, and the rule that the exception list may only shrink

### Files modified

None. No existing feature is retrofitted here — see the retrofit table in the design. The tests must
pass against the tree as it stands today, which means they are written to **allow** the current
edges and fail only on *new* violations; see "Decided".

## Decided

**`features/<name>/contract.ts`, a file, not a directory and not an `index.ts`.** A barrel that
re-exports a feature's modules makes the boundary a formality — the test would pass while every
internal remains reachable. One file also gives the ownership map one path per rule, which is what
lets a later ticket own a contract without owning the feature.

**The test allows today's edges explicitly, as a named baseline.** A boundary test that fails 33
times on the day it lands gets skipped, and a skipped test is worse than no test. So
`contracts.test.ts` carries a baseline list of the existing violations, asserts the set has not
*grown*, and the retrofit tickets delete entries from it. The baseline is the retrofit's progress
bar, and it is the one list in this repo that is allowed to shrink only.

**Platform is exempt from the contract rule, and bound by a stricter one.** `platform/*` may be
imported directly by anyone — requiring a contract to publish an event buys nothing. In exchange,
platform may import **nothing** from `features/`. That is a one-line test and it is what makes
`platform` extractable by construction. It also fails today, once, on
`mcp/protocol.ts → orchestrator/session-auth.ts` — which is the whole of ticket 039.

**A service's dependency declaration lives in its own contract file**, as an exported
`dependencies` array, not in a central registry. A registry would be a file every ticket edits,
which is the exact failure the autoload conventions exist to avoid.

## Acceptance criteria

- [ ] A new deep import (`features/a/x.ts` importing `features/b/internal.ts`) fails the suite, naming both files and the contract it should have used.
- [ ] An import of `features/b/contract.ts` from `features/a/` passes.
- [ ] The baseline list is asserted to be a *superset* check: removing a violation from the tree without removing it from the baseline also fails, so the baseline cannot silently stop matching reality.
- [ ] A `platform/` file importing from `features/` fails, with exactly one baselined exception (`mcp/protocol.ts`), and that exception names ticket 039.
- [ ] A declared dependency that is never imported fails.
- [ ] A cross-boundary function signature carrying a non-serialisable value (a `PoolClient`, a Fastify instance, a socket) fails unless the pair is on the crossings list.
- [ ] The crossings list has exactly **four** entries on landing, each citing its owning ticket: `claim_task` and `complete_task` (`tasks → locks`, 017), and `pause` and `resume` (`control → tasks, locks`, 028). Counting these rather than assuming `claim_task` was the only one is what answered the design's Q2 — a fifth appearing without a ticket is the failure this criterion exists to catch.
- [ ] The whole suite still passes unchanged otherwise — 828 passed, 1 skipped, plus the new files.
- [ ] `tests/boundaries/README.md` tells an agent what to do when each of the three tests fails, in the imperative, because the reader will usually be a model that just had its change refused.

## Open questions

- [ ] **Does `packages/web` get the same rule?** (design Q3) It already has the overlay and
      file-route conventions, so the cost is low and the benefit — two agents in two UI features —
      is the same. Deliberately not folded in here: this ticket's tests would need a second
      traversal root and a different notion of "service", and the server rule should prove itself
      first. Recommend a follow-up ticket.
- [ ] **How is the non-serialisable check implemented?** Type-level would be exact and needs the
      TypeScript compiler API; a syntactic check on contract signatures is cheap and catches the
      cases that exist. Starting syntactic. If it produces a false pass that costs a retrofit, it
      becomes a compiler-API check, and that is a bigger ticket than this one.
- [ ] Nothing here prevents a *runtime* boundary violation via dynamic `import()`. Out of scope and
      probably not worth solving: no code in this repo does it, and 035's Postgres roles close the
      only crossing that would actually be dangerous.
