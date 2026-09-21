-- 0002_events.sql
--
-- Event store for hook ingest (ticket 005). Every accepted POST — a
-- recognized hook payload, a payload of a hook type this ticket doesn't yet
-- have a schema for, or a dead-lettered malformed body — lands as one row
-- here, full payload intact (see docs/tasks/005-event-server-ingest.md's
-- "Decided" section on why that's a confidentiality question, not only a
-- disk one: PostToolUse.tool_response carries whole file bodies).
--
-- `type` is read from the payload's own `hook_event_name` field, never from
-- which /events/<slug> endpoint received the POST — /events/tool alone
-- carries both PreToolUse and PostToolUse, and StopFailure carries the same
-- last_assistant_message field Stop does, so keying on anything other than
-- hook_event_name misclassifies events (see packages/shared/src/events.ts).
-- A payload that isn't a JSON object with a string hook_event_name is stored
-- with type 'unparsed' and its raw body preserved inside `payload`.
--
-- project_id and session_id are both nullable at this stage:
--   - project_id: nothing in a hook payload identifies a *project* — that
--     mapping belongs to the session registry (ticket 008) and reply
--     correlation (ticket 010), neither of which exists yet. Always NULL
--     until a later ticket back-fills it.
--   - session_id: present on every payload the spike captured (including
--     the first SessionStart), so ingest does populate it whenever the
--     payload's session_id is syntactically a UUID — but a dead-lettered
--     payload may have no readable session_id at all, hence nullable.
--
-- gen_random_uuid() is a PostgreSQL 13+ built-in — see 0001_core.sql's note;
-- this repo's local dev Postgres is version 16 (docker-compose.dev.yml).
create table events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects (id),
  session_id uuid,
  type text not null,
  payload jsonb not null,
  received_at timestamptz not null default now()
);

-- Read pattern this index serves: "the newest events for project X" (the
-- GET /events?project_id=&since=&limit= endpoint), newest-first.
create index events_project_id_received_at_idx
  on events (project_id, received_at desc);
