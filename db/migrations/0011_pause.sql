-- 0011_pause.sql
--
-- Pause, emergency stop and resume (ticket 028): the `pause_state` row that
-- IS the pause, the per-agent record of what the choreography did to each
-- desk, and the two columns on `sessions` that let a resumed conversation be
-- labelled honestly.
--
-- "Pause, emergency stop, and resume land here too — build them before
-- agents ever run unattended."
--
--
-- MIGRATION-ORDERING HAZARD (the third file in this directory to carry it)
-- -----------------------------------------------------------------------
-- This file is numbered 0011 but is added AFTER 0013_events_project_fk.sql
-- already exists and has run. The runner applies *pending* migrations in
-- filename order, so on an existing database this file runs LAST despite its
-- number; on a fresh one it runs eleventh. The runner warns when it spots
-- this (packages/server/src/core/db/migrate.ts, warnOnOutOfOrder).
--
-- Both orders must work. The consequence here: this file may only reference
-- tables created by a migration numbered BELOW it that *also* already
-- exists — in practice `projects` (0001), `events` (0002), `sessions`
-- (0003), `tasks` (0005) and `file_locks` (0007). It references the first
-- and the third. It must not reference 0008_spawn_queue.sql (ticket 018),
-- 0009_batches.sql (019), 0010_unguarded_edits.sql (020) or
-- 0012_gate_bypass.sql (032), none of which are written yet — which is why
-- "a pause does not drain the spawn queue" is held by the trigger at the
-- bottom of this file rather than by a constraint on a table that does not
-- exist.
--
--
-- WHY THE OBVIOUS CHECK CONSTRAINTS ARE ABSENT: THE CLOCK STEPS BACKWARDS
-- ----------------------------------------------------------------------
-- There is no `check (completed_at >= started_at)` here, and none on
-- `lifted_at` either, and that is deliberate rather than an oversight.
--
-- The target host's wall clock was observed stepping BACKWARDS twice in one
-- session on 2026-10-07 (-494 ms and -100 ms, impossible by construction).
-- `started_at` is written when the pause opens and `completed_at` when the
-- choreography finishes, in a different transaction and therefore against a
-- different now(). A backwards step between the two would make an ordering
-- check reject the completion of a pause — failing at the exact moment
-- someone is trying to stop a runaway, which is the worst possible place to
-- discover that a tidy-looking constraint encodes an assumption about time
-- that this host does not honour.
--
-- Elapsed time is therefore measured with a MONOTONIC clock in the
-- application (`process.hrtime.bigint()`, see features/orchestrator/pause.ts)
-- and these columns are an audit trail, not an arithmetic input.
--
--
-- gen_random_uuid() is a PostgreSQL 13+ built-in; this repo's Postgres is
-- 16. Same note as 0001_core.sql.

-- --------------------------------------------------------------------------
-- pause_state — the pause itself
-- --------------------------------------------------------------------------
--
-- DURABLE, because a pause flag held in memory is not a pause. The whole
-- point of this row is that it holds when things are going wrong, and
-- "things are going wrong" includes the orchestrator having just been
-- restarted. Everything that asks "may work start here?" — the trigger
-- below, features/orchestrator/pause.ts, ticket 018's spawn-queue drain,
-- ticket 029's UI — reads this table and nothing else.

