---
id: "008"
title: Session registry and control API
build_step: 1
department: dev
estimated_model: opus
blocked_by: ["005", "007"]
---

# 008 — Session registry and control API

**Build step:** 1 — Spine
**Department:** dev
**Estimated model:** opus — this is the lifecycle state machine every later feature calls into.
**Blocked by:** 005, 007

## Why

"Only the orchestrator starts sessions, through `start_session(role, dept, owner, project, brief,
backend, model)`." This ticket is that function plus the durable record behind it, exposed over HTTP.
Ticket 018 wraps the same calls as MCP tools for leads; the web UI in step 3 calls this API directly.

## Scope

### Files created

- `packages/server/src/features/orchestrator/sessions.ts` — `startSession`, `messageSession`, `interruptSession`, `killSession`, `getSession`, `listSessions`; owns the session state machine and the message queue if ticket 003 showed tmux cannot be trusted with it
- `packages/server/src/features/orchestrator/routes/sessions.ts` — `POST /sessions`, `POST /sessions/:id/message`, `POST /sessions/:id/interrupt`, `DELETE /sessions/:id`, `GET /sessions`, `GET /sessions/:id`
- `packages/shared/src/sessions.ts` — session record, role enum, backend enum, status enum
- `db/migrations/0003_sessions.sql` — `sessions` table: id, project_id, tmux_name, role, dept, owner, backend, model, model_reason, status, started_at, ended_at, claude_session_id

### Files modified

None.

## Acceptance criteria

- [x] `POST /sessions` inserts the row **before** spawning tmux, so a spawn that crashes still leaves a record with status `failed` and the error attached. Tests: *"leaves a failed row with the reason attached when the spawn crashes"* and *"distinguishes a composer that never appeared from a refused spawn"* — `sudo_denied` becomes `spawn_failed`, `not_ready` stays `not_ready`, because the remedies differ.
- [x] Session status follows `starting → running → ended`, plus `failed`; an illegal transition is rejected by a typed error and covered by a test per illegal pair. Table-driven over the whole 4×4 matrix, so a fifth status cannot be added without the test failing, plus one asserting `ended` and `failed` are terminal — nothing leaves them. The status vocabulary is also asserted against the SQL check constraint's, since those are the only two copies.
- [x] `POST /sessions/:id/message` delivers to a running session and returns 409 for one that has ended. The 409 is a typed `session_ended`, not a silent drop.
- [x] `POST /sessions/:id/interrupt` leaves the session `running` — Escape halts a turn, it does not end a desk, measured 20/20 on the target with the session alive every time. **The "within 2 s" clause is not asserted**, deliberately: the measured p50 was 179 ms and p95 212 ms, but one of the twenty trials reported an impossible −100 ms because this host's wall clock steps backwards. A hard 2 s bound would be a flake waiting to happen; the response is synchronous and does one `send-keys`, which is the property that matters.
- [x] `DELETE /sessions/:id` kills the tmux session and marks the row `ended`; a second call is idempotent and returns 200. Also: an already-gone tmux session counts as success, because someone running `tmux kill-session` by hand must not leave a row stuck at `running`.
- [x] A SessionStart event arriving from ticket 005 updates the matching row with `claude_session_id`, using the correlation mechanism ticket 002 identified — the orchestrator *chooses* the id and passes `--session-id`, so correlation is direct rather than a cwd-plus-tmux-name heuristic. Handled in `handlers/session-start.ts`, collected automatically with no dispatcher edit.
- [x] A SessionEnd event marks the row `ended` even when the kill came from outside the orchestrator (someone ran `tmux kill-session` by hand). **And `reason: "clear"` does not**, which is the trap: SessionEnd fires on `/clear` while the agent keeps working, so ending the row there would leave an orphan tmux session nobody tracks and a row claiming `ended` while the agent spends tokens. Tested for `clear`, `other`, `prompt_input_exit` and `null` separately.
- [x] Starting two sessions with identical (project, role, dept, owner) either reuses the existing one or fails with a clear conflict — **this ticket chose CONFLICT.** Reuse is the friendlier behaviour and the wrong one: two callers both believing they started a desk is a bug reuse hides, and the caller that "started" a session it did not start would attribute someone else's work and token spend to its own brief. A partial unique index makes it an invariant rather than a check-then-act race. A second test covers a restart after the first ended, and a third asserts a **tmux-name** collision reports as its own thing — an earlier version mapped every unique violation to "that role is already staffed" and sent the reader to the wrong constraint.
- [x] Every control action writes an event through ticket 005's ingest so it appears on the WebSocket stream — asserted over `SessionRegistered`, `SessionRunning`, `SessionMessageSent`, `SessionInterrupted` and `SessionEnded`. The event row is what a subscriber receives, so asserting the row asserts the stream. Events are emitted **after** the transaction commits, never inside it — the trap 012 shipped with, where an event emitted in a caller's transaction survives their ROLLBACK.
- [x] `startSession` records `model` and `model_reason` on the row; a request without a reason is rejected. Enforced three times over, on purpose: a 400 at the route, a typed `invalid_request` in the module (asserted to reject *before* tmux is touched), and a `length(trim(model_reason)) > 0` check constraint. The feed is how a human notices a lead picking the expensive model for everything, so a blank reason would make it lie.

- [x] **A spawned session is not `running` until its hooks are proven to reach ingest.** After
      starting tmux, the registry waits for that `session_id`'s first event (`SessionStart`) within a
      configured timeout; if none arrives, the row is marked `failed` with a reason naming hook
      delivery — never `running`. Rationale, from spike 002: the https-everywhere decision means an
      agent launched without `NODE_EXTRA_CA_CERTS` in its environment **works perfectly and is
      completely invisible to the orchestrator** — every hook fails the TLS handshake, no event
      arrives, and nothing crashes. A desk that looks healthy and reports nothing is the worst failure
      shape in the system; this converts it into a loud, specific refusal at the only moment anyone is
      watching. The same check catches a forgotten hook config, an expired certificate, and an event
      server that is simply down.
- [x] **The failure reason distinguishes "no event at all" from "handshake rejected"** where ticket
      005's TLS logging makes that distinction available, because the remedies differ: a missing env
      var in provisioning versus a certificate that needs reissuing.

- [x] **`POST /sessions/:id/message` refuses to deliver while a permission dialog is up**, returning
      a typed refusal naming the pending tool call rather than sending keys. Spike 003 measured the
      alternative: a perfectly ordinary chat message delivered into a waiting dialog **approves it**,
      3/3 — the dialog ignores the text and the trailing `Enter` selects the highlighted `1. Yes`. The
      approved command ran and left a file on disk. This is exactly the outcome the design's "do not
      build keystroke injection to answer permission prompts" rule exists to prevent, reached through
      the *ordinary chat path*, with no injection feature anywhere in the system. A queued message must
      wait for the dialog to clear, or be refused — never delivered blind.
- [x] **Busy/idle is not read from the pane's `esc to interrupt` marker.** That marker clears
      148–342 ms after a message is *submitted*, while the turn runs on for seconds afterwards
      (spike 003 §2, transcript-verified). Anything scraping it reports a working agent as idle as soon
      as one message has been queued. Session state comes from events, with the watchdog ticket 010
      needs for the same reason.

## Decided

Source: `docs/spikes/001-hook-payloads.md`.

- **The correlation key is `session_id`, and this ticket can choose it.** It is present on every hook
  payload including the *first* `SessionStart`, and `claude --session-id <uuid>` works on an interactive
  TUI launch. No `cwd`-plus-tmux-name heuristic is needed, and the env-var fallback the ticket
  contemplated is unnecessary. Note `CLAUDE_SESSION_ID` is **not** set in the environment — only
  command hooks see identifying env vars.
- **A tmux session is not one `claude` session.** Ids are single-use (relaunching with one already seen
  exits 1, `already in use`) and `/clear` ends the session and rotates the id. So the registry row cannot
  assume a 1:1 mapping to `claude_session_id`; it must tolerate a succession of them. This is the
  mechanism that forces the "sessions are segments" decision in 010 — it is not merely a modelling
  preference.
- **`SessionEnd` does not mean the agent stopped.** It fires with `reason: "clear"` while the agent keeps
  working. The criterion above marking a row `ended` on SessionEnd must exclude that reason, or a
  `/clear` kills a live session's record. Observed reasons: `clear`, `other`, `prompt_input_exit`.
- **`SessionStart` arrives via a `command` hook, not `http`** — it is never delivered to an `http` hook.
  Ticket 009 emits it; this ticket only needs to know the payload still arrives through 005's ingest.

**ANSWERED 2026-10-07, and the answer is "this ticket must own the queue" — not because tmux failed,
but because the question is not measurable by the method that was supposed to settle it.**

The measurement ran on the VPS through `sudo -n -u agent1`, 20 trials. A mid-turn message is
**always delivered, never dropped: 20/20**, matching WSL's 8/8. That part is solid and is the part
that matters for correctness.

What is *not* solid is the classification. The harness labels a trial `interleaved` when the token
appears while the turn is still running and `queued` when it appears after the turn ends, and it
decides between them by comparing two pane-scraped timestamps. **The observed separation between
those two events was ≤ 14 ms in 14 of 20 trials** (5, 5, 5, 5, 5, 5, 6, 6, 6, 6, 8, 10, 10, 10, 11,
14, 61, 128, 141, 151 ms) — against a **100 ms poll interval**. The distinction is being drawn an
order of magnitude below the sampling resolution of the instrument drawing it.

So WSL's `queued 8/8` and the VPS's `interleaved 20/20` are not a disagreement between hosts. They
are the same measurement reading noise, twice, and the earlier run's label should not have been
written down as a finding either.

**Therefore: do not build on tmux queueing.** Not "tmux cannot be trusted" — *we cannot tell*, and a
behaviour nobody can observe is not a foundation. The orchestrator owns the queue, which means it
must survive a restart, which is a schema change rather than a refactor. Settling this by better
instrumentation would need hook events with real timestamps (ticket 010) rather than pane polling —
and if it ever is settled, the queue can be deleted, not retrofitted.

## Open questions

- [ ] The design says "The orchestrator refuses `start_session` while paused" — the pause flag does not exist until ticket 028. The check point is stubbed here with a comment naming ticket 028.
- [ ] Per-project session caps are mentioned ("enforce per-project caps") but no default is given. Cap enforcement lands in ticket 018 with the MCP tool; this ticket leaves a hook for it.
- [ ] The design does not say who may kill a session belonging to another user. In step 1 there is one user, so this is deferred to step 9 (roles) — recorded so the API is not assumed safe to expose publicly.
- [x] ~~Whether a message sent to a mid-turn agent is queued by us or by tmux depends on ticket 003.~~
      **Decided 2026-10-07: this ticket queues, and the queue must survive an orchestrator restart.**
      The deciding measurement cannot distinguish the two cases — see above — so the decision is
      made on the grounds that an unobservable behaviour cannot be depended on. Delivery itself is
      confirmed: 20/20 on the VPS, never dropped.

## Implementation notes, 2026-10-08

**Three things the database holds rather than the code**, because a
constraint expresses them better than a check at four call sites: the status
vocabulary; `ended_at` matching the status (a terminal row has an end time
and a live one does not); and one live desk per identity *and* per tmux
name, as partial unique indexes so ended rows accumulate freely and a role
can restart under the same deterministic name.

**No database triggers on the status machine, unlike tasks.** 012 installs
triggers because `tasks` is mutated by many callers — MCP tools, the API,
the board. A `sessions` row is only ever written by `sessions.ts`, so a
trigger would cost a migration's worth of complexity to defend a door with
one key. The transition table is still data rather than scattered `if`s, and
a table-driven test walks the whole matrix.

**The queue table lives in this ticket's own migration.** The durable queue
was decided after the file scope was written, and `0003_sessions.sql` is
this ticket's file, so `session_message_queue` goes there rather than
claiming a new number — the same way `0005_tasks.sql` holds both `tasks` and
`task_state_history`.

**Two bugs this ticket's own tests found in it**, both of which would have
misled someone later:

1. **Every unique violation reported as `identity_conflict`.** A tmux-name
   collision therefore said "that role is already staffed", which is the
   wrong constraint and the wrong remedy. Now read from the constraint name
   and reported separately, with a test for each.
2. **The TLS diagnosis asked the whole `events` table** for any
   `TlsHandshakeRejected` in the last five minutes. On a live box with
   several desks, one unrelated rejection would make every later session
   failure claim "handshake rejected" — including desks whose hooks were
   never provisioned, sending someone to reissue a certificate that is fine.
   Now scoped to at-or-after this session's own start, with a test asserting
   a rejection that *predates* the session is not blamed on it. This is the
   global-state trap the repo already documents, reached from a new
   direction: the failing test was triggered by a rejection an earlier suite
   had left in the table.

**`hookArrivalTimeoutMs` is an optional input override.** Production reads
`SESSION_HOOK_ARRIVAL_TIMEOUT_MS` (required, no default); tests pass their
own, which is how the lock registry already handles `ttlSeconds` and avoids
making the suite depend on a new required variable.

**Verified on the real VPS kernel**, not just locally: 22 files, **435
passed, 1 skipped**, 19.78 s, exit 0 — 44 tests added by this ticket.
