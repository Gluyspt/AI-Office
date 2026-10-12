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

**No baseline-shrinking criterion here.** 033 owns the rule that baselines only shrink; this ticket
establishes the web baseline and the step-3 tickets delete from it as each feature publishes a
contract. Landing with a non-empty baseline is the expected outcome, not a failure.

## Acceptance criteria

- [ ] A deep import between two web features fails the suite, naming both files and the contract it should have used.
- [ ] An import of `features/b/contract.ts` from `features/a/` passes.
- [ ] `overlay.tsx` remains importable by the shell, and a route file by the router, with no contract — asserted, because a rule that broke either convention would be reverted within a day.
- [ ] The web baseline is asserted both ways, as 033's is: a violation removed from the tree but left in the baseline also fails.
- [ ] A feature importing another feature's `.css` fails. Styles are the quietest coupling in a UI and the easiest to leave behind.
- [ ] `packages/web` typechecks and the existing UI tests (`tests/ui/`) pass unchanged.
- [ ] `packages/web/src/features/README.md` names the three public files and says what to do when the test refuses a change, in the imperative.

## Open questions

- [ ] **Do `src/lib/` modules count as platform?** `api.ts`, `ws.ts`, `overlays.tsx` and
      `SystemStatus.tsx` are imported by everything and own no feature — which is the server's
      `platform/` shape exactly. *Leaning:* yes, with the same one-way rule (lib may be imported by
      any feature; lib imports no feature). Worth confirming against 022's intent, since it owns
      those files.
- [ ] Does a *page* (`src/routes/*.tsx`) get to import feature internals? It is the composition
      point, so a strict rule makes every page need a contract for everything it renders. *Leaning:*
      routes obey the same rule, because the alternative makes a route the place coupling hides.
- [ ] Whether the UI needs an extractability notion at all (038's server-side equivalent). Probably
      not — the web app is one bundle and there is no second process to extract into. Recorded so
      nobody adds one by symmetry.
