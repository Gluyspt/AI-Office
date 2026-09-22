-- 0007_file_locks.sql
--
-- The ownership registry (ticket 015). "Keep agents from creating git
-- conflicts, reliably" is one of the design's five goals; this is the table
-- behind it. Every task declares the files it touches, and overlapping
-- active tasks are refused.
--
--
-- MIGRATION-ORDERING HAZARD (why session_id has no foreign key)
-- -------------------------------------------------------------
-- The runner applies *pending* migrations in filename order, so filename
-- order equals application order only on a database that starts empty. On
-- any database where this file has already run, a later-added 0003 or 0004
-- is applied AFTER it. 0003_sessions.sql (ticket 008) does not exist yet,
-- so `session_id` is stored without a constraint and ticket 008 may add one
-- later. Same reasoning as 0005_tasks.sql's `owner`.
--
-- `tasks` (0005) and `projects` (0001) are both lower-numbered and already
-- applied wherever this runs, so those two references are safe.

create table file_locks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id) on delete cascade,

  -- The task that owns the scope. Cascade because a deleted task cannot
  -- still be holding files; the sweeper reports orphans for the case where
  -- a row survives its task by some other route.
  task_id uuid not null references tasks (id) on delete cascade,

  -- The session holding it, when one is known. NOT a foreign key - see the
  -- header. Null for a lock taken outside a session, e.g. a lead reserving
  -- scope during planning before any agent is spawned.
  session_id uuid,

  -- Already normalised to repo-relative POSIX form by
  -- packages/server/src/features/locks/overlap.ts. Storing a raw spelling
  -- here would defeat the registry: `./src/a.ts` and `src/a.ts` are the
  -- same file and must be the same string by the time they reach this
  -- column.
  path_pattern text not null check (path_pattern <> ''),

  acquired_at timestamptz not null default now(),

  -- TTL backstop. The design is explicit that no single release path is
  -- reliable, so all three exist: normal release on completion,
  -- SessionEnd, and this. Ticket 003 measured SessionEnd firing on
  -- kill-session 8/8, so TTL stays a backstop rather than the primary path
  -- - but it is not decoration, and the value is required config with no
  -- default shipped (LOCK_TTL_SECONDS).
  expires_at timestamptz not null,

  -- A paused task still owns its files: the whole point of Pause is that
  -- the work resumes later on the same scope. Paused locks are therefore
  -- exempt from TTL expiry and are not reclaimable.
  paused boolean not null default false,

  -- Null while held. Releasing is idempotent, so a second release leaves
  -- the original timestamp alone rather than moving it.
  released_at timestamptz,

  constraint file_locks_expires_after_acquired check (expires_at > acquired_at)
);

-- Exactly one holder of a given pattern per project, among locks still
-- held. A partial unique index rather than a plain one: released rows are
-- history and many of them may share a pattern over time.
--
-- This covers the identical-pattern race on its own, without any
-- application logic. It does NOT cover overlapping-but-different patterns
-- (`src/` versus `src/a.ts`), which no index can express - the registry
-- serialises those with a per-project advisory lock. Both mechanisms are
-- deliberate: the index is the database-side guarantee, the advisory lock
-- extends it to the cases SQL cannot state.
create unique index file_locks_active_pattern_idx
  on file_locks (project_id, path_pattern)
  where released_at is null;

-- The registry's hot read: every lock still held in a project, which is
-- what a new acquisition is checked against.
create index file_locks_active_idx
  on file_locks (project_id, released_at)
  where released_at is null;

-- Release-on-completion and the claim path.
create index file_locks_task_idx on file_locks (task_id) where released_at is null;

-- The SessionEnd release path.
create index file_locks_session_idx on file_locks (session_id) where released_at is null;

-- The sweeper: held, unpaused, past its TTL.
create index file_locks_expiry_idx
  on file_locks (expires_at)
  where released_at is null and paused = false;
