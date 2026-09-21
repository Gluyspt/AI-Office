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

## Open questions

- [ ] The design says "The orchestrator refuses `start_session` while paused" — the pause flag does not exist until ticket 028. The check point is stubbed here with a comment naming ticket 028.
- [ ] Per-project session caps are mentioned ("enforce per-project caps") but no default is given. Cap enforcement lands in ticket 018 with the MCP tool; this ticket leaves a hook for it.
- [ ] The design does not say who may kill a session belonging to another user. In step 1 there is one user, so this is deferred to step 9 (roles) — recorded so the API is not assumed safe to expose publicly.
- [ ] Whether a message sent to a mid-turn agent is queued by us or by tmux depends on ticket 003. If we queue, the queue must survive an orchestrator restart — decide and state it.
