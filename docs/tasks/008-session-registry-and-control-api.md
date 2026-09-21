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

- `packages/server/src/orchestrator/sessions.ts` — `startSession`, `messageSession`, `interruptSession`, `killSession`, `getSession`, `listSessions`; owns the session state machine and the message queue if ticket 003 showed tmux cannot be trusted with it
- `packages/server/src/routes/sessions.ts` — `POST /sessions`, `POST /sessions/:id/message`, `POST /sessions/:id/interrupt`, `DELETE /sessions/:id`, `GET /sessions`, `GET /sessions/:id`
- `packages/shared/src/sessions.ts` — session record, role enum, backend enum, status enum
- `db/migrations/0003_sessions.sql` — `sessions` table: id, project_id, tmux_name, role, dept, owner, backend, model, model_reason, status, started_at, ended_at, claude_session_id

### Files modified

None.

## Acceptance criteria

- [ ] `POST /sessions` inserts the row **before** spawning tmux, so a spawn that crashes still leaves a record with status `failed` and the error attached.
- [ ] Session status follows `starting → running → ended`, plus `failed`; an illegal transition is rejected by a typed error and covered by a test per illegal pair.
- [ ] `POST /sessions/:id/message` delivers to a running session and returns 409 for one that has ended.
- [ ] `POST /sessions/:id/interrupt` returns within 2 s and leaves the session `running`.
- [ ] `DELETE /sessions/:id` kills the tmux session and marks the row `ended`; a second call is idempotent and returns 200.
- [ ] A SessionStart event arriving from ticket 005 updates the matching row with `claude_session_id`, using the correlation mechanism ticket 002 identified.
- [ ] A SessionEnd event marks the row `ended` even when the kill came from outside the orchestrator (someone ran `tmux kill-session` by hand).
- [ ] Starting two sessions with identical (project, role, dept, owner) either reuses the existing one or fails with a clear conflict — pick one, state which in the ticket comment, and test it.
- [ ] Every control action writes an event through ticket 005's ingest so it appears on the WebSocket stream — a test asserts an interrupt is visible to a subscribed client.
- [ ] `startSession` records `model` and `model_reason` on the row; a request without a reason is rejected, because the Spawn feed in a later step depends on the reason always being present.

- [ ] **A spawned session is not `running` until its hooks are proven to reach ingest.** After
      starting tmux, the registry waits for that `session_id`'s first event (`SessionStart`) within a
      configured timeout; if none arrives, the row is marked `failed` with a reason naming hook
      delivery — never `running`. Rationale, from spike 002: the https-everywhere decision means an
      agent launched without `NODE_EXTRA_CA_CERTS` in its environment **works perfectly and is
      completely invisible to the orchestrator** — every hook fails the TLS handshake, no event
      arrives, and nothing crashes. A desk that looks healthy and reports nothing is the worst failure
      shape in the system; this converts it into a loud, specific refusal at the only moment anyone is
      watching. The same check catches a forgotten hook config, an expired certificate, and an event
      server that is simply down.
- [ ] **The failure reason distinguishes "no event at all" from "handshake rejected"** where ticket
      005's TLS logging makes that distinction available, because the remedies differ: a missing env
      var in provisioning versus a certificate that needs reissuing.

- [ ] **`POST /sessions/:id/message` refuses to deliver while a permission dialog is up**, returning
      a typed refusal naming the pending tool call rather than sending keys. Spike 003 measured the
      alternative: a perfectly ordinary chat message delivered into a waiting dialog **approves it**,
      3/3 — the dialog ignores the text and the trailing `Enter` selects the highlighted `1. Yes`. The
      approved command ran and left a file on disk. This is exactly the outcome the design's "do not
      build keystroke injection to answer permission prompts" rule exists to prevent, reached through
      the *ordinary chat path*, with no injection feature anywhere in the system. A queued message must
      wait for the dialog to clear, or be refused — never delivered blind.
- [ ] **Busy/idle is not read from the pane's `esc to interrupt` marker.** That marker clears
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

**Still unknown, and this ticket must not assume otherwise:** whether tmux can be trusted to hold a
mid-turn message queue. Ticket 003 deferred that measurement and 007 now owns it. Until it is answered,
do not build on tmux queueing — if the orchestrator must own the queue, it needs to survive a restart,
which is a schema change rather than a refactor.

## Open questions

- [ ] The design says "The orchestrator refuses `start_session` while paused" — the pause flag does not exist until ticket 028. The check point is stubbed here with a comment naming ticket 028.
- [ ] Per-project session caps are mentioned ("enforce per-project caps") but no default is given. Cap enforcement lands in ticket 018 with the MCP tool; this ticket leaves a hook for it.
- [ ] The design does not say who may kill a session belonging to another user. In step 1 there is one user, so this is deferred to step 9 (roles) — recorded so the API is not assumed safe to expose publicly.
- [ ] Whether a message sent to a mid-turn agent is queued by us or by tmux depends on ticket 003. If we queue, the queue must survive an orchestrator restart — decide and state it.
