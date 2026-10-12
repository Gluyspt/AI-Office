# packages/web/src/features

One folder per UI feature. **A feature's internals are private; `contract.ts` is how another
feature reaches it.**

Ticket 041. The reasoning is in [the boundaries design](../../../../docs/service-boundaries-design.md);
`tests/boundaries/web-contracts.test.ts` enforces it.

## Why here, when the server rule already exists

Agent-parallel ownership is worth more in the UI than on the server, because **the UI is the half
that is mostly unbuilt.** Four of the ten step-3 tickets are still open (025, 027, 029, 031) and
every later step adds pages — Office, Knowledge, Usage, Progress. That is where several agents will
be working at once.

**The app is already compliant, and that is the point.** When this landed there were **zero**
cross-feature imports: `board` and `chat` import only from `lib/`, and `lib/` imports no feature. So
there is no debt to retrofit here and no baseline to shrink — the rule is purely preventive, locking
in a property that currently holds by luck, before there are six features instead of two.

That is also why a violation in the web test says *regression*, not *debt*. The server baseline
exists because 33 violations already did. This one should never gain a first entry.

## Three files are public by convention, not by contract

| File | Read by | Why it is not private |
| --- | --- | --- |
| `overlay.tsx` | the app shell, via `import.meta.glob` (022) | The shell collects panels without an edit; that is the convention 022 established |
| a route file in `src/routes/` | the router | Same shape, for pages |
| `contract.ts` | other features | It is the public surface |

Everything else in `features/<name>/` — components, hooks, reducers, css — is private. The test
knows those three names, which is why it is a separate test from the server's rather than the same
one parameterised: a UI feature has no grant, no lane and no transaction, so most of the server's
machinery does not apply.

## What a contract publishes

**Components and what a hook returns — not state.** The server's rule is about who may call whom;
the UI's equivalent failure is a component reaching into another feature's hook or store and
coupling to its internals. So `board/contract.ts` publishes `TaskCard` and the shape `useBoard()`
returns; it does not publish the query client, the reducer, or a css module.

## CSS counts

A feature importing another feature's stylesheet fails the test. Styles are the quietest coupling in
a UI and the easiest to leave behind: nothing type-checks it, nothing fails at runtime, and the
cascade means the damage surfaces as a visual bug in a third place. Every feature today imports only
its own (`./board.css`, `./task-card.css`, `./chat.css`), so the rule costs nothing.

## `lib/` is the UI's platform

`api.ts`, `ws.ts`, `overlays.tsx` and `SystemStatus.tsx` are imported by everything and own no
feature — `platform/`'s shape exactly. The same one-way rule applies: **features import `lib/`,
`lib/` imports no feature.** That was 041's open question, and the answer came from the dependency
direction that already held rather than from preference.

## When the test refuses your change

**"New cross-feature imports in packages/web"** — you imported another feature's internals. Import
its `contract.ts`, or publish what you need on it (a dated section on the ticket that owns that
feature, per the reopening rule in [`docs/tasks/README.md`](../../../../docs/tasks/README.md)). Do
not add an entry to `WEB_BASELINE`.

**"lib is the UI's platform"** — something in `lib/` imported a feature. Invert it: pass the value
in, or move the thing you reached for into `lib/` if it genuinely belongs to everyone.

## Server types

Once the retrofit reaches them, a `TaskRecord` comes from `tasks`' contract rather than
`@office/shared`, which Q4 settled is for pure code and ids only. That is the single largest import
change still ahead for this package, and it is why 041 is sequenced after 033 rather than beside
it — the server-side contracts have to exist first.
