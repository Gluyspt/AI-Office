---
id: "041"
title: Contract boundaries in the web app
build_step: boundaries
department: dev
estimated_model: sonnet
blocked_by: ["033"]
---

# 041 — Contract boundaries in the web app

**Build step:** boundaries
**Department:** dev
**Estimated model:** sonnet — 033 has already made every hard decision; this applies the same rule to a second tree, where the conventions it needs already exist.
**Blocked by:** 033

## Why

Decided 2026-10-12, answering Q3 of [the boundaries design](../service-boundaries-design.md): the
web app gets the same contract rule as the server.

The reason is the driver that started all of this. Agent-parallel ownership is worth as much in the
UI as on the server — more, soon, because **the UI is the half that is mostly unbuilt**. Four of the
ten step-3 tickets are still open (025, 027, 029, 031) and every later step adds pages: the Office
tab, Knowledge, Usage, Progress. That is where several agents will be working at once, and where a
shared edit surface would collide.

It is also nearly free here, because `packages/web` already has the two conventions the rule needs:
overlays collected by `import.meta.glob` from `src/features/*/overlay.tsx`, and file-based routes
in `src/routes/`. Features are already folders; what is missing is a statement of what inside one is
private.

**Not folded into 033** deliberately: 033's tests need a second traversal root and a different
notion of "service" (a UI feature has no grant, no lane and no transaction), and 033 is the ticket
currently blocking everything else in the set.

## Scope

### Files created

- `tests/boundaries/web-contracts.test.ts` — the deep-import rule for `packages/web/src/features/*/`, with its own baseline of today's edges
- `packages/web/src/features/README.md` — what a UI feature's contract is, and the three things that are *not* private (the overlay, the route, the contract)

### Files modified

None. Each feature's own `contract.ts` is added by the ticket that owns that feature, as a dated
section — the same shape as the server-side retrofit in §7 of the design.

## Decided

**A UI feature's contract is its components plus its hooks' return types — not its state.** The
server's rule is about who may call whom; the UI's equivalent failure is a component reaching into
another feature's hook or store and coupling to its internals. So `board/contract.ts` publishes
`TaskCard` and what `useBoard()` returns; it does not publish the query client, the reducer, or the
css module.

**Three things stay public by convention, not by contract.** `overlay.tsx` is read by the shell's
`import.meta.glob`, a route file is read by the router, and `contract.ts` is read by other features.
Everything else in `src/features/<name>/` is private. The test knows those three names, which is why
it is a separate test from the server's rather than the same one parameterised.

**The web app imports server types from contracts, not from `@office/shared`** — once Q4's rule
lands. `shared` keeps `ids.ts` and the pure helpers; a `TaskRecord` comes from `tasks`' contract.
This is the single largest import change in the retrofit and it is why 041 is sequenced after 033
rather than beside it: the server-side contracts have to exist first.

~~**No baseline-shrinking criterion here.** ... Landing with a non-empty baseline is the expected
outcome, not a failure.~~ **Wrong, and the opposite is true** — see "Decided during implementation".
The web baseline landed **empty**, because the app had zero cross-feature imports. There is nothing
for the step-3 tickets to delete, and a first entry appearing would be a regression rather than the
expected outcome.

## Acceptance criteria

- [x] A deep import between two web features fails the suite, naming both files and the contract it should have used. **Verified against the real tree**, not only a fixture: a planted probe importing another feature's CSS failed with the regression message, then was removed.
- [x] An import of `features/b/contract.ts` from `features/a/` passes.
- [x] `overlay.tsx` remains importable by the shell, and a route file by the router, with no contract — asserted, because a rule that broke either convention would be reverted within a day.
- [~] The web baseline is asserted both ways. **Only one direction is meaningful:** the baseline is *empty*, so there is no entry that could go stale. The growth check is asserted; a staleness check over an empty list would be a test of nothing. If an entry is ever added deliberately, add the staleness half with it.
- [x] A feature importing another feature's `.css` fails, and a feature importing its *own* css passes — which every one of them does.
- [x] `packages/web` typechecks and its existing tests pass unchanged. (`tests/ui/` does not exist yet — it belongs to ticket 030, which has not landed; the UI tests live in `packages/web/src/**/*.test.tsx` today. The ticket named a path that was still planned.)
- [x] `packages/web/src/features/README.md` names the three public files and says what to do when the test refuses a change, in the imperative.

## Decided during implementation, 2026-10-13

**The web app was already compliant: zero cross-feature imports.** `board` and `chat` import only
from `lib/`, and `lib/` imports no feature. So there is no baseline to shrink and nothing to
retrofit — the rule is purely **preventive**, locking in a property that holds today by luck, before
there are six features instead of two. That changes the character of the ticket rather than its
value: a violation here is a *regression*, not debt, and the failure message says so. Unlike the
server baseline, which shrinks, `WEB_BASELINE` should never gain a first entry.

**No change to `scan.ts` was needed.** 033 built `crossFeatureEdges({ featuresDir })` and
`platformEdges({ featuresDir, platformDir })` with overrides so its own tests could point at a
scratch tree — and those overrides express the web rule exactly, with `lib/` in the platform
position. A convention added for testability paid for itself as reuse, which is worth noting because
the ticket had assumed a "second traversal root" would be real work.

**`lib/` is the UI's platform, answered by the dependency direction rather than by preference.**
That was this ticket's first open question. `api.ts`, `ws.ts`, `overlays.tsx` and `SystemStatus.tsx`
are imported by everything and own no feature, and nothing in `lib/` imports a feature today — so
the one-way rule already holds and the test simply pins it.

**The CSS rule earns its place.** Verified against the real tree: a planted
`board/__probe.ts` importing `../chat/chat.css` fails with the regression message. Every feature
today imports only its own stylesheet, so the rule costs nothing and catches the coupling nothing
else would — no type check sees it, nothing fails at runtime, and the cascade surfaces the damage as
a visual bug somewhere else entirely.

## Open questions

- [x] ~~**Do `src/lib/` modules count as platform?**~~ **Yes — answered 2026-10-13 by the tree, not by preference.** Nothing in `lib/` imports a feature today, so the one-way rule already holds and the test pins it. No change to 022's files was needed, so its intent is unaffected.
- [ ] Does a *page* (`src/routes/*.tsx`) get to import feature internals? It is the composition
      point, so a strict rule makes every page need a contract for everything it renders. *Leaning:*
      routes obey the same rule, because the alternative makes a route the place coupling hides.
- [ ] Whether the UI needs an extractability notion at all (038's server-side equivalent). Probably
      not — the web app is one bundle and there is no second process to extract into. Recorded so
      nobody adds one by symmetry.
