---
id: "020"
title: PreToolUse ownership guard
build_step: 2
department: dev
estimated_model: opus
blocked_by: ["002", "009", "015"]
---

# 020 — PreToolUse ownership guard

**Build step:** 2 — Coordination
**Department:** dev
**Estimated model:** opus — it sits on the hot path of every tool call, and its failure mode has to be chosen deliberately.
**Blocked by:** 002, 009, 015

## Why

The registry refuses overlapping *claims*; this guard refuses overlapping *edits*. It is the last line
between two agents and a git conflict, and the design's only mechanism that catches an agent editing a
file outside its declared scope.

It is also the ticket most exposed to ticket 002's finding, since the design's blocking mechanism
("exit with code 2") and its transport (`"type": "http"`) do not obviously fit together.

## Scope

### Files created

- `hooks/pretooluse-guard.sh` — the guard script: read the payload, ask the orchestrator with a short timeout, exit 2 with feedback on refusal, buffer to disk on failure. Read-only, owned by `office`, mode 755, per the design
- `config/hooks/fragments/pretooluse-guard.json` — the hook entry, merged by ticket 009's provisioner
- `packages/server/src/routes/guard.ts` — `POST /guard/check` and `POST /guard/flush`
- `packages/server/src/locks/guard-check.ts` — decision logic over ticket 015's registry, plus the heartbeat refresh
- `packages/server/src/locks/unguarded-edits.ts` — ingest a flushed buffer, check retroactively whether any unguarded edit touched a file owned by a different active task, flag those tasks for review
- `packages/server/src/events/handlers/tool.ts` — records tool events and refreshes the lock heartbeat
- `db/migrations/0010_unguarded_edits.sql` — the unguarded-edit log and the review flag on tasks

### Files modified

None.

## Acceptance criteria

- [ ] An agent editing a file owned by another active task is blocked, and the feedback it receives names the owning task and its owner.
- [ ] An agent editing a file inside its own declared scope proceeds with no visible delay.
- [ ] An agent editing a file owned by **nobody** proceeds — the guard enforces the registry, it does not require every file to be claimed. A test covers this explicitly, since the opposite behaviour would stop all work.
- [ ] Read-only tools are never blocked; only mutating tools are checked, and the checked list is enumerated in one place.
- [ ] **The check times out at ~2 s.** An agent never hangs waiting on an unreachable orchestrator; the timeout is config, and a test with a stalled endpoint asserts the agent proceeds.
- [ ] **On a failed check the guard fails open and appends the attempted edit to a local buffer file.** It cannot POST a warning when the orchestrator is down, so it buffers on disk — asserted with the server stopped.
- [ ] **The buffer flushes on the next successful check**, and is cleared only after the orchestrator acknowledges it.
- [ ] **On receiving a flush, the orchestrator checks retroactively** whether any unguarded edit touched a file owned by a different active task, and flags those tasks for review. Asserted end to end: stop the server, have an agent edit a file owned by another task, restart, and confirm both tasks are flagged.
- [ ] A flush that arrives twice does not double-flag; flushes are idempotent by edit id.
- [ ] Guard degradation and recovery are emitted as events, so the UI can show a degraded-guard banner while checks are failing and list the unguarded edits afterwards.
- [ ] The buffer file is written under a path owned by `office`, is size-capped, and drops oldest-first with a recorded count rather than growing without bound.
- [ ] Guard latency is measured under 100 sequential tool calls and recorded; the number appears in the ticket's completion summary.
- [ ] The heartbeat refresh keeps a lock alive across a long-running task — a test with a short TTL asserts the lock never expires while tools are being used.
- [ ] The guard script passes `shellcheck` and never interpolates payload text into a shell command.
- [ ] The script does not read or log file contents, only paths.

## Decided

**Fail open, but never silently.** An unreachable orchestrator must not freeze every agent on the box, so the edit proceeds — and the guard buffers it to disk, flushes on recovery, and the orchestrator then works out retroactively whether anything was actually violated. During an outage the protection degrades to `claim_task` alone; afterwards, the damage is enumerated rather than guessed at.

## Open questions

- [ ] The retroactive check finds conflicts after the fact, when both agents may have already edited. It flags for review; it cannot undo. Whether a flagged task should also be paused automatically is unaddressed by the design — not implemented, because auto-pausing on a stale signal is its own failure mode.
- [ ] **The blocking mechanism depends entirely on ticket 002.** If an http hook can block, the script may be unnecessary and the fragment points straight at the event server. If it cannot, the command script is the only path and its per-call latency becomes a real cost. This ticket's scope assumes the script; drop it if 002 says otherwise.
- [ ] The design lists `PostToolUse` as the heartbeat trigger but does not include it in its hook config block. This ticket registers it in the fragment. If that is wrong, the heartbeat has no source and ticket 015's TTL will expire live locks.
- [ ] What the guard should do about a tool call that mutates a file *outside* the repo (a global config, a temp file) is unspecified. Currently allowed; worth revisiting once agents run unattended.
- [ ] The design notes hooks run shell commands on a box holding three people's logins, and says to read every hook script before installing. That review is a human step this ticket cannot self-certify — request it explicitly at completion.
