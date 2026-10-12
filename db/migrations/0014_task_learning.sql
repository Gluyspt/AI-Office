-- 0014_task_learning.sql
--
-- The learning entry `complete_task` requires (ticket 017).
--
-- The design is explicit that a completion without a learning entry is
-- refused, and equally explicit that the knowledge graph those entries
-- eventually live in is **build step 5**. This column is the interim home,
-- allocated to 017 because the instruction "store it on the task row for now"
-- pointed at a column that did not exist in 0005 or anything after it.
--
-- DELIBERATELY UNSTRUCTURED, UNINDEXED AND UNNORMALISED. The graph is where
-- this data acquires shape, relations and a source. Building a second
-- half-shaped store here would mean migrating out of two places at step 5
-- instead of one.
--
-- **The step-5 migration path is: read every non-null `tasks.learning`, write
-- it into the graph as a fact sourced to the task, then drop the column.**
-- Stated now so it is a known one-way door rather than an archaeology problem
-- later.
--
--
-- MIGRATION-ORDERING HAZARD (the fifth file in this directory to carry it)
-- -----------------------------------------------------------------------
-- This file is numbered 0014 but is added AFTER 0015_session_tokens.sql
-- already exists and has run. The runner applies *pending* migrations in
-- filename order, so on an existing database this file runs LAST despite its
-- number; on a fresh one it runs fourteenth. The runner warns when it spots
-- this (packages/server/src/core/db/migrate.ts, warnOnOutOfOrder) and that
-- warning is correct and expected here.
--
-- Both orders must therefore work. This file references only `tasks` (0005),
-- which exists in both.

alter table tasks
  add column learning text;

-- Not null-constrained: every task that already exists has no learning entry,
-- and a task is created long before it is completed. The requirement is
-- enforced where it belongs, at the point of completion — `complete_task`
-- refuses an empty or whitespace-only entry. A column constraint cannot
-- express "required on completion" without also forbidding a draft.
--
-- What IS enforced here: if a value is present, it is not blank. That stops
-- the one failure a check constraint can actually catch — a caller that
-- "satisfied" the requirement with a space.
alter table tasks
  add constraint tasks_learning_not_blank
  check (learning is null or length(trim(learning)) > 0);

comment on column tasks.learning is
  'Interim home for complete_task''s required learning entry (ticket 017). Step 5 reads these into the knowledge graph as facts sourced to the task and DROPS this column; see 0014_task_learning.sql.';
