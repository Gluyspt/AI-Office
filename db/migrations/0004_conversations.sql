-- 0004_conversations.sql
--
-- The chat transcript store (ticket 010): `conversations`,
-- `conversation_segments`, `chat_messages`, and the orphan table that keeps
-- the promise "never dropped".
--
-- THE DECISION THIS SCHEMA EXISTS TO EXPRESS
-- -----------------------------------------
-- "A conversation belongs to a task or to a role slot; sessions are
-- segments within it." That is not a modelling preference, it is forced by
-- a measured fact: **a tmux session is not one claude session.** Claude
-- session ids are single-use (relaunching with one already seen exits 1,
-- `already in use`) and `/clear` ENDS the claude session and rotates the id
-- while the agent keeps working. So one desk genuinely produces a
-- succession of claude session ids. 0003_sessions.sql keeps only the
-- *current* one on the registry row and says, in as many words, that the
-- succession is this migration's to model.
--
-- The consequence the UI must honour: the human sees continuous history
-- (the conversation), the agent does not remember it (each segment is a
-- fresh context), and the panel renders a labelled divider at every segment
-- boundary saying why the previous one ended. Hence `end_reason` and
-- `restored_from_handoff` below — a divider with nothing to say would imply
-- continuity that does not exist.
--
-- Source for every mechanism claim above: docs/spikes/001-hook-payloads.md
-- (§3 correlation and single-use ids, §4b Stop and the interrupted turn,
-- §5 the captured payloads).
--
--
-- MIGRATION-ORDERING HAZARD (the third file in this repo to document it)
-- ---------------------------------------------------------------------
-- This file is numbered 0004 but is being added AFTER 0005-0014 already
-- exist and have run. The runner applies *pending* migrations in filename
-- order, so on an existing database this file runs LAST despite its number;
-- on a fresh one it runs fourth. The runner warns when it spots this
-- (packages/server/src/core/db/migrate.ts, `warnOnOutOfOrder`).
--
-- Both orders must work, which has one hard consequence here: this file may
-- only reference tables created by a migration numbered BELOW it that also
-- already exists — `projects` (0001), `events` (0002) and `sessions` /
-- `session_message_queue` (0003). It must NOT reference `tasks` (0005),
-- even though a conversation is keyed on a task id, because on a fresh
-- database `tasks` does not exist when this runs.
--
-- So `conversations.task_id` is a bare uuid with no foreign key. See the
-- comment on the column for which ticket should add the constraint.
--
--
-- gen_random_uuid() is a PostgreSQL 13+ built-in; this repo's Postgres is
-- 16. Same note as 0001_core.sql.

-- --------------------------------------------------------------------------
-- conversations
-- --------------------------------------------------------------------------
--
-- Two subject kinds, and exactly one of them per row:
--
--   task       -- a unit of work. Workers have tasks; leads never do.
--   role_slot  -- a seat in the org chart. First-class, NOT a fallback:
--                 Management and department leads have no task and still
--                 need a continuous history across every respawn.
--
-- THE ROLE-SLOT KEY INCLUDES `owner`, AND THE TICKET SAYS THREE COLUMNS.
-- This is a deliberate, narrowing deviation; the reason is a bug the
-- three-column key has:
--
--   * The ticket defines the slot as (project, department, role). For a
--     lead that is already unique — there is one dev lead per project — so
--     for the case the decision is actually about, the two keys behave
--     identically.
--   * For role = 'worker' it is NOT unique. Every dev worker in a project
--     shares (project, 'dev', 'worker'), so a three-column key would merge
--     every worker's chat into one conversation. That is the opposite of
--     what this ticket exists to do.
--   * (project_id, dept, role, owner) is exactly the identity tuple
--     0003_sessions.sql already enforces one live desk per
--     (`sessions_one_live_per_identity`). Keying on the orchestrator's own
--     notion of a desk identity is what makes the criterion "two sessions
--     belonging to different users never cross-contaminate transcripts"
--     true by construction rather than by test.
--
-- A worker whose task is not known to the orchestrator therefore lands in
-- its desk's role-slot conversation rather than its task's. That is an
-- honest gap, not a design: NOTHING in the schema links a session to a task
-- yet (0003 has no task_id, and `claim_task` is ticket 017), so the task id
-- can only arrive from a caller that already knows it. See
-- features/chat/conversations.ts.