create table pause_state (
  id uuid primary key default gen_random_uuid(),

  -- NULL means GLOBAL: every project in the office. A value means that
  -- project only. Scope is load-bearing — "pausing one project leaves
  -- another project's sessions running" is an acceptance criterion — and the
  -- nullable column is what lets one table express both without a second
  -- "is_global" flag that could disagree with it.
  project_id uuid references projects (id) on delete cascade,

  kind text not null,

  -- Who pressed it, and why, for every pause and every stop. Opaque: there
  -- is no user table and no authentication until step 9, so this records who
  -- *claims* to have acted — the same treatment task_state_history gives
  -- `actor` and session_message_queue gives `requested_by`.
  initiated_by text not null,
  reason text,

  -- The deadline in force for THIS pause, in milliseconds. NULL for an
  -- emergency stop, which has no deadline by definition.
  --
  -- Recorded on the row rather than read back from config when the audit is
  -- read. PAUSE_DEADLINE_MS is required config with no default (the ticket's
  -- open question: the design says "wait with a deadline" and names no
  -- number), so it will be tuned — and an audit that cannot say which value
  -- was in force cannot answer "was 20 seconds too short?" afterwards, which
  -- is the only question the data is for.
  deadline_ms integer,

  started_at timestamptz not null default now(),

  -- NULL while the choreography is still running.
  --
  -- A pause is IN EFFECT FROM started_at, not from here. Refusing
  -- start_session has to be true the instant someone presses the button, not
  -- when the last agent has finally been killed — otherwise the window in
  -- which a lead can quietly start a new desk is exactly the window in which
  -- someone is trying to stop everything.
  completed_at timestamptz,

  -- How many tasks this pause moved to `paused`. Stored rather than derived:
  -- the state changes themselves live in task_state_history, but counting
  -- them back out of it means guessing a time window, and this host's clock
  -- makes time windows a poor key (see the header).
  tasks_paused integer not null default 0,

  -- Resume. `lifted_at is null` IS the "still in effect" predicate; the row
  -- is kept rather than deleted because "every pause, stop and resume
  -- records who triggered it and its scope" is an acceptance criterion, and
  -- a deleted row records nothing.
  lifted_at timestamptz,
  lifted_by text,

  -- An emergency stop pressed while THIS pause was still waiting out its
  -- deadline took over from it, and this points at the stop that did.
  --
  -- The ticket says a pause during an in-flight pause is rejected rather
  -- than interleaved, and that stands for a second *pause*. An emergency
  -- stop is the opposite case: a graceful pause that hangs is precisely when
  -- someone reaches for the big red button, and refusing it then would make
  -- the stuck pause unstoppable. So escalation is allowed, once, and leaves
  -- a trail instead of silently abandoning the earlier row.
  escalated_to uuid references pause_state (id) on delete set null,

  constraint pause_state_kind_known check (kind in ('graceful', 'emergency')),
  constraint pause_state_initiated_by_present check (length(trim(initiated_by)) > 0),
  constraint pause_state_deadline_positive check (deadline_ms is null or deadline_ms > 0),

  -- A lift records who lifted it, or it is not a lift. Both-or-neither,
  -- which is the same shape 0003's sessions_ended_at_matches_status uses.
  constraint pause_state_lifted_by_matches check ((lifted_at is null) = (lifted_by is null)),

  -- An emergency stop has no deadline to miss; a graceful pause always has
  -- one, because the choreography cannot "wait with a deadline" without one.
  constraint pause_state_deadline_matches_kind check (
    (kind = 'graceful' and deadline_ms is not null)
    or (kind = 'emergency' and deadline_ms is null)
  )
);

