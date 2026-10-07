-- 0003_sessions.sql
--
-- The session registry (ticket 008): the `sessions` table, and the durable
-- message queue the orchestrator owns.
--
-- "Only the orchestrator starts sessions, through start_session(...)."
-- This is the record behind that call. Every later feature — chat (010),
-- the MCP session server (018), pause and emergency stop (028), the agent
-- cards in the UI (027) — reads or drives a row here.
--
--
-- MIGRATION-ORDERING HAZARD (the same one 0005 documents, from the other side)
-- ---------------------------------------------------------------------------
-- This file is numbered 0003 but is being added AFTER 0005, 0006, 0007 and
-- 0013 already exist and have run. The runner applies *pending* migrations
-- in filename order, so on an existing database this file runs LAST despite
-- its number; on a fresh one it runs third. The runner warns when it spots
-- this (packages/server/src/core/db/migrate.ts).
--
-- Both orders must therefore work, which has one consequence here: this
-- file may only reference tables created by a migration numbered BELOW it
-- that also already exists — in practice `projects` (0001). It must not
-- reference `tasks` (0005) or `file_locks` (0007), even though sessions
-- relate to both at runtime, because on a fresh database those do not exist
-- yet when this runs. Where the design implies such a link, the column is
-- added without the constraint and the ticket that will add it is named.
--
-- `events` (0002) is below this file and does exist, but note what it is
-- NOT used for below: events.session_id holds a *Claude* session id, which
-- is not this table's primary key. See the correlation note.
--
--
-- gen_random_uuid() is a PostgreSQL 13+ built-in; this repo's Postgres is
-- 16. Same note as 0001_core.sql.

-- --------------------------------------------------------------------------
-- sessions
-- --------------------------------------------------------------------------
--
-- CORRELATION, and why `claude_session_id` is nullable and mutable.
--
-- Spike 001 established that `session_id` is on every hook payload including
-- the first SessionStart, and that `claude --session-id <uuid>` works on an
-- interactive TUI launch. So the orchestrator *chooses* the id at spawn time
-- and correlation is direct — no cwd-plus-tmux-name heuristic.
--
-- But a tmux session is NOT one claude session. Ids are single-use
-- (relaunching with one already seen exits 1, "already in use"), and
-- `/clear` ends the claude session and rotates the id while the agent keeps
-- working. So this column holds *the current* id and is expected to change
-- over a row's life. The succession itself — "sessions are segments" — is
-- ticket 010's model, not this table's; this file only promises not to
-- assume 1:1.
--
-- Hence also: no unique constraint on claude_session_id. Two rows could
-- legitimately have held the same id at different times if one is replayed
-- from history, and a unique index would turn a correlation update into a
-- constraint violation at the worst moment.

