---
id: "034"
title: "DAS: the data access service"
build_step: boundaries
department: dev
estimated_model: opus
blocked_by: ["033"]
---

# 034 — DAS: the data access service

**Build step:** boundaries
**Department:** dev
**Estimated model:** opus — it owns transaction scope for `claim_task`, and getting the handle shape wrong is a rewrite of 015 and 017 rather than a fix here.
**Blocked by:** 033

## Why

The data boundary was asked for as a **database access service**. This builds it.

`core/db/pool.ts` is 40 lines that export a pool, a `query` and a `withTransaction`, and **17
feature files import it directly**. Every feature therefore has unrestricted reach over every table,
one global `statement_timeout`, and one undifferentiated pool. Three consequences, all real:

1. **No data boundary.** `chat` can read `file_locks`; nothing says it shouldn't, and nothing would
   notice. On the day a service moves to its own process, that reach becomes a silent cross-service
   read that no contract describes.
2. **No fault isolation.** One pool means one feature can hold every connection while the
   PreToolUse guard — a live agent, mid-tool-call — waits for one. Fixed in 036, but only once
   something owns the pool.
3. **Nothing to point at.** Independent deploy needs a service to already hold its own connection,
   its own credential and its own grant. 035 can give it those only if there is a layer to put them
   in.

## Scope

### Files created

- `packages/server/src/platform/das/contract.ts` — `DataAccess`, `Tx`, `Grant`, the error types, and the `dependencies` export 033's test reads
- `packages/server/src/platform/das/das.ts` — the implementation: pool construction from `loadDatabaseConfig()`, checkout, `query`, `tx`, release, and the metrics counters
- `packages/server/src/platform/das/grant.ts` — `das.grant(service, tables)`: the per-service handle, and the table list it carries into 035
- `packages/server/src/platform/das/das.test.ts`
- `packages/server/src/platform/das/grant.test.ts`
- `packages/server/src/platform/das/tx.test.ts` — the transaction-semantics table, including the three cases below

### Files modified

None. `core/db/pool.ts` keeps working untouched, and keeps its 17 callers, until each feature is
retrofitted under 035. Its deletion is a dated section on **004**, not this ticket — see the retrofit
table in the design.

## Decided

**The DAS owns access. Features own their SQL.** The alternative — a DAS holding every feature's
queries — was considered and rejected for a reason specific to this product rather than a general
one: it would be a single file every ticket and every agent edits, in a system whose coordination
model is "declare your file scope and overlapping work is refused". The ownership registry would
refuse constantly and the office would serialise. The data boundary has to be a boundary, not a
bottleneck. Reasoned out in §5.1 of the design.

**`tx` is the only thing allowed to cross a service boundary, and it is on 033's crossings list.**
`claimTask` hands one `PoolClient` to `locks`' `acquireScope`, `tasks`' `isClaimable` and
`transition`, inside one transaction, and 017's header explains what breaks without it: a claim that
fails at lock acquisition leaves a task `in_progress` that no agent is working on and no query can
find. So the DAS exposes `tx(run)` yielding a handle that is explicitly passable, and the boundary
test records the one pair that passes it.

**Therefore `tasks` and `locks` are one deployment unit**, and the design says so out loud (§3,
footnote 1) rather than letting a future split discover it. They get separate contracts and separate
grants; they do not get separate processes until a claim becomes a saga.

**`withTransaction`'s rollback must not swallow the original error.** Today's implementation does
`catch { await client.query("ROLLBACK"); throw error }` — if the `ROLLBACK` itself throws, the
rollback's error replaces the real one and the cause is lost. The DAS version rolls back inside its
own `try`, keeps the first error, and attaches the rollback failure as a cause. Found while reading
`pool.ts` for this ticket; it is not a reported bug and has probably never fired, but it fires
exactly when the database is in trouble, which is when the message matters most.

**A grant is declarative data, not a wrapper.** `grant()` returns a handle that carries the service
name and its table list; it does not re-implement `query`. That keeps 035 able to turn the same
declaration into a Postgres role without touching a call site.

## Acceptance criteria

- [ ] `das.query` and `das.tx` are behaviour-identical to today's `query` and `withTransaction` for
      every case the existing suite covers, asserted by running `locks/registry.test.ts`'s
      concurrency cases against a DAS-backed handle.
- [ ] `tx` commits on return and rolls back on throw.
- [ ] **A refusal decided after a write still rolls back.** The 017 case: acquire a scope, then throw
      a refusal; assert no lock rows survive. This is the bug `ClaimRefused` exists to prevent and
      the DAS must not make it re-appear.
- [ ] A `ROLLBACK` that itself fails surfaces the *original* error, with the rollback failure as its
      `cause`.
- [ ] A connection is released exactly once on every path — commit, throw, and rollback-failure —
      asserted by a pool whose `max` is 1, which deadlocks on a leak rather than passing quietly.
- [ ] `das.grant("tasks", [...])` returns a handle whose declared tables are readable by 035 and by
      033's test.
- [ ] Two grants issued for the same service name are the same grant, not two.
- [ ] The DAS reports, per lane and per service: connections in use, checkout wait time, and
      transaction duration. 036 needs these to prove the reserved lane works, and `events/ingest`'s
      50 ms p95 needs them to stay attributable.
- [ ] Nothing under `features/` imports `platform/das/das.ts` — only `contract.ts`. Asserted by 033.
- [ ] The ingest p95 budget is re-measured on the dev box with the DAS in the path and recorded in
      the ticket. A regression here is a blocker, not a note.

## Open questions

- [ ] **Does the DAS own migrations too?** `core/db/migrate.ts` has its own connection and is run by
      `pnpm migrate`, not by the server. 035 forces the question because a migrator needs `CREATE`
      and a service role must not have it. Leaning: migrations stay outside the DAS and get their own
      credential (Q1 in the design), because a layer that enforces grants should not also be the
      thing that can grant.
- [ ] **Statement timeout per grant, or per lane?** Per-lane is simpler and is what 036 needs. Per-grant
      would let `planning`'s long batch validation have a longer budget than a board read in the same
      lane. Not decided; 036 should decide it, since it owns the lane shape.
- [ ] Retry policy is deliberately absent. A retry on a serialisation failure is correct for a read
      and dangerous for a `claim_task` whose refusal is already a legitimate outcome. Leaving retries
      to the caller until a real case names the right policy.
