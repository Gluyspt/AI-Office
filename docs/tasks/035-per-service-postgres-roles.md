---
id: "035"
title: Per-service Postgres roles and grants
build_step: boundaries
department: dev
estimated_model: opus
blocked_by: ["034"]
---

# 035 — Per-service Postgres roles and grants

**Build step:** boundaries
**Department:** dev
**Estimated model:** opus — it changes who can read what in a live database, and the failure mode of getting it wrong is a service that cannot do its job at 3 a.m.
**Blocked by:** 034

## Why

034 makes a service *declare* the tables it touches. This makes the declaration true.

A CI check on declared tables is defeated by any dynamically built SQL, says nothing about a stray
`psql`, and — the part that matters for driver #3 — says nothing at all on the day a service runs in
its own process with its own connection string. A Postgres role says all three. One role per
service, real `GRANT`s, and the DAS issuing `SET LOCAL ROLE <service>_svc` on checkout, means the
**database** refuses a cross-boundary read.

This is also the cheapest piece of independent-deploy groundwork available: a service that already
has a role and a grant needs no data work at all when it moves out.

## Scope

### Files created

- `db/migrations/0016_service_roles.sql` — one `NOLOGIN` role per service (`tasks_svc`, `locks_svc`, `chat_svc`, `control_svc`, `realtime_svc`, `planning_svc`, `permissions_svc`, plus `platform_svc`), the table and sequence grants each needs, and the membership that lets the application role `SET ROLE` into them
- `packages/server/src/platform/das/role.ts` — the `SET LOCAL ROLE` on checkout, the mapping from grant to role, and the one place that decides what happens when a role is missing
- `packages/server/src/platform/das/role.test.ts`
- `tests/boundaries/grants.test.ts` — the CI half: every table named in a feature's SQL appears in its grant, and every granted table is actually used

### Files modified

- `.env.example` — appended (manifest exception): the migrator credential, see Q1
- `packages/server/src/core/config.ts` — appended `loadMigratorConfig()` (manifest exception)

Retrofitting the 17 pool call sites onto grants is **not** in this ticket's scope. Those files belong
to 013, 015, 017 and others, and each gets a dated section per the retrofit table. This ticket makes
the mechanism exist and proves it on one feature.

## Decided

**Roles are the enforcement; the CI check is the error message.** Both, not either. A role produces
`permission denied for table file_locks` at runtime; `grants.test.ts` produces "chat/conversations.ts
reads `file_locks`, which is not in chat's grant — add it to the grant or go through the locks
contract" at review time. The second is what an agent can act on; the first is what cannot be talked
around.

**`SET LOCAL ROLE`, not `SET ROLE`.** `LOCAL` is scoped to the transaction and reverts on commit or
rollback, so a pooled connection cannot leak one service's role into the next checkout. With plain
`SET ROLE` a crashed handler returns a connection still wearing someone else's identity, and the
next query succeeds against the wrong grant — the worst available failure shape, because it is
silent and intermittent. A non-transactional checkout gets an explicit `RESET ROLE` on release.

**Roles are `NOLOGIN`.** Nothing connects *as* a service role while everything is one process; the
application role is a member and assumes it. When 040 extracts `control`, `control_svc` gains
`LOGIN` and a password of its own, and nothing else about it changes. That is the whole point.

**A missing role is a startup failure, not a per-query failure.** The DAS verifies at boot that every
grant maps to a role it can actually assume, and refuses to start otherwise. The alternative is a
server that starts fine and fails the first time some rarely-used feature touches the database —
which, given `permissions` and `planning` do not exist yet, would mean a latent break shipping
unnoticed for weeks.

## Acceptance criteria

- [ ] Each service role can read and write exactly its granted tables, asserted by a test that
      attempts a cross-grant read and expects `42501` (`insufficient_privilege`).
- [ ] After a transaction that `SET LOCAL ROLE`s, the next checkout on the same physical connection
      runs as the application role, not the previous service. Asserted with pool `max: 1` so the
      same connection is guaranteed to be reused.
- [ ] A rolled-back transaction also reverts the role.
- [ ] A non-transactional `query` through a grant resets the role on release.
- [ ] `claim_task` still works end to end: `tasks_svc` and `locks_svc` inside **one** transaction,
      with one `SET LOCAL ROLE` per enclosing transaction and the cross-service write going through
      the locks contract. This is the criterion most likely to reveal the design is wrong; it runs
      against the real database, concurrently, as 015's tests do.
- [ ] Boot fails, loudly and by name, when a declared grant has no role, when a role exists but the
      application role is not a member, and when a granted table does not exist.
- [ ] `grants.test.ts` fails on a SQL string naming an ungranted table, and names the contract to use
      instead.
- [ ] One feature is actually retrofitted here as the proof — `realtime`, chosen because it is the
      smallest and nothing holds its transaction. Every other retrofit is a dated section elsewhere.
- [ ] `pnpm migrate` still works, with the migrator credential, and a service role **cannot** run a
      migration (asserted, not assumed).
- [ ] Ingest p95 re-measured with `SET LOCAL ROLE` in the checkout path. One extra statement on a
      loopback socket should be unmeasurable; if it is not, that is a finding and this criterion
      records the number.

## Open questions

- [ ] **Q1 from the design, and this ticket is where it bites: who runs migrations?** Service roles
      must not hold `CREATE`, so the migrator needs its own credential that the running server does
      not have. Leaning `office_migrator`, used only by `pnpm migrate`, provisioned by
      `deploy/host/provision-host.sh`. **This needs a human before the ticket starts** — it changes
      host provisioning and the deploy runbook, and `provision-host.sh` is unowned.
- [ ] Does `platform_svc` need a grant at all? `events/ingest` writes `events`, and identity writes
      `sessions.token_hash` — so platform is not read-only and cannot be exempt. But a platform role
      that can write the sessions table is close to a superset of several services. Possibly it
      should be two roles (`events_svc`, `identity_svc`) rather than one. Not decided; 039 may force
      it.
- [ ] Row-level security is deliberately out of scope. The design settled "one database, `project_id`
      on every project-scoped table" and explicitly deferred multi-tenancy; RLS per project would
      re-open that. Noting it only so a later reader knows it was considered and parked.
