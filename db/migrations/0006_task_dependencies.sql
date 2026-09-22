-- 0006_task_dependencies.sql
--
-- The dependency graph (ticket 014). "Without this, Management cannot
-- express 'build the API before the UI that consumes it,' and agents start
-- work that can't finish."
--
--
-- MIGRATION-ORDERING NOTE — this file is numbered BELOW one that already ran
-- ---------------------------------------------------------------------------
-- 0007_file_locks.sql (ticket 015) shipped before this file existed, so on
-- every database that has already run 0007, this migration is applied
-- *after* it. The runner applies *pending* files in filename order, which
-- equals application order only on a database that starts empty — the
-- hazard 0005_tasks.sql documented, now actually materialising.
--
-- It is safe here for the same reason it was safe there: this file
-- references only `tasks` (0005) and `projects` (0001), both of which are
-- lower-numbered and already applied wherever this runs. It takes no
-- reference to file_locks, and nothing in 0007 references this table.
--
-- The general rule this repo now follows twice over: a migration must not
-- depend on any table a lower-numbered, not-yet-written migration will
-- create.

create table task_dependencies (
  id uuid primary key default gen_random_uuid(),

  -- The dependent: the task that must wait.
  task_id uuid not null references tasks (id) on delete cascade,

  -- The blocker: the task that must reach `delivered` first.
  --
  -- `delivered`, not `done` - the squash-merge into main-dev is the moment
  -- the code a dependent needs actually exists, and waiting for a human to
  -- accept the delivery report would stall every chain at a human gate.
  -- See the decision in docs/tasks/README.md.
  blocked_by_task_id uuid not null references tasks (id) on delete cascade,

  created_at timestamptz not null default now(),

  -- A task cannot block itself. Cycles of length > 1 cannot be expressed as
  -- a check constraint and are refused in
  -- packages/server/src/features/tasks/dependencies.ts, which walks the
  -- graph before inserting.
  constraint task_dependencies_no_self check (task_id <> blocked_by_task_id),

  -- One edge per pair. Adding the same dependency twice is a no-op, not a
  -- second row: "unblocking is idempotent" starts here, with the graph
  -- unable to hold a duplicate in the first place.
  constraint task_dependencies_unique unique (task_id, blocked_by_task_id)
);

-- Both directions are read constantly and by different questions:
--
--   forward  - "what blocks this task?" (claimability, the blocked banner)
--   backward - "what does this task block?" (unblockDependents on delivery)
--
-- The unique constraint above already indexes (task_id, blocked_by_task_id),
-- so only the reverse direction needs its own index.
create index task_dependencies_blocked_by_idx
  on task_dependencies (blocked_by_task_id);
