-- 0010_unguarded_edits.sql
--
-- The record of what the PreToolUse ownership guard could NOT stop (ticket
-- 020), and the review flag the retroactive check raises on the tasks
-- involved.
--
-- The guard fails OPEN. An unreachable orchestrator must not freeze every
-- agent on the box, so the edit proceeds — and the guard script appends it to
-- an on-disk buffer, flushes that buffer on recovery, and the orchestrator
-- then works out retroactively whether anything was actually violated. These
-- tables are the "afterwards, the damage is enumerated rather than guessed
-- at" half of that decision.
--
--
-- MIGRATION-ORDERING HAZARD (the fourth file in this directory to carry it)
-- -----------------------------------------------------------------------
-- This file is numbered 0010 but is added AFTER 0011_pause.sql and
-- 0013_events_project_fk.sql already exist and have run. The runner applies
-- *pending* migrations in filename order, so on an existing database this file
-- runs LAST despite its number; on a fresh one it runs tenth. The runner warns
-- when it spots this (packages/server/src/core/db/migrate.ts,
-- warnOnOutOfOrder) and that warning is correct and expected here.
--
-- Both orders must work, so this file may only reference tables created by a
-- migration numbered BELOW it that *also* already exists: `projects` (0001),
-- `events` (0002), `sessions` (0003), `tasks` (0005) and `file_locks` (0007).
-- It references `projects` and `tasks`. It must NOT reference
-- 0008_spawn_queue.sql (ticket 018) or 0009_batches.sql (019), neither of
-- which is written yet.
--
--
-- WHY session_id IS NOT A FOREIGN KEY, AND WHICH session_id IT IS
-- --------------------------------------------------------------
-- It is the **Claude** session id from the hook payload — the correlation
-- field spike 001 §3 settled on, and the only identifier the guard script has
-- when the orchestrator is unreachable. `sessions.claude_session_id` is
-- deliberately NOT unique (0003's header: "two rows could legitimately have
-- held the same id at different times"), so there is nothing to reference. The
-- resolved orchestrator row, when one can be found, is recorded separately in
-- `session_row_id`.
--
--
-- gen_random_uuid() is a PostgreSQL 13+ built-in; this repo's Postgres is 16.
-- Same note as 0001_core.sql.

-- --------------------------------------------------------------------------
-- unguarded_edits — one row per mutating tool call the guard did not see
-- --------------------------------------------------------------------------

create table unguarded_edits (
  id uuid primary key default gen_random_uuid(),

  -- THE IDEMPOTENCY KEY, and the reason this column is `text` rather than
  -- `uuid`.
  --
  -- "A flush that arrives twice does not double-flag; flushes are idempotent
  -- by edit id" is an acceptance criterion, and it is held HERE by a unique
  -- constraint rather than by a check-then-insert in application code: the
  -- buffer is flushed by a shell script with no transaction and no retry
  -- budget, so two overlapping flushes of the same spool are an ordinary
  -- event, not a race to be reasoned about.
  --
  -- The id is minted by the guard script on the agent's box, which may have
  -- no uuid source at all — /proc/sys/kernel/random/uuid is Linux-only and
  -- the script falls back to a timestamp-pid-random string. Declaring this
  -- `uuid` would make the fallback path fail the insert, which is the one
  -- path that only runs when something is already wrong.
  edit_id text not null check (length(trim(edit_id)) > 0),

  -- The flush batch this edit arrived in. The buffer is drained exactly once
  -- per recovery, so ONE FLUSH IS ONE OUTAGE WINDOW — which is what ticket
  -- 029 groups its listing by ("grouped by the outage window"). Derived from
  -- the data rather than from a windowing heuristic over timestamps, and
  -- stable under a repeated flush because a repeat inserts nothing.
  flush_id uuid not null,

  -- Null when the edit could not be attributed to a project: the session was
  -- never registered, or the orchestrator row had been deleted by the time
  -- the buffer was flushed. Cascade, so deleting a project takes its
  -- unguarded-edit history with it like everything else.
  project_id uuid references projects (id) on delete cascade,

  -- The Claude session id off the hook payload. See the header for why this
  -- is not a foreign key.
  session_id uuid,

  -- The orchestrator's own `sessions` row, when the flush could still resolve
  -- one. Nullable and NOT a hard dependency: the whole point of the buffer is
  -- that it survives the orchestrator, and a desk may be long gone by the
  -- time its buffer is read.
  session_row_id uuid references sessions (id) on delete set null,

  -- The task the editing session itself held scope for, when it held exactly
  -- one. This is the task that gets flagged as the *offender*; the owner of
  -- the file is recorded per conflict below.
  task_id uuid references tasks (id) on delete set null,

  tool_name text,
  tool_use_id text,

  -- Repo-relative POSIX paths, already through
  -- packages/server/src/features/locks/overlap.ts's normaliser, so they
  -- compare against `file_locks.path_pattern` as stored strings.
  --
  -- MAY BE EMPTY, and that is a real state rather than a bug: the guard
  -- script needs `jq` to pull paths out of a hook payload without also
  -- touching `tool_input.content`, and an agent box without `jq` records the
  -- attempt with no path instead of guessing one out of file content. See
  -- `extract_note`.
  paths text[] not null default '{}',

  -- The paths exactly as the hook payload carried them, for an operator
  -- reading the row. Normalisation is lossy (absolute -> repo-relative) and
  -- the raw form is what appears in a git status.
  raw_paths text[] not null default '{}',

  -- The agent's cwd, which is what made the absolute paths above relative.
  cwd text,

  -- Why the guard did not get an answer: curl's exit code, an HTTP status, a
  -- missing environment variable. Free text, because the interesting cases
  -- are the ones nobody predicted.
  reason text,

  -- Set when the paths could not be extracted, naming what was missing.
  -- NULL on the normal path.
  extract_note text,

  -- When the agent made the call, by the agent box's own clock. NOT a trusted
  -- ordering key: the target host's wall clock was observed stepping
  -- BACKWARDS twice in one session on 2026-10-07, and this one is a different
  -- machine's clock again. Use it to tell a human roughly when, and
  -- `received_at` to order.
  attempted_at timestamptz,

  -- When the orchestrator accepted the flush. Its own clock, and the column
  -- every listing orders by.
  received_at timestamptz not null default now(),

  -- When the retroactive check ran over this row, and what it found. Split
  -- from `received_at` so a row that was accepted but never checked (a crash
  -- mid-flush) is distinguishable from one that was checked and found clean.
  checked_at timestamptz,
  conflict_count integer not null default 0 check (conflict_count >= 0),

  -- How many older entries the buffer dropped to stay under its cap, as
  -- reported by the flush that carried this row. Recorded rather than
  -- silently discarded: "drops oldest-first with a recorded count rather than
  -- growing without bound" is an acceptance criterion, and a count that only
  -- ever lived in a file on the agent's box answers nobody's question.
  --
  -- Attributed to the whole flush, so every row of one flush carries the same
  -- number. Read it with `max()` per flush_id, never `sum()`.
  buffer_dropped integer not null default 0 check (buffer_dropped >= 0),

  constraint unguarded_edits_edit_id_unique unique (edit_id)
);

-- The listing ticket 029 renders: newest outage first.
create index unguarded_edits_received_idx on unguarded_edits (received_at desc, id desc);

-- "Show me this outage" and "show me this project's".
create index unguarded_edits_flush_idx on unguarded_edits (flush_id);
create index unguarded_edits_project_idx on unguarded_edits (project_id, received_at desc);

-- "Was this task involved in an unguarded edit?", from the task detail page.
create index unguarded_edits_task_idx on unguarded_edits (task_id) where task_id is not null;

comment on table unguarded_edits is
  'Mutating tool calls that proceeded while the guard could not reach the orchestrator. Ticket 020.';
comment on column unguarded_edits.edit_id is
  'Minted by hooks/pretooluse-guard.sh. Unique: this is what makes a repeated flush idempotent.';
comment on column unguarded_edits.flush_id is
  'One flush is one outage window — the buffer is drained exactly once per recovery.';
comment on column unguarded_edits.paths is
  'Repo-relative, normalised. Empty when the agent box had no jq to extract them; see extract_note.';

-- --------------------------------------------------------------------------
-- unguarded_edit_conflicts — what the retroactive check actually found
-- --------------------------------------------------------------------------
--
-- A child table rather than a jsonb column on the row above, because this is
-- what gets joined: ticket 029 lists an outage "with the tasks flagged for
-- review linked from each", and the task detail page asks the mirror question
-- ("did anyone edit my files while the guard was down?"). Both are joins, and
-- a jsonb array answers neither without a lateral unnest.
--
-- WHAT A ROW HERE MEANS, PRECISELY: at the moment of the edit, a *different*
-- active task held a lock whose pattern could match this path. It does NOT
-- mean the two agents actually collided — the owner may never have touched
-- that file. The guard flags for review; it cannot undo, and it must not
-- claim more than it knows.

create table unguarded_edit_conflicts (
  id uuid primary key default gen_random_uuid(),

  unguarded_edit_id uuid not null references unguarded_edits (id) on delete cascade,

  -- The repo-relative path that collided. One of `unguarded_edits.paths`.
  path text not null check (path <> ''),

  -- The task that owned it. `set null` rather than cascade: a deleted task
  -- does not make the finding untrue, and a conflict row whose owner is gone
  -- still tells an operator that something happened to this path.
  owner_task_id uuid references tasks (id) on delete set null,

  -- Denormalised so the finding stays readable after the lock is released and
  -- the task is renamed or deleted. This row is an audit record, and an audit
  -- record that needs three live joins to mean anything is not one.
  owner_task_title text,
  owner_task_owner text,
  held_pattern text not null,
  held_lock_id uuid,

  -- From packages/server/src/features/locks/overlap.ts's verdict. FALSE means
  -- the overlap could not be *proved* — two globs whose literal prefixes
  -- overlap — and is reported anyway, per the conservative-resolution
  -- decision. A human reading the flag needs to know whether it was
  -- demonstrated or assumed, which is the same reason `ScopeConflict.certain`
  -- exists.
  certain boolean not null,
  reason text not null,

  -- One finding per (edit, path, owning task). Two overlapping patterns held
  -- by the same task are one problem, not two, and re-running the check must
  -- not multiply rows.
  constraint unguarded_edit_conflicts_once unique (unguarded_edit_id, path, owner_task_id)
);

create index unguarded_edit_conflicts_owner_idx
  on unguarded_edit_conflicts (owner_task_id)
  where owner_task_id is not null;

comment on table unguarded_edit_conflicts is
  'Retroactive findings: an unguarded edit touched a path another active task held. Flags for review; proves nothing about an actual collision. Ticket 020.';
comment on column unguarded_edit_conflicts.certain is
  'False when disjointness could not be proved (glob vs glob). Reported anyway, conservatively.';

-- --------------------------------------------------------------------------
-- tasks: the review flag
-- --------------------------------------------------------------------------
--
-- Three columns, written only by
-- packages/server/src/features/locks/unguarded-edits.ts. Ticket 012 owns the
-- rest of the table and does not know about them.
--
-- A FLAG, NOT A STATE. The open question this ticket deliberately leaves open
-- is whether a flagged task should also be *paused* automatically; it is not
-- implemented, because auto-pausing on a stale signal is its own failure mode
-- (the retroactive check runs after the fact, when both agents may already
-- have finished). So this is a boolean beside the state machine rather than a
-- new state inside it — nothing in 0005's transition rules has to learn about
-- it, and clearing it is one update rather than a transition that needs a
-- legal predecessor.
--
-- Note that `tasks` has a BEFORE UPDATE trigger (0005) which raises unless a
-- state change goes through transition(); it keys on `new.state is distinct
-- from old.state`, so writing these columns is an ordinary update and moves
-- `updated_at` like any other.

alter table tasks add column review_flagged boolean not null default false;

-- First flag, not latest. The flag is sticky and may be raised again by a
-- later outage; "when did this task first need looking at" is the question an
-- operator asks, and overwriting it on every later finding loses it.
alter table tasks add column review_flagged_at timestamptz;

-- Why, in one line, for the card. The detail is in
-- `unguarded_edit_conflicts`; this is what fits on a chip.
alter table tasks add column review_flagged_reason text;

alter table tasks add constraint tasks_review_flagged_at_matches
  check ((review_flagged = false) or (review_flagged_at is not null));

-- The board query: "which tasks need a human to look at them?"
create index tasks_review_flagged_idx
  on tasks (project_id)
  where review_flagged = true;

comment on column tasks.review_flagged is
  'Raised by the guard''s retroactive check after an outage. A flag beside the state machine, not a state: flagging does not pause the task (ticket 020, open question).';
comment on column tasks.review_flagged_at is
  'When it was FIRST flagged. Not moved by a later finding.';