create table conversations (
  id uuid primary key default gen_random_uuid(),

  -- Every project-scoped table carries project_id (one database,
  -- project_id everywhere — see docs/tasks/README.md "Decisions made").
  project_id uuid not null references projects (id) on delete cascade,

  subject_kind text not null,

  -- NO FOREIGN KEY, and that is the migration-ordering hazard above, not an
  -- oversight: `tasks` is 0005 and does not exist when this file runs on a
  -- fresh database. No ticket in steps 1-3 owns adding the constraint —
  -- the honest statement is that whichever later migration first needs
  -- referential integrity here should add
  --   alter table conversations add constraint conversations_task_fk
  --     foreign key (task_id) references tasks (id) on delete cascade;
  -- Ticket 017 owns the next tasks migration (0014) and is the natural
  -- place; ticket 026 is the consumer that would notice a dangling id.
  task_id uuid,

  -- The role slot. Null on a task conversation; all three non-null on a
  -- role-slot conversation. `role` is unconstrained text for the same
  -- reason 0003 leaves sessions.role unconstrained: the vocabulary lives in
  -- packages/shared/src/sessions.ts and is checked at the API boundary.
  dept text,
  role text,
  owner text,

  created_at timestamptz not null default now(),

  constraint conversations_subject_kind_known
    check (subject_kind in ('task', 'role_slot')),

  -- Exactly one subject, fully populated. Without this a row could carry
  -- both a task id and a role slot, and the two partial unique indexes
  -- below would each think they owned it.
  constraint conversations_subject_shape check (
    (subject_kind = 'task'
       and task_id is not null
       and dept is null and role is null and owner is null)
    or
    (subject_kind = 'role_slot'
       and task_id is null
       and dept is not null and role is not null and owner is not null)
  )
);

-- One conversation per task, and one per role slot. Both are what makes
-- "a session replacing another appends a new SEGMENT, never a new
-- conversation" an invariant instead of a check-then-act race between two
-- hook events arriving in the same millisecond.
create unique index conversations_one_per_task
  on conversations (task_id)
  where subject_kind = 'task';

create unique index conversations_one_per_role_slot
  on conversations (project_id, dept, role, owner)
  where subject_kind = 'role_slot';

create index conversations_project on conversations (project_id);

comment on table conversations is
  'One continuous human-visible chat history. Keyed by task OR role slot; sessions are segments within it. Ticket 010.';
comment on column conversations.task_id is
  'Task this conversation belongs to. No FK: tasks (0005) may not exist when this migration runs — see the header.';

