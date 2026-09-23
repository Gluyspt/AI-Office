---
id: "004"
title: Server package scaffold and database bootstrap
build_step: 1
department: dev
estimated_model: sonnet
blocked_by: ["001"]
---

# 004 — Server package scaffold and database bootstrap

**Build step:** 1 — Spine
**Department:** dev
**Estimated model:** sonnet — a connection pool, a migration runner, and one small table.
**Blocked by:** 001

## Why

The design puts all shared state in services rather than files, with a single orchestrator database
behind everything. Eight later tickets add a migration file each, so the runner and its file
convention must land before any of them.

## Scope

### Files created

- `packages/server/package.json` — name `@office/server`
- `packages/server/tsconfig.json`
- `packages/server/src/core/config.ts` — env parsing with a typed schema; fails loudly at startup on a missing variable
- `packages/server/src/core/db/pool.ts` — `pg` pool, one exported `query` and one `withTransaction` helper
- `packages/server/src/core/db/migrate.ts` — runner: reads `db/migrations/*.sql` in filename order, applies unapplied ones in a transaction, records them
- `db/migrations/0001_core.sql` — `schema_migrations`, and `projects` (id, name, slug, repo_url, status, created_at)

### Files modified

None. (`package.json` dependency additions are covered by the manifest exception in 001.)

## Acceptance criteria

- [ ] `pnpm migrate` against an empty database creates `schema_migrations` and `projects`, and prints each migration it applied.
- [x] Running `pnpm migrate` a second time applies nothing and exits 0.
- [x] A migration file that throws mid-way leaves the database unchanged and the migration unrecorded — test with a deliberately broken temporary file.
- [x] The runner orders by filename, not by directory listing order — test with files `0002_b.sql` and `0010_a.sql` present and confirm `0002` runs first.
- [x] `config.ts` exits non-zero with a message naming the missing variable when `DATABASE_URL` is absent.
- [x] `withTransaction` rolls back on a thrown error, verified by a test that inserts a project then throws, and finds no row.
- [x] Pool size and statement timeout come from config, not hardcoded values.

## Decided

- **`config.ts` is append-only for later tickets.** This ticket owns the file, but it cannot validate
  environment variables for tickets that do not exist yet — and inventing a shape for another
  ticket's needs would be guessing. A later ticket may **append a self-contained
  `loadXConfig(env = process.env)`**; it may not edit an existing section, the shared readers, or
  `ConfigError`. Those stay here. Recorded in the manifest exception in `CLAUDE.md` and the ticket
  index.
- **Config is grouped into independently-validated sections, not one flat required object.** The
  migrator needs the database and must not fail because an unrelated TLS path is unset. This is also
  what makes the append-only rule safe: two tickets appending different sections cannot break each
  other's validation.

### Verification, 2026-09-23

**This ticket shipped with no test file for its own database layer.** Five of the criteria above
described behaviour nothing exercised — including "a file that throws leaves the database
unchanged and unrecorded", which is the runner's riskiest promise. `packages/server/src/core/db/
migrate.test.ts` now covers them: filename ordering with `9002_b` and `9010_a`, rollback on a
mid-file failure, earlier files surviving a later failure, the out-of-order warning,
`withTransaction` rolling back and committing, and `loadDatabaseConfig` refusing a missing
`DATABASE_URL` and a non-integer pool size.

**One criterion is still unticked and deliberately so:** "`pnpm migrate` against an *empty*
database creates `schema_migrations` and `projects`". Every test above runs against the shared dev
database, which is not empty, so the bootstrap path is exercised only by history. Closing it
honestly needs a scratch database created and dropped per run — worth doing, not done here.

## Open questions

- [x] **SETTLED 2026-09-23: one database, `project_id` on every project-scoped table.** Confirmed
      with a human, so it is a decision rather than the assumption it started as.

      The open question conflated two stores. "One graph server per project" is about the
      **knowledge graph**, which does not live in Postgres at all — it is a separate MCP server
      process per project (design, "Knowledge graph": *"one HTTP server per project"*). The
      per-project isolation that phrase describes already exists, in a different store. About its
      own relational data the design says **"the orchestrator's database", singular**.

      Three reasons the single database wins:

      - **Cross-project reads are specified, not hypothetical.** 018's spawn cap reads a *global*
        memory floor from `/proc/meminfo`; the Usage page (step 7), the Lobby's office cards
        (step 9) and step 12's multiple projects are all cross-project by definition. Each becomes
        a fan-out across N databases.
      - **The deletion story is already satisfied.** "Deleting an office never deletes the git
        repo" — it drops the task history and event log. That is `delete from projects where
        id = ...` plus cascades, verified end to end once `0013_events_project_fk.sql` gave
        `events` the `on delete cascade` it had been missing. `DROP DATABASE` buys no isolation
        that is not already there.
      - **The cost is symmetric in time.** Seven applied migrations and every query assume
        `project_id`. Reversing costs the same now as later — and now it buys nothing, because
        there is exactly one project.

      If blast radius ever becomes the concern, the cheaper answers are a schema per project in
      one Postgres, or row-level security: both keep one connection pool and one migration run.
      **Revisit only on a real multi-tenant requirement** — separate customers, separate
      backup/retention policies, or a compliance boundary — which would land at step 12.
- [ ] No retention policy is stated for any table. Relevant first to the event log in ticket 005.
