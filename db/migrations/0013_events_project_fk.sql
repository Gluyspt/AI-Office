-- 0013_events_project_fk.sql
--
-- Bug fix. `events.project_id` was declared in 0002_events.sql as
--
--     project_id uuid references projects (id)
--
-- with no delete behaviour, which defaults to NO ACTION: once any event
-- referenced a project, that project could never be deleted.
--
-- That was invisible for as long as the column was always NULL - 0002's own
-- comment says "always NULL until a later ticket back-fills it", and nothing
-- set it until events constructed by this process (TaskCreated,
-- TasksUnblocked, FileLocksSwept) started carrying their project so ticket
-- 006's bus could filter subscriptions on it. The first delete of a project
-- with events then failed with
--
--     update or delete on table "projects" violates foreign key constraint
--     "events_project_id_fkey" on table "events"
--
-- CASCADE, not SET NULL, for consistency with every other child of
-- `projects`: tasks (0005), task_dependencies (0006) and file_locks (0007)
-- all cascade. An orphaned event whose project is gone is not a useful
-- audit record - it cannot be shown on any board and cannot be filtered to
-- one - and keeping it would leave `project_id` meaning two different
-- things depending on whether the project still exists.
--
-- Long-term retention is explicitly not this table's job: the design backs
-- the orchestrator database up to a separate private repo on a nightly
-- cron, which is where history outlives a deleted project.
--
--
-- NUMBERING: why 0013 and not 0008
-- ---------------------------------
-- 0008 through 0012 are already claimed in the file ownership map by
-- tickets that have not been written yet (018 spawn_queue, 019 batches,
-- 020 unguarded_edits, 028 pause, 032 gate_bypass). Taking one of those
-- numbers would collide with a ticket's declared file scope. 0013 is the
-- first free number, and ordering is unaffected: this file only alters a
-- constraint on a table 0002 already created.

alter table events
  drop constraint events_project_id_fkey;

alter table events
  add constraint events_project_id_fkey
  foreign key (project_id) references projects (id) on delete cascade;