create table sessions (
  id uuid primary key default gen_random_uuid(),

  -- Every project-scoped table carries project_id (GLU-46: one database,
  -- project_id everywhere, not a schema per project).
  project_id uuid not null references projects (id) on delete cascade,

  -- The tmux session name from naming.ts. Unique while the session is
  -- alive: two live desks cannot share a tmux name, because a message for
  -- one would land in the other. Enforced by a partial index below rather
  -- than a plain unique, so an ended row does not block a restart under the
  -- same deterministic name.
  tmux_name text not null,

  role text not null,
  dept text not null,

  -- The Linux user the agent runs as. NOT a foreign key: step 9 adds office
  -- membership and the link belongs there. Checked against the adapter's
  -- allowlist at spawn time, which is the boundary that matters.
  owner text not null,

  backend text not null,

  -- The design's Spawn feed shows every spawn with the reason its model was
  -- chosen, so the reason is NOT NULL here and not merely validated in the
  -- API: a row with no reason would make that feed lie, and the feed is how
  -- a human notices a lead picking opus for everything.
  model text not null,
  model_reason text not null,

  status text not null default 'starting',

  -- See the correlation note above.
  claude_session_id uuid,

  -- Why a session failed or ended the way it did. Carries the hook-delivery
  -- diagnosis the ticket asks for ("no event at all" vs "handshake
  -- rejected"), and SessionEnd's own reason where that is what ended it.
  failure_reason text,

  started_at timestamptz not null default now(),
  ended_at timestamptz,

  constraint sessions_status_known check (status in ('starting', 'running', 'ended', 'failed')),

  -- A terminal row has an end time and a live one does not. This is the
  -- invariant every "is this desk alive" query leans on, so the database
  -- holds it rather than trusting four call sites.
  constraint sessions_ended_at_matches_status check (
    (status in ('ended', 'failed') and ended_at is not null)
    or (status in ('starting', 'running') and ended_at is null)
  ),

  constraint sessions_model_reason_present check (length(trim(model_reason)) > 0)
);

-- One live desk per tmux name. Partial, so ended and failed rows accumulate
-- freely and a role can be restarted under the same deterministic name.
create unique index sessions_one_live_per_tmux_name
  on sessions (tmux_name)
  where status in ('starting', 'running');

-- The ticket's "two sessions with identical (project, role, dept, owner)"
-- criterion. 008 chose CONFLICT over reuse — see the comment in sessions.ts
-- for why — and this index is what makes that choice an invariant instead
-- of a race between two concurrent POSTs.
create unique index sessions_one_live_per_identity
  on sessions (project_id, role, dept, owner)
  where status in ('starting', 'running');

-- The board and the agent cards ask "what is live in this project".
create index sessions_project_status on sessions (project_id, status);

-- Correlation lookup: a hook event arrives carrying a claude session id and
-- has to find its row. Partial because a null id is the common state for a
-- row that has not reported yet and is never the thing being looked up.
create index sessions_claude_session_id on sessions (claude_session_id)
  where claude_session_id is not null;

comment on table sessions is
  'Agent desks. One row per tmux session; see ticket 008.';
comment on column sessions.claude_session_id is
  'The CURRENT Claude session id. Rotates on /clear; not 1:1 with this row. Ticket 010 models the succession.';

-- --------------------------------------------------------------------------
-- session_message_queue
-- --------------------------------------------------------------------------
--
-- WHY THIS TABLE EXISTS, measured 2026-10-07 on the target host.
--
-- The orchestrator owns the mid-turn message queue, and the queue has to
-- survive a restart. That is a decision taken on the grounds that the
-- alternative is unobservable, not because tmux misbehaved:
--
--   * A mid-turn message is always DELIVERED — 20/20 on the VPS, 8/8 on
--     WSL, never dropped. Delivery is not in question.
--   * Whether it lands during or after the turn cannot be told apart by the
--     method that was supposed to settle it. The harness classifies
--     `interleaved` vs `queued` by comparing two pane-scraped timestamps,
--     and those were <= 14 ms apart in 14 of 20 trials against a 100 ms
--     poll interval.
--   * A message queued before Escape still ran in 17 of 19 trials and was
--     discarded in 2. Same host, same command, two behaviours.
--
-- So interrupting has to mean NOT SENDING, which is only possible if the
-- pending message is somewhere we control. If better instrumentation ever
-- settles tmux's behaviour — hook events with real timestamps (010), not
-- pane polling — this table can be deleted rather than retrofitted.
--
-- Durable rather than in-memory for the same reason the row is written
-- before the spawn: a restart between "the human pressed send" and "the
-- agent received it" must not silently lose the instruction.

create table session_message_queue (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions (id) on delete cascade,

  body text not null,

  -- Who asked. Recorded, never checked — permissions are step 9, and this
  -- mirrors how states.ts treats a task's actor.
  requested_by text not null,

  -- pending  -> waiting to go out
  -- sent     -> handed to tmux
  -- discarded-> an interrupt or kill removed it before it went out. The
  --             reason distinguishes a deliberate discard from a lost one.
  status text not null default 'pending',
  discard_reason text,

  -- NOT NULL, not a task reference: tasks (0005) may not exist when this
  -- migration runs. Ticket 017 adds the link if it wants one.
  queued_at timestamptz not null default now(),
  sent_at timestamptz,

  constraint session_message_queue_status_known
    check (status in ('pending', 'sent', 'discarded')),
  constraint session_message_queue_body_present check (length(body) > 0),
  constraint session_message_queue_sent_at_matches_status check (
    (status = 'sent' and sent_at is not null) or (status <> 'sent' and sent_at is null)
  ),
  constraint session_message_queue_discard_reason_present check (
    (status = 'discarded' and discard_reason is not null)
    or (status <> 'discarded' and discard_reason is null)
  )
);

-- The drain query: oldest pending first, per session. `queued_at` is read
-- as text by the application where it must round-trip (the timestamptz ->
-- JS Date microsecond-loss trap this repo has hit four times), so the
-- ordering key here is the id tiebreak plus the timestamp, not the
-- timestamp alone.
create index session_message_queue_pending
  on session_message_queue (session_id, queued_at, id)
  where status = 'pending';

comment on table session_message_queue is
  'Mid-turn messages the orchestrator holds rather than trusting tmux to queue. Ticket 008; see the measurement note in this migration.';
