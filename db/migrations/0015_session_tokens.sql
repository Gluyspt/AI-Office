-- 0015_session_tokens.sql
--
-- The per-session secret an MCP tool call presents to say which desk it is
-- (GLU-55, forced by spike 003 §3.2).
--
-- WHY THIS EXISTS AT ALL
-- ---------------------
-- Until this file, the only secret the office minted was ticket 009's
-- `HOOK_INGEST_TOKEN`, which is per *Linux account*. The settled design is
-- one Linux user per **teammate**, not per agent, so one account hosts
-- several desks at once — and `claim_task` "checks owner match". With an
-- account-scoped token every desk belonging to one teammate presents the
-- same identity, so the task server cannot tell a dev-lead from a worker on
-- the same account and "owner match" silently degrades to "same teammate".
-- That is not the check the design asks for, and the failure is silent: the
-- wrong desk claiming a task looks exactly like the right one.
--
-- The token travels: minted here at spawn -> the pane environment as
-- OFFICE_SESSION_TOKEN -> expanded by Claude Code into the role file's
-- `mcpServers.headers` -> read off the request by the orchestrator. The
-- model never sees it and there is no tool-call shape that changes it.
--
--
-- WHY A HASH AND NOT THE TOKEN
-- ----------------------------
-- Nothing ever needs to read the token back. It is handed to exactly one
-- process, once, at spawn; verification only ever asks "does the presented
-- string hash to a live desk's stored hash?". So the column holds
-- sha-256 hex and a database read yields no working credential — the same
-- reason a password column holds a hash. The check constraint makes storing
-- the plaintext here fail loudly instead of silently working.
--
--
-- WHY THERE IS NO `revoked_at`
-- ----------------------------
-- The spike's requirement is that the token stop working when the session
-- ends, "otherwise a killed desk's token still claims tasks". A
-- `revoked_at` column would be a second source of truth that four call
-- sites (kill, SessionEnd, the hook-gate failure path, the spawn-failure
-- path) must all remember to write, and the symptom of forgetting one is a
-- dead desk that can still claim work.
--
-- Instead validity is DERIVED: the verifier joins this row and requires
-- `status in ('starting','running')`, which is the same definition of
-- "live" the two partial unique indexes in 0003 already use. Ending a
-- session invalidates its token by construction, with no second write to
-- forget. `starting` counts as live deliberately — an agent's MCP servers
-- connect at startup, before the hook gate has promoted the row, and
-- refusing those calls would park a desk for a reason it cannot act on.
--
--
-- MIGRATION ORDERING: this is the highest-numbered file in the directory,
-- so unlike 0003, 0010 and 0011 it runs last in both orders and needs no
-- hazard note beyond this one. It references only `sessions` (0003).

alter table sessions
  add column token_hash text;

-- sha-256 hex, lowercase. Not merely documentation: it is what makes
-- "somebody stored the plaintext token here" a constraint violation at the
-- insert rather than a secret sitting in the database for a year.
alter table sessions
  add constraint sessions_token_hash_is_sha256
  check (token_hash is null or token_hash ~ '^[0-9a-f]{64}$');

-- The verification lookup, and the uniqueness that makes a hash collision
-- (or a repeated mint) a loud failure rather than two desks sharing an
-- identity. Partial because null is the normal state for rows started
-- before this migration, and null is never the thing being looked up.
create unique index sessions_token_hash
  on sessions (token_hash)
  where token_hash is not null;

comment on column sessions.token_hash is
  'sha-256 hex of this desk''s per-session MCP credential (GLU-55). Never the token itself. Validity is derived from status, not from a revocation flag — see 0015_session_tokens.sql.';
