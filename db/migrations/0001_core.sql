-- 0001_core.sql
--
-- Bootstraps the orchestrator database: the migration ledger, and the first
-- project-scoped table. schema_migrations is created here (by the migration
-- itself, not by the runner) — see db/migrate.ts's appliedMigrations(),
-- which treats "schema_migrations doesn't exist yet" as "nothing has run".
--
-- gen_random_uuid() is a PostgreSQL 13+ built-in (no pgcrypto extension
-- needed); this repo's local dev Postgres is version 16
-- (docker-compose.dev.yml).
create table if not exists schema_migrations (
  filename text primary key,
  applied_at timestamptz not null default now()
);

-- One database, project_id column on every project-scoped table — see this
-- ticket's open questions in docs/tasks/004-server-package-and-db-bootstrap.md
-- for the isolation-strength assumption this rests on. `projects` is the
-- table those project_id columns will reference.
create table projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  repo_url text not null,
  status text not null default 'active',
  created_at timestamptz not null default now()
);
