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

**Therefore `tasks` and `locks` are one deployment unit — permanently.** Settled 2026-10-12 by
counting the transactions instead of recalling them: there are **four** spanning two services, not
one. `claim_task` and `complete_task` span tasks + locks; `pause` and `resume` span *control* +
tasks + locks (`pause.ts:856`, `resume.ts:482`). Each protects the same class of failure — a task
and its file scope disagreeing about who owns what — and a saga would need a compensating action per
transaction, any of which can itself fail and produce exactly the state the transaction made
unreachable. The saga option is rejected, not deferred. Inventory and consequences in §3.1 of the
design; the `control` rows are a prerequisite on 040.

**`withTransaction`'s rollback must not swallow the original error.** Today's implementation does
`catch { await client.query("ROLLBACK"); throw error }` — if the `ROLLBACK` itself throws, the
rollback's error replaces the real one and the cause is lost. The DAS version rolls back inside its
own `try`, keeps the first error, and attaches the rollback failure as a cause. Found while reading
`pool.ts` for this ticket; it is not a reported bug and has probably never fired, but it fires
exactly when the database is in trouble, which is when the message matters most.

**A grant is declarative data, not a wrapper.** `grant()` returns a handle that carries the service
name and its table list; it does not re-implement `query`. That keeps 035 able to turn the same
declaration into a Postgres role without touching a call site.

### Decided during implementation, 2026-10-13

**033's platform rule was too loose, and this ticket is where it showed.** The rule read as "platform
may be imported by anyone", and `platform/README.md` said outright that no `contract.ts` was required
to use a platform module. That cannot hold for the DAS: importing `das/das.ts` hands the caller the
raw pool, which makes a grant advisory rather than enforced — the opposite of the point. The
exemption is narrower than it looked, and is now stated as a table in `platform/README.md`: platform
needs no *permission* and no declared dependency, but **a platform module's internals are private
too**. Landed as a dated section on 033 (`platformInternalEdges` in `scan.ts`, five tests), with one
deliberate hole: a module that has published no `contract.ts` yet is not policed, because several
arrive before their contract does and refusing those imports would block the retrofit at the one
point it must move incrementally.

**The `Tx` handle is not a `PoolClient`, and that is the leak fix.** A caller holding a `PoolClient`
can call `release()` on it — out from under the transaction that owns it — and the old
`withTransaction` passed one straight through to every caller including across the `tasks`/`locks`
boundary. `Tx` exposes `query` and the service name, nothing else, so releasing is the DAS's job on
every path. The pool-of-one test is what makes that claim checkable.

**`grant.ts` holds the rules, `das.ts` holds the state.** The ticket listed `grant.ts` without
saying what was in it; splitting it this way means the declaration rules — valid service name, valid
table name, one-service-one-grant — are a table of cases testable with no database, which is how
`locks/overlap.ts` and `locks/registry.ts` are already split, and for the same reason. A service
name is validated against what Postgres will accept unquoted, because 035 turns it into the role
`<service>_svc` and a name needing quotes works right up until the first hand-written
`SET LOCAL ROLE` forgets them.

**The shared DAS is built lazily.** `core/db/pool.ts` constructs its pool at module load, which is
why importing anything downstream of it opens a connection in tests that never wanted one.
`das()` builds on first call instead.

## Acceptance criteria

- [~] `das.query` and `das.tx` are behaviour-identical to today's `query` and `withTransaction`.
      **Asserted directly against a real database rather than by re-running 015's suite**: commit on
      return, rollback on throw, a database error surfacing with the transaction rolled back, and
      all-or-nothing across two tables. Re-running `locks/registry.test.ts` against a DAS handle is
      not possible without retrofitting `registry.ts`, which is 015's file and explicitly **not** in
      this ticket's scope — the criterion as written assumed the retrofit had already happened. It
      lands with 015's dated section.
- [x] `tx` commits on return and rolls back on throw.
- [x] **A refusal decided after a write still rolls back.** The 017 case, as its own test with the
      refusal thrown as a custom error class: the row written before the throw is gone.
- [x] A `ROLLBACK` that itself fails surfaces the *original* error, with the rollback failure as its
      `cause` — and **does not overwrite a cause the original error already had**, since 017's
      refusals carry their own causal detail.
- [x] A connection is released exactly once on every path — commit, body throw, failing `ROLLBACK`,
      failing `BEGIN`, and a failed statement in and out of a transaction. **Proved rather than
      assumed:** `client.release()` was removed for one run and every checkout after the first
      failed with `timeout exceeded when trying to connect`, which is the pool-of-one design working.
- [x] `das.grant("tasks", [...])` returns a handle whose declared tables are sorted and de-duplicated,
      ready for 035 to turn into `GRANT` statements.
- [x] Two grants issued for the same service name are the same grant, not two. A second call with a
      *different* table list is refused rather than merged — merging would make a service's real
      table list the union of whatever happened to be imported, stated in no file and checkable by
      no reviewer. A second call with `[]` returns the existing handle, which is how a second call
      site asks for it without restating the declaration.
- [x] The DAS reports per service: connections in use, queries, transactions, rollbacks, checkout
      wait and transaction duration. A service with a grant and no traffic is still reported, so
      "who is holding connections" is answerable before an incident rather than during one. Lanes
      are 036's; the per-service half is here.
- [x] Nothing under `features/` imports `platform/das/das.ts` — only `contract.ts`. **This needed a
      rule 033 did not have** — see "Decided".
- [ ] The ingest p95 budget re-measured with the DAS in the path. **Not done, and not yet
      meaningful:** nothing on the ingest path uses the DAS until 005 is retrofitted, so the number
      today would be the existing pool's. The measurement belongs to the first retrofit that puts
      the DAS on that path.

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
