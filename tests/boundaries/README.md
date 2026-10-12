# tests/boundaries

If a test in here just refused your change, read the section for it and do what it says. You are
probably mid-task and these rules are not negotiable by the thing they refused.

Ticket 033 owns this directory. The reasoning behind every rule is in
[the boundaries design](../../docs/service-boundaries-design.md).

## "New cross-feature imports that bypass a contract"

You imported another feature's internal file. Do one of these:

1. **Import its contract instead** — `features/<that-feature>/contract.ts`. If what you need is
   already exported there, change your import path and you are done.
2. **Publish what you need on that contract**, then import it. This edits a file another ticket
   owns, so it is a dated section on that ticket, per the reopening rule in
   [`docs/tasks/README.md`](../../docs/tasks/README.md).

**Do not add an entry to `baseline.ts`.** That list only shrinks. It is the record of what was
already wrong when the rule landed, not a place to put new violations.

## "These baseline entries no longer match the tree"

You fixed a violation — good — and `baseline.ts` still lists it. Delete those lines. That is the
whole point of the list, and the only edit to that file anyone needs to make.

Deleting a baseline entry is outside any ticket's file scope, the mirror of the manifest exception.
Adding one is not.

## "Platform may be called by everyone and may call nobody"

A file under `packages/server/src/platform/` imported something from `features/`. Platform is
infrastructure — the event bus, the data layer, the RPC mounting, identity — and it is depended on
*by* services, never the other way round. Invert the dependency: pass the value in, or move the
thing you reached for into platform if it genuinely belongs to everyone.

## "A contract may only carry a non-serialisable type if crossings.ts says so"

Your contract's surface mentions something that means nothing outside this process — a `PoolClient`,
a Fastify instance, a socket. Contracts carry serialisable values so a service stays movable.

If the crossing is genuinely necessary, it needs an entry in [`crossings.ts`](crossings.ts) naming
the ticket that justifies it and one sentence on what breaks without it. There are four entries and
they are all database transactions. **That list only shrinks too.**

## "declares X but imports nothing from it"

Remove the stale declaration. An unused dependency is not harmless: ticket 038's service graph and
`docs/service-graph.md` keep reporting a coupling that is gone, and the first person to plan around
that map is planning around a system that does not exist.

## The files

| File | What |
| --- | --- |
| `scan.ts` | The import scanner all three rules share. Strips comments first — several headers in this repo quote `from "..."` inside prose |
| `baseline.ts` | The 33 cross-feature imports that existed when 033 landed. Shrink-only |
| `crossings.ts` | The four non-serialisable values allowed across a boundary, each with a ticket. Shrink-only |
| `contracts.test.ts` | The deep-import rule, the platform rule, the crossings rule, and the scanner's own tests |
| `declared-deps.test.ts` | Declarations match imports, in both directions |

## Running them

```sh
npx vitest run --project @office/boundaries-tests
```

They touch no database and no network — every rule is a walk over the file tree — so they run in a
couple of seconds and are safe to run in a loop while you work.

## What these rules do NOT police

**Test files.** `scan.ts` skips `*.test.ts`, deliberately: a test legitimately reaches across
boundaries to build its fixtures. `platform/identity/authenticate.test.ts` imports
`features/orchestrator/sessions.ts` to create a session row, and refusing that would mean
reimplementing session creation inside a platform test.

The cost is real and worth knowing: if `control` is ever extracted to its own process (040), a
platform test that imports it breaks. 038's extractability check is the place that would catch it,
because it reasons about what a service *needs*, not only about what imports what.

**Runtime violations via dynamic `import()` with a computed path.** No code here does it, and 035's
Postgres roles close the only crossing that would actually be dangerous.

## If you are changing these tests

Every rule is tested twice: against the real tree, and against a scratch fixture that proves the
rule can actually fail. Keep both. Three of these rules currently have nothing to find in the real
tree — there are no contracts yet, and `platform/` holds one README — so without the fixtures this
directory would be green in a way that proves nothing.

The same shape exists elsewhere in the repo for the same reason: `buildApp({ featuresDir })` and
`loadHandlers(dir)` both take an override so a test can point them at a scratch tree.
