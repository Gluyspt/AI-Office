-- 0005_tasks.sql
--
-- The task board's storage (ticket 012): the `tasks` table and the
-- `task_state_history` audit log behind it. "Tasks live in our database,
-- managed through our own MCP tools... the server is authoritative" - so
-- the lifecycle in docs/ai-agent-office-design.md is enforced here and in
-- packages/server/src/tasks/states.ts, not re-checked by each caller.
--
--
-- MIGRATION-ORDERING HAZARD (why this file references nothing but `projects`)
-- --------------------------------------------------------------------------
-- 0003_sessions.sql (ticket 008) and 0004_conversations.sql (ticket 010) do
-- not exist yet, and this file is 0005. The runner
-- (packages/server/src/db/migrate.ts) applies *pending* migrations in
-- filename order, so on any database where 0005 has already run, a
-- later-added 0003 is applied AFTER it - filename order only equals
-- application order on a database that starts empty.
--
-- Therefore this migration must not depend on any table a lower-numbered,
-- not-yet-written migration will create. `projects` (0001) is the only
-- parent it references. Where the design implies a link to something
-- unwritten, the column is added without the constraint and the ticket that
-- will add it is named - see `owner` below (step 9's membership link) and
-- the absence of any session/conversation column here at all.
--
--
-- gen_random_uuid() is a PostgreSQL 13+ built-in (no pgcrypto extension
-- needed); this repo's local dev Postgres is version 16
-- (docker-compose.dev.yml). Same note as 0001_core.sql.

create table tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id) on delete cascade,

  title text not null,

  -- Never null. An unwritten brief is the empty string rather than NULL, so
  -- every reader (card, detail page, agent prompt) has something to render
  -- without a null branch - the same reasoning as token_cost/turn_count
  -- below.
  brief text not null default '',

  -- Departments a *task* can belong to. Management is deliberately absent:
  -- it sits above the three departments in the org chart, and "role slots
  -- are first-class - leads never have tasks" (docs/tasks/README.md).
  -- Widening this is one line here plus one in
  -- packages/shared/src/tasks.ts.
  department text not null check (department in ('dev', 'research', 'qa')),

  -- Opaque agent-account identifier, NOT a foreign key. There is no user
  -- table and no authentication until step 9 (docs/tasks/README.md, "What
  -- steps 1-3 deliberately leave inert"), and the design keeps office
  -- membership and agent accounts explicitly separate. `claim_task` checks
  -- this against the calling session's user. Step 9 adds the membership
  -- link; adding the FK then is a one-line migration.
  owner text not null,

  -- The ten states of the design's lifecycle diagram, snake_cased. This
  -- list and TASK_STATES in packages/shared/src/tasks.ts are the only two
  -- copies in the system, and a test
  -- (packages/server/src/tasks/states.test.ts) parses this file to assert
  -- they agree.
  --
  -- Every change to this column goes through transition() - see the
  -- triggers at the bottom of this file, which enforce that rather than
  -- trusting it.
  state text not null default 'draft' check (
    state in (
      'draft', 'pending', 'in_progress', 'paused', 'ready_for_qa',
      'ci', 'qa_review', 'lead_approval', 'delivered', 'done'
    )
  ),

  -- NULL means "use the role default from the project's model_policy" (the
  -- design's model-selection layer 1). A value is an explicit per-task
  -- choice by a lead or a human (layers 2 and 3), which is why the design
  -- pairs it with a one-line reason. Not a constrained set: "any backend
  -- can serve any role", so sonnet, opus and qwen-uni are all legal.
  model text,
  model_reason text,
  -- A reason with no choice to explain is meaningless; the pair is
  -- validated together in packages/server/src/tasks/model.ts too, so the
  -- rule holds for a task object that has never been near the database.
  constraint tasks_model_reason_requires_model
    check (model_reason is null or model is not null),

  -- `task/<id>-<slug>`, once the task branch exists. NULL until then:
  -- complete_task does not rebase, push or open a PR in steps 1-3
  -- (docs/tasks/README.md, "left inert") - branch creation is step 4's.
  branch text,

  -- Never null, default 0, so the step-3 card always has a number to
  -- render. Nothing feeds them yet: token cost has no source until step 7
  -- and renders as "not measured yet". bigint rather than integer because a
  -- token counter has no natural ceiling; note pg returns int8 as a string,
  -- which the mapper in packages/server/src/tasks/states.ts converts.
  token_cost bigint not null default 0 check (token_cost >= 0),
  turn_count integer not null default 0 check (turn_count >= 0),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- When the task entered `state`. Maintained by the trigger below and by
  -- nothing else, so "paused / 2d" on a card is one subtraction against
  -- this column and never a walk over task_state_history - the decision
  -- recorded in docs/tasks/README.md ("Cards show time in the current
  -- state... from the last transition alone"). Deliberately separate from
  -- updated_at, which also moves when a title or an owner is edited and so
  -- cannot answer "how long in this state".
  state_entered_at timestamptz not null default now()
);

-- Board queries are "every task in project X", grouped by state/column.
create index tasks_project_id_state_idx on tasks (project_id, state);

-- "Every task has an owner, and a session only claims tasks owned by its
-- user" - claim_task's first check, and the Tasks page's owner filter.
create index tasks_owner_idx on tasks (owner);

-- Every state change, with who and why. An audit answers "who advanced
-- this" from here; ticket 031's task detail page renders it; ticket 032's
-- interim "Advance (no gate yet)" control records its bypass here as an
-- ordinary transition with an actor and a reason, so nothing special is
-- needed for it.
--
-- There is no row for a task's creation: a task is born in `draft` (see
-- the insert trigger below) and history records *changes*. A task's full
-- path is therefore the first row's from_state followed by every row's
-- to_state.
create table task_state_history (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks (id) on delete cascade,
  from_state text not null,
  to_state text not null,

  -- Opaque, like tasks.owner: no user table exists yet. Recording who
  -- *claims* to have acted is this ticket's job; deciding who is *allowed*
  -- to act is step 9's.
  actor text not null check (actor <> ''),
  actor_kind text not null check (actor_kind in ('human', 'agent', 'system')),

  -- Required on the transitions where the design itself asks for one
  -- (`reject_task(task_id, reason)`, Send back "with your comment", and
  -- every route into `paused`, since Resume needs to say what interrupted
  -- the task). Enforced per-transition in states.ts, not as a blanket NOT
  -- NULL here - most edges have nothing to explain.
  reason text,

  -- Equal to the tasks.state_entered_at the change produced. The deferred
  -- constraint trigger below matches on exactly that, which is what ties a
  -- history row to its state change rather than merely hoping one was
  -- written.
  occurred_at timestamptz not null default now()
);

-- Newest-first history for one task: the pause-origin lookup in
-- transition() (a LIMIT 1, never a scan) and the detail page's timeline.
create index task_state_history_task_id_occurred_at_idx
  on task_state_history (task_id, occurred_at desc, id desc);


-- ---------------------------------------------------------------------------
-- Enforcing "transition() is the only way state changes"
-- ---------------------------------------------------------------------------
--
-- A convention that lives only in review comments is not an invariant. The
-- three triggers below make it one, at the layer every caller has to go
-- through:
--
--   1. tasks_guard_state_change  - an UPDATE may not change `state` unless
--      the transaction has opted in by setting `office.task_transition`.
--      transition() sets it with SET LOCAL (transaction-scoped, so it
--      cannot leak across a pooled connection) and clears it immediately
--      after. Any other code path - a repo function, a hand-written UPDATE,
--      a psql session - fails loudly with SQLSTATE OF001.
--   2. tasks_guard_insert_state  - a task is born in `draft` and nowhere
--      else, so the machine cannot be side-stepped by inserting a row
--      already in `done` (SQLSTATE OF003). "Nothing runs until a human says
--      so": the only way into `pending` is Start working, an edge on the
--      diagram.
--   3. tasks_state_history_required - a DEFERRED constraint trigger: at
--      COMMIT, every state change in the transaction must have a matching
--      task_state_history row (SQLSTATE OF002). Deferred so insert order
--      inside the transaction does not matter; matching on
--      (from, to, occurred_at) so it is the *same* change, not any old row.
--      This is what makes "state and its audit row move together, or
--      neither does" structural.
--
-- The custom SQLSTATEs (class OF, outside every standard class) let tests
-- and callers distinguish these three from an ordinary constraint
-- violation.

create or replace function tasks_guard_state_change() returns trigger
language plpgsql as $$
begin
  -- Every UPDATE touches updated_at; only a state change touches
  -- state_entered_at. clock_timestamp(), not now(): now() is fixed for the
  -- whole transaction, and two transitions in one transaction must not
  -- share a timestamp (see the history check below).
  new.updated_at := clock_timestamp();

  if new.state is distinct from old.state then
    if coalesce(current_setting('office.task_transition', true), '') <> 'on' then
      raise exception using
        errcode = 'OF001',
        message = 'tasks.state may only be changed by transition()',
        detail = format(
          'attempted %L -> %L on task %s outside a transition',
          old.state, new.state, old.id
        ),
        hint = 'Call transition() in packages/server/src/tasks/states.ts; '
               'it is the only code that sets office.task_transition.';
    end if;
    new.state_entered_at := clock_timestamp();
  end if;

  return new;
end;
$$;

create trigger tasks_guard_state_change
  before update on tasks
  for each row execute function tasks_guard_state_change();

create or replace function tasks_guard_insert_state() returns trigger
language plpgsql as $$
begin
  if new.state <> 'draft'
     and coalesce(current_setting('office.task_transition', true), '') <> 'on' then
    raise exception using
      errcode = 'OF003',
      message = 'a task is created in state ''draft'' and moved by transition()',
      detail = format('attempted to insert task %s directly in state %L', new.id, new.state),
      hint = 'Build the row with createTask() in packages/server/src/tasks/model.ts, '
             'then transition() it.';
  end if;
  return new;
end;
$$;

create trigger tasks_guard_insert_state
  before insert on tasks
  for each row execute function tasks_guard_insert_state();

create or replace function tasks_require_state_history() returns trigger
language plpgsql as $$
declare
  matching integer;
begin
  if new.state is distinct from old.state then
    select count(*) into matching
    from task_state_history h
    where h.task_id = new.id
      and h.from_state = old.state
      and h.to_state = new.state
      and h.occurred_at = new.state_entered_at;

    -- "at least one", not "exactly one": two transitions of the same task
    -- in one transaction get distinct clock_timestamp() values in practice,
    -- but a tie would turn a correct pair of rows into a spurious failure
    -- at COMMIT. The property worth enforcing is that the audit row exists,
    -- not that timestamps never collide.
    if matching = 0 then
      raise exception using
        errcode = 'OF002',
        message = 'a task state change must write a task_state_history row in the same transaction',
        detail = format(
          'task %s moved %L -> %L at %s with no matching history row',
          new.id, old.state, new.state, new.state_entered_at
        );
    end if;
  end if;
  return null;
end;
$$;

create constraint trigger tasks_state_history_required
  after update on tasks
  deferrable initially deferred
  for each row execute function tasks_require_state_history();