-- --------------------------------------------------------------------------
-- conversation_segments
-- --------------------------------------------------------------------------
--
-- One segment per CLAUDE session, not per registry row. That distinction is
-- the whole point:
--
--   * `session_id` is the desk (0003's row, one tmux session).
--   * `claude_session_id` is the segment. `/clear` rotates it while the
--     desk keeps working, and `/compact` does NOT (measured — see the
--     spike's §5 PreCompact note), so compaction is invisible here and a
--     clear is a boundary. A desk therefore owns several segments over its
--     life, which is precisely what 0003 declined to model.
--
-- UNIQUE on claude_session_id, where 0003 deliberately refused a unique on
-- its own copy of the column. The two are not in tension: 0003's column
-- holds a MUTABLE "current id" on a long-lived row, and a unique index
-- there would turn a correlation update into a constraint violation at the
-- worst moment. Here the id IS the row's identity, it is minted once by the
-- orchestrator, and the CLI enforces single use. The index is also what
-- lets a concurrently-arriving pair of hook events resolve to one segment
-- rather than two.

create table conversation_segments (
  id uuid primary key default gen_random_uuid(),

  conversation_id uuid not null references conversations (id) on delete cascade,

  -- The desk. 0003 exists and is numbered below this file, so this FK is
  -- legal under the ordering rule in the header.
  session_id uuid not null references sessions (id) on delete cascade,

  -- The claude session this segment is. Nullable only for the case where a
  -- human opens a chat and speaks first, before the desk has reported any
  -- hook event carrying an id — the message still has to be recorded
  -- somewhere attributable.
  claude_session_id uuid,

  -- 1-based position within the conversation. The panel's divider reads
  -- "segment 3 of 5" from this, and ordering by it is immune to the
  -- clock problem described on chat_messages.seq below.
  ordinal int not null,

  -- Who ran this segment, and on which model. `owner` duplicates the
  -- desk's column on purpose: a reassignment is a segment boundary (the
  -- ticket's own open question, answered that way), so the owner is a
  -- property of the segment as much as of the desk. `model` is what lets
  -- the boundary be labelled "model switch" — see end_reason.
  owner text not null,
  model text,

  -- Why this segment began, mapped from SessionStart's own `source` field
  -- (observed values: startup, clear, resume). 'unknown' is the honest
  -- value when a segment is opened lazily by a Stop for a claude session
  -- id no SessionStart ever announced — which is reachable, because
  -- SessionStart is delivered to a `command` hook only and a misprovisioned
  -- one is silent.
  start_reason text not null default 'unknown',

  -- Why this segment ENDED. Null while it is open. The acceptance
  -- criterion is "each segment records why the previous one ended" — that
  -- is answered by reading the previous segment's value (a `lag()` window
  -- in features/chat/transcript.ts), rather than by denormalising the
  -- reason onto the successor where the two copies could disagree.
  --
  -- 'paused' and 'completed' are in the vocabulary and nothing sets them
  -- yet: pause is ticket 028 and task completion is ticket 017, and both
  -- call closeSegment() when they exist. Naming them now beats discovering
  -- the column cannot express them later.
  end_reason text,

  -- Whether the agent's context was restored from a handoff node when this
  -- segment opened. ALWAYS FALSE in steps 1-3 — "Resume respawns with the
  -- task brief only, no handoff" (docs/tasks/README.md, "What steps 1-3
  -- deliberately leave inert"); handoffs are steps 4 and 5. The column
  -- exists because the divider must be able to say "context restored" or
  -- "context lost", and a UI that cannot say the second one lies.
  restored_from_handoff boolean not null default false,

  started_at timestamptz not null default now(),
  ended_at timestamptz,

  constraint conversation_segments_start_reason_known
    check (start_reason in ('spawn', 'cleared', 'resumed', 'unknown')),

  constraint conversation_segments_end_reason_known check (
    end_reason is null
    or end_reason in ('cleared', 'exited', 'completed', 'paused',
                      'model_switch', 'crash', 'replaced', 'unknown')
  ),

  -- A closed segment has both, an open one has neither. Same shape as
  -- 0003's sessions_ended_at_matches_status, and for the same reason: every
  -- "which segment is live" query leans on it.
  constraint conversation_segments_closed_consistently check (
    (end_reason is null and ended_at is null)
    or (end_reason is not null and ended_at is not null)
  ),

  constraint conversation_segments_ordinal_positive check (ordinal >= 1)
);

create unique index conversation_segments_one_per_claude_session
  on conversation_segments (claude_session_id)
  where claude_session_id is not null;

create unique index conversation_segments_ordinal
  on conversation_segments (conversation_id, ordinal);

-- "The one open segment of this conversation." Partial unique, so a
-- conversation cannot end up with two live segments through a race — the
-- divider story only makes sense if segments are a sequence, not a set.
create unique index conversation_segments_one_open
  on conversation_segments (conversation_id)
  where end_reason is null;

create index conversation_segments_session on conversation_segments (session_id);

comment on table conversation_segments is
  'One per CLAUDE session: the unit the agent remembers. /clear rotates the id and starts a new one; /compact does not. Ticket 010.';
comment on column conversation_segments.restored_from_handoff is
  'Always false in steps 1-3 — handoffs are steps 4/5. The divider needs to be able to say "context lost".';

-- --------------------------------------------------------------------------
-- chat_messages
-- --------------------------------------------------------------------------
--
-- ORDERING COMES FROM A SEQUENCE, NOT FROM THE CLOCK, and this is the one
-- design choice in this file that is driven by a host defect rather than by
-- the design.
--
-- The target host's wall clock was observed STEPPING BACKWARDS twice in one
-- session (two measured durations of -494 ms and -100 ms, impossible by
-- construction). A transcript ordered by `created_at` would therefore
-- reorder itself across such a step, and "50 interleaved writes read back
-- in send order" would be a coin flip. `now()` is also transaction-start
-- time, so two rows written in one transaction share it exactly.
--
-- `seq` is a bigserial: monotonic in assignment order, independent of the
-- clock, and an integer — which is also why the paging cursor built on it
-- CANNOT hit the timestamptz-to-JS-Date microsecond trap this repo has now
-- hit five times (see the comment on listTasks in features/tasks/repo.ts,
-- where a paging cursor exactly like this one was the casualty). The way to
-- survive that trap is not to carry a timestamp in the cursor at all.
--
-- `created_at` is display only, and is read as ::text anyway, per house
-- style.

create table chat_messages (
  id uuid primary key default gen_random_uuid(),

  -- Both ids on every message, as the decision requires: the conversation
  -- is what the human reads, the session is the record of which process
  -- produced it. Neither is derivable from the other after the fact.
  conversation_id uuid not null references conversations (id) on delete cascade,
  session_id uuid not null references sessions (id) on delete cascade,

  -- The segment, so a message can be placed on the right side of a
  -- divider. Not nullable: every message belongs to some segment, even the
  -- one a human sends before the desk has said anything.
  segment_id uuid not null references conversation_segments (id) on delete cascade,

  -- inbound  -> the agent spoke (Stop's last_assistant_message, verbatim)
  -- outbound -> a human spoke
  direction text not null,

  -- Opaque label. Convention: 'agent:<role>:<dept>' inbound, the human's
  -- own identifier outbound. Recorded, never checked — permissions are step
  -- 9, matching how 0003 treats session_message_queue.requested_by.
  author text not null,

  body text not null,

  -- The hook payload's `prompt_id`: the turn this message belongs to.
  -- Present on every captured payload except SessionStart. Null outbound,
  -- because the id is minted by the TUI and the orchestrator never sees it
  -- for a message it is still sending.
  turn_id text,

  -- Outbound only, null inbound (enforced below).
  --   pending   -> recorded, delivery not yet attempted
  --   delivered -> tmux accepted it
  --   queued    -> refused because a permission dialog was open; it stays
  --                pending in session_message_queue and goes out later
  --   failed    -> it will not arrive, and the transcript says so
  delivery_status text,
  delivery_detail text,

  -- The session_message_queue row this message was handed to, when there is
  -- one. 0003 exists and is lower-numbered, so the FK is legal. Lets the UI
  -- say "discarded by an interrupt" instead of leaving a 'queued' message
  -- looking like it is still on its way.
  queued_message_id uuid references session_message_queue (id) on delete set null,

  seq bigserial not null,
  created_at timestamptz not null default now(),

  constraint chat_messages_direction_known check (direction in ('inbound', 'outbound')),

  constraint chat_messages_delivery_status_known check (
    delivery_status is null
    or delivery_status in ('pending', 'delivered', 'queued', 'failed')
  ),

  -- An inbound message has already arrived; a delivery status on it would
  -- be meaningless, and an outbound one without a status would be
  -- unrenderable.
  constraint chat_messages_delivery_matches_direction check (
    (direction = 'outbound' and delivery_status is not null)
    or (direction = 'inbound' and delivery_status is null)
  ),

  -- A reply is never empty. The criterion "a turn that ends with no
  -- assistant text does not append an empty message" is enforced in
  -- features/chat/handlers/reply.ts, which declines to insert; this
  -- constraint is the backstop that makes a regression there loud.
  constraint chat_messages_body_present check (length(body) > 0)
);

-- ONE REPLY PER TURN. A turn fires exactly one Stop, so this makes the
-- criterion "appends exactly one inbound message" true by construction
-- rather than by hoping ingest is never called twice with the same payload
-- (nothing dedupes hook POSTs, and a `command` hook is a shell script a
-- human could re-run).
create unique index chat_messages_one_reply_per_turn
  on chat_messages (segment_id, turn_id)
  where direction = 'inbound' and turn_id is not null;

-- The paging read: newest-first within one conversation, walking backwards.
create index chat_messages_conversation_seq
  on chat_messages (conversation_id, seq desc);

create index chat_messages_session on chat_messages (session_id);

comment on table chat_messages is
  'The transcript. Ordered by seq, never by created_at — the target host''s wall clock steps backwards. Ticket 010.';
comment on column chat_messages.seq is
  'Monotonic send order. The paging cursor carries this and no timestamp, which is how it avoids the timestamptz->Date microsecond trap.';

-- --------------------------------------------------------------------------
-- orphaned_replies
-- --------------------------------------------------------------------------
--
-- "A Stop event that cannot be correlated to a session row is stored as
-- orphaned with its payload intact, and logged — never dropped, never
-- crashed on."
--
-- A separate table rather than a nullable conversation_id on chat_messages,
-- for two reasons. First, an orphan is not a transcript entry: it has no
-- conversation to be read in, and relaxing chat_messages' FKs to hold it
-- would weaken every row that does belong somewhere. Second, the useful
-- question about orphans is "what has the orchestrator failed to attribute,
-- and why" — an ops question, answered by selecting this whole table, not
-- by filtering the transcript.
--
-- The payload is kept here as well as in `events`, where ingest already
-- stored it intact. The duplication is deliberate: `events` is a firehose
-- with a retention question hanging over it (PostToolUse carries whole file
-- bodies), and the one payload nobody can re-derive is the one that could
-- not be attributed.

create table orphaned_replies (
  id uuid primary key default gen_random_uuid(),

  -- The event row ingest already persisted. 0002 exists and is
  -- lower-numbered, so this FK is legal under the ordering rule.
  event_id uuid not null references events (id) on delete cascade,

  -- The claude session id that matched no desk. Not a FK to anything, by
  -- definition — that is what makes it an orphan.
  claude_session_id uuid,

  payload jsonb not null,

  -- The extracted reply text, when the payload had one. Kept separately so
  -- a human reading this table sees what the agent said without digging
  -- through the envelope.
  body text,

  reason text not null,

  received_at timestamptz not null default now()
);

create index orphaned_replies_claude_session
  on orphaned_replies (claude_session_id);

comment on table orphaned_replies is
  'Stop payloads that matched no session row. Kept intact so nothing is ever dropped. Ticket 010.';
