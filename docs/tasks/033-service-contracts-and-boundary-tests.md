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
- `tests/boundaries/contracts.test.ts` — the deep-import rule: a non-test file under `features/<a>/` may import from `features/<b>/` only via `features/<b>/contract.ts`. Also holds the platform rule and the crossings rule, both being rules *about contracts*
- `tests/boundaries/declared-deps.test.ts` — every cross-service import target appears in the importing service's declared dependency list, and every declared dependency is actually used (an unused declaration is a stale boundary, not a harmless one)
- `tests/boundaries/crossings.ts` — the **exception list**: the enumerated set of non-serialisable values allowed across a boundary, with the ticket that justifies each. Starts with **four** entries — see the inventory in §3.1 of the design
- `tests/boundaries/README.md` — what each failure means and what to do about it, in the imperative

**Four files added during implementation, 2026-10-12**, each because the ticket as written could not
be built without it:

- `tests/boundaries/scan.ts` — the import scanner. Three rules need the same answer to "which file
  imports which, and does it cross a boundary", and a regex copied into each would drift. It also
  holds the one non-obvious behaviour: **comments are stripped before matching**, because `claim.ts`
  and `app.ts` both quote `from "..."` inside prose and a naive scan would fill the baseline with
  phantom edges nobody could ever delete.
- `tests/boundaries/baseline.ts` — the 33 entries, in their own file **and not inside
  `contracts.test.ts`**. This is an ownership fix, not a preference: every retrofit deletes entries,
  so a baseline living in a test file would make every retrofit ticket edit 033's file. See the new
  shrink-only exception in `docs/tasks/README.md`.
- `tests/boundaries/package.json` — `tests/` did not exist. Vitest's `projects: ["packages/*", "tests/*"]`
  glob registers a directory by its `package.json`, as the three existing packages do; without one,
  the suite is silently not collected.
- `tests/boundaries/tsconfig.json` — `noEmit: true` plus `allowImportingTsExtensions`, mirroring
  `packages/server/tsconfig.json`. The base config has `noEmit: false`, under which every `.ts`
  import in this directory is a `TS5097` error.

### Files modified

- `pnpm-workspace.yaml` — adds `tests/*`. **This is 001's file, so it is a dated section on 001**,
  per the reopening rule. Found by the typecheck: `tests/boundaries` was outside the workspace, so
  `pnpm -r --if-present run typecheck` skipped it entirely and it could not declare `@types/node`.
  Tickets 011, 021 and 030 each add a `tests/*` suite and would all have hit this.

No existing feature is retrofitted here — see the retrofit table in the design. The tests pass
against the tree as it stands, which means they **allow** the current edges and fail only on *new*
violations; see "Decided".

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
`platform` extractable by construction.

**Correction, 2026-10-12:** this ticket originally claimed the platform rule "fails today exactly
once, on `mcp/protocol.ts → orchestrator/session-auth.ts`". **It does not, and the distinction
matters.** `mcp` still lives at `features/mcp/`, so that import is an ordinary baselined
cross-feature edge, not a platform violation — the platform baseline is **empty**, and `platform/`
contains one README. The rule becomes load-bearing the moment 039 moves identity and mcp into
`platform/`. The test asserts the empty state and a test named for the distinction records why, so
the next reader does not re-derive it.

**A service's dependency declaration lives in its own contract file**, as an exported
`dependencies` array, not in a central registry. A registry would be a file every ticket edits,
which is the exact failure the autoload conventions exist to avoid.

## Acceptance criteria

- [x] A new deep import (`features/a/x.ts` importing `features/b/internal.ts`) fails the suite, naming both files and the contract it should have used. **Verified against the real tree, not only a fixture:** a probe file importing `tasks/repo.ts` from `realtime/` was added, the suite failed naming it and telling the reader not to add a baseline entry, and the probe was removed.
- [x] An import of `features/b/contract.ts` from `features/a/` passes.
- [x] The baseline is asserted in both directions: a violation removed from the tree but left in the baseline also fails. **Verified** by appending a fake entry — two independent tests caught it, the staleness check and the shrink-only count (34 > 33).
- [x] ~~A `platform/` file importing from `features/` fails, with exactly one baselined exception (`mcp/protocol.ts`).~~ **The premise was wrong — see the correction under "Decided".** Replaced by: the platform rule fails on a fixture violation, passes a platform-to-platform import, and the real-tree platform baseline is **empty**, with a named test recording that `mcp` is not a platform violation until 039 moves it.
- [x] A declared dependency that is never imported fails.
- [x] A cross-boundary function signature carrying a non-serialisable value (a `PoolClient`, a Fastify instance, a socket) fails unless the pair is on the crossings list.
- [x] The crossings list has exactly **four** entries on landing, each citing its owning ticket: `claim_task` and `complete_task` (`tasks → locks`, 017), and `pause` and `resume` (`control → tasks, locks`, 028). Counting these rather than assuming `claim_task` was the only one is what answered the design's Q2 — a fifth appearing without a ticket is the failure this criterion exists to catch.
- [x] The whole suite still passes unchanged otherwise — **855 passed, 1 skipped, 43 files**, from 828 / 1 / 41. The delta is exactly the 27 new tests in 2 new files; nothing else moved. Typecheck clean on all four workspace projects.
- [x] `tests/boundaries/README.md` tells an agent what to do when each failure happens, in the imperative, because the reader will usually be a model that just had its change refused.
- [x] **The scanner has its own tests**, added because every rule trusts it: that it does not invent an import from a comment quoting a path (the real hazard), that it keeps string literals resembling comments, and that it finds type-only, side-effect, re-export and dynamic imports.
- [x] **Every rule is tested twice — against the real tree and against a scratch fixture.** Three of the rules currently have nothing to find in the real tree, so without the fixtures this directory would be green in a way that proved nothing. Mirrors `buildApp({ featuresDir })` and `loadHandlers(dir)`, which take the same kind of override for the same reason.

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