-- ONE ACTIVE PAUSE PER SCOPE, held by the database rather than by a
-- check-then-insert in application code.
--
-- "Pause during an in-flight pause is rejected rather than interleaved" is
-- an acceptance criterion, and two buttons pressed in the same millisecond
-- are exactly the case a read-then-write cannot cover. coalesce() rather
-- than a plain partial unique index on project_id, because NULLs are
-- distinct in a unique index: without it, two concurrent GLOBAL pauses would
-- both be allowed, which is the one case that matters most.
--
-- Note what this does NOT prevent: a global pause and a project pause being
-- active at the same time. Those have different scope keys and are a legal
-- overlap — a project pause inside a global one is redundant, not
-- contradictory. The application rejects the redundant one with a message;
-- the index is only here for the race.
create unique index pause_state_one_active_per_scope
  on pause_state (coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where lifted_at is null;

-- The hot read, run by the trigger below on every single session insert:
-- "is there an active pause covering this project?"
create index pause_state_active_idx
  on pause_state (project_id)
  where lifted_at is null;

comment on table pause_state is
  'The pause itself. One active row per scope; project_id NULL means global. Ticket 028.';
comment on column pause_state.completed_at is
  'When the choreography finished. A pause is in effect from started_at, not from here.';
comment on column pause_state.lifted_at is
  'When Resume ended it. NULL means the pause is still in effect.';

-- --------------------------------------------------------------------------
-- pause_session — what the choreography did to each desk
-- --------------------------------------------------------------------------
--
-- One row per (pause, session). The acceptance criterion is per-agent:
-- "an agent that misses the deadline is killed anyway, and the pause
-- completes; one stuck agent must not block the whole pause. The missed
-- deadline is reported per agent." A pause-level count of stragglers cannot
-- tell an operator *which* desk lost its work, and after a restart the
-- response body that carried the report is long gone — so it is a table, not
-- a return value.
--
-- Every column is a timestamp or an error string rather than a status enum,
-- because the interesting question is always "how far did this desk get",
-- and a sequence of nullable timestamps answers that without a vocabulary to
-- keep in sync with the code.

create table pause_session (
  id uuid primary key default gen_random_uuid(),

  pause_id uuid not null references pause_state (id) on delete cascade,

  -- Cascade: a pause report for a session row that no longer exists
  -- describes a desk nobody can look up. `sessions` (0003) is lower-numbered
  -- and already applied wherever this runs, so unlike 0007's session_id this
  -- one can be a real foreign key.
  session_id uuid not null references sessions (id) on delete cascade,

  -- Phase 1: Escape, and discard anything still queued. The discard is the
  -- point — a message queued before Escape still ran in 17 of 19 trials on
  -- the target host — so the count is recorded: an interrupt that silently
  -- dropped someone's instruction is worse than one that says so.
  interrupted_at timestamptz,
  interrupt_error text,
  discarded_messages integer not null default 0,

  -- Phase 2: the instruction to commit WIP and write a handoff. The error is
  -- expected to be non-null sometimes and that is not a bug: ticket 008
  -- refuses to deliver a message while a permission dialog is open, because
  -- a message delivered into a dialog APPROVES the pending tool call
  -- (measured on the target, 20/20, with the approved command's file left on
  -- disk). A pause must not answer a permission prompt on the way past.
  instructed_at timestamptz,
  instruction_error text,

  -- The handoff seam. Set when the seam ran; the reference it would have
  -- produced goes on sessions.handoff_ref and stays NULL until build step 5.
  handoff_requested_at timestamptz,

  -- Phase 3: the wait. Exactly one of these is meaningful per row —
  -- settled_at set means the agent's turn ended in time, deadline_missed
  -- means it did not and was killed anyway.
  settled_at timestamptz,
  deadline_missed boolean not null default false,

  -- Phase 4: the kill. An emergency stop writes only this phase.
  killed_at timestamptz,
  kill_error text,

  -- Why this desk's settle could not be observed, when it could not — a
  -- desk that never reported a Claude session id has no event stream to
  -- watch, and reporting that as a missed deadline would be a lie about the
  -- agent rather than a fact about the orchestrator.
  note text,

  constraint pause_session_once unique (pause_id, session_id)
);

-- "What has ever been done to this desk", for the agent card and for ticket
-- 026's divider. The unique constraint above already indexes (pause_id, ...).
create index pause_session_session_idx on pause_session (session_id);

comment on table pause_session is
  'Per-agent record of one pause choreography. Ticket 028; see the per-agent acceptance criterion.';

-- --------------------------------------------------------------------------
-- sessions: the handoff reference, and why a desk was ended
-- --------------------------------------------------------------------------
--
-- Both columns are added by this ticket and written only by
-- features/orchestrator/pause.ts and resume.ts. Ticket 008 owns the rest of
-- the table and does not know about either.

-- THE HANDOFF SEAM, as a column rather than a comment.
--
-- A graceful pause would record here the handoff node the agent wrote, so
-- resume could hand it back. The knowledge graph is build step 5 and does
-- not exist, so this stays NULL, `requestHandoffNode()` logs a warning and
-- returns null, and resume tells the respawned agent in so many words that
-- nothing was restored (HANDOFF_UNAVAILABLE_NOTICE in
-- packages/shared/src/control.ts).
--
-- The column exists now because the seam is the deliverable: the design's
-- own table promises "Full context" across a pause, and the step that fills
-- this in should find the slot waiting rather than the promise quietly
-- unimplemented.
alter table sessions add column handoff_ref text;

-- WHY THIS DESK WAS DELIBERATELY ENDED.
--
-- Read by ticket 026's conversation divider, which sits between two sessions
-- and says why the later one exists. It reads this off the EARLIER (ended)
-- row, because that is the only row that exists at the moment a pause kills
-- a desk — the replacement may not be spawned for days.
--
-- Distinct from `failure_reason`, which describes a desk that broke. This
-- one means "something stopped it on purpose". A narrow vocabulary, enforced
-- here: widening it is one line here and one in
-- packages/shared/src/control.ts (SESSION_END_REASONS).
alter table sessions add column end_reason text;

alter table sessions add constraint sessions_end_reason_known
  check (end_reason is null or end_reason in ('pause', 'emergency_stop'));

comment on column sessions.handoff_ref is
  'Handoff node reference. Always NULL until build step 5 — the knowledge graph does not exist. Ticket 028.';
comment on column sessions.end_reason is
  'Why this desk was deliberately ended: pause | emergency_stop. Ticket 026 labels the conversation divider from it.';

-- --------------------------------------------------------------------------
-- The refusal: no new desk starts while a pause is in effect
-- --------------------------------------------------------------------------
--
-- "While paused, start_session is refused with a message saying the project
-- is paused" and "a pause does not drain ticket 018's spawn queue: queued
-- spawns stay queued and do not start while the project is paused."
--
-- Both are one rule, and it is held HERE rather than in the four call sites
-- that will eventually want it — the HTTP route (008), the MCP session tool
-- (018), the spawn-queue drain (018) and the planning flow's promotion
-- (019). Three of those do not exist yet and cannot be made to remember.
--
-- This is the same mechanism 0005_tasks.sql uses to make "transition() is
-- the only way state changes" an invariant instead of a convention: a
-- convention that lives in review comments is not an invariant, and the
-- layer every caller has to go through is the row insert.
--
-- `sessions` is written before tmux is spawned (ticket 008's first
-- property), so refusing the insert refuses the spawn — nothing is started
-- and no orphan pane is left behind.
--
-- SQLSTATE OF010, in the same custom class OF the task triggers use
-- (OF001/OF002/OF003), so a caller can tell this apart from an ordinary
-- constraint violation without matching on message text. Callers:
-- `isPauseRefusal()` in features/orchestrator/pause.ts.
--
-- WHAT THIS DOES NOT DO: it cannot leave a trace. The exception aborts the
-- transaction, so a row this trigger wrote to `events` would be rolled back
-- with it. The traced path is `assertStartAllowed()` in pause.ts, which
-- emits StartSessionRefusedWhilePaused and then refuses; this trigger is the
-- backstop behind it — loud, and silent about having been loud.
--
-- Resume lifts the pause row BEFORE it respawns anything, so a project
-- resume is not blocked by its own pause. Resuming a single task while a
-- project-wide pause still stands is refused on purpose: the pause is a
-- statement that nothing runs here, and starting one agent inside it would
-- quietly contradict what the human asked for.

create or replace function sessions_refuse_while_paused() returns trigger
language plpgsql as $$
declare
  p record;
begin
  select ps.id, ps.project_id, ps.kind, ps.initiated_by, ps.started_at, ps.completed_at
    into p
    from pause_state ps
   where ps.lifted_at is null
     and (ps.project_id is null or ps.project_id = new.project_id)
   order by ps.started_at desc, ps.id
   limit 1;

  if found then
    raise exception using
      errcode = 'OF010',
      message = format(
        'project %s is paused; start_session is refused while a pause is in effect',
        new.project_id
      ),
      detail = format(
        '%s pause %s%s, started by %s at %s%s',
        p.kind,
        p.id,
        case when p.project_id is null then ' (global)' else '' end,
        p.initiated_by,
        p.started_at,
        case when p.completed_at is null then ', still in flight' else '' end
      ),
      hint = 'Resume first (POST /control/resume). A pause is lifted by Resume, not by retrying.';
  end if;

  return new;
end;
$$;

create trigger sessions_refuse_while_paused
  before insert on sessions
  for each row execute function sessions_refuse_while_paused();
