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
- [ ] Running `pnpm migrate` a second time applies nothing and exits 0.
- [ ] A migration file that throws mid-way leaves the database unchanged and the migration unrecorded — test with a deliberately broken temporary file.
- [ ] The runner orders by filename, not by directory listing order — test with files `0002_b.sql` and `0010_a.sql` present and confirm `0002` runs first.
- [ ] `config.ts` exits non-zero with a message naming the missing variable when `DATABASE_URL` is absent.
- [ ] `withTransaction` rolls back on a thrown error, verified by a test that inserts a project then throws, and finds no row.
- [ ] Pool size and statement timeout come from config, not hardcoded values.

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

## Open questions

- [ ] The design says "the orchestrator's database" (singular) but also "one graph server per project". It does not say whether per-project data is isolated by schema, by a `project_id` column, or by separate databases. This ticket assumes **one database, `project_id` column on every project-scoped table**. If isolation needs to be stronger, it is cheaper to change now than after eight migrations.
- [ ] No retention policy is stated for any table. Relevant first to the event log in ticket 005.
