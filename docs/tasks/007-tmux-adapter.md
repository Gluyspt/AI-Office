---
id: "007"
title: tmux adapter and scoped sudoers
build_step: 1
department: dev
estimated_model: opus
blocked_by: ["003", "004"]
---

# 007 — tmux adapter and scoped sudoers

**Build step:** 1 — Spine
**Department:** dev
**Estimated model:** opus — cross-user process control with untrusted text going into a shell command; the escaping rules decide whether the whole system is safe.
**Blocked by:** 003, 004

## Why

This is the layer that actually starts, addresses and stops agents. It is also the only place in the
system where text written by a human in a browser reaches a shell command running as another Linux
user. Everything above it — the session registry, chat, interrupt, pause — is a caller of these four
functions.

## Scope

### Files created

- `packages/server/src/orchestrator/tmux.ts` — `newSession`, `sendKeys`, `sendLiteral`, `sendEscape`, `killSession`, `hasSession`, `listSessions`, each shelling out through `sudo -u <user> tmux`
- `packages/server/src/orchestrator/naming.ts` — deterministic session names from (project, role, dept, owner), with collision handling
- `packages/server/src/orchestrator/shell-quote.ts` — argument construction and the message-delivery encoding chosen in ticket 003
- `deploy/sudoers.d/office` — the scoped sudoers file from the design, with a comment per line

### Files modified

None.

## Acceptance criteria

- [ ] `newSession` starts a detached tmux session as the target user with `CLAUDE_CONFIG_DIR` and the project working directory set, and `hasSession` reports it within 2 s.
- [ ] Commands are built as **argument arrays**, never by string interpolation into a shell line. A test asserts that a message containing `; rm -rf ~` reaches the agent as literal text and executes nothing.
- [ ] Every character class from ticket 003's findings (double quote, single quote, backtick, dollar, semicolon, newline, non-ASCII) round-trips into the agent's prompt intact, using the mechanism that spike recorded.
- [ ] A message longer than the tmux buffer limit is delivered whole or fails loudly — never truncated silently. State the measured limit in a code comment.
- [ ] `sendEscape` halts a mid-turn agent and leaves the session alive, verified by `hasSession` afterwards.
- [ ] `killSession` on a non-existent session returns a typed "not found" result rather than throwing.
- [ ] Session names are stable across restarts for the same inputs, and two projects with the same role and owner produce different names — asserted by a table-driven test.
- [ ] Every tmux invocation has a timeout; a hung `sudo` rejects rather than leaking a process. Verified with a stub binary that sleeps.
- [ ] `deploy/sudoers.d/office` passes `visudo -c -f`.
- [ ] The adapter never runs as root, and never passes a user-supplied value as the `sudo -u` target — the target comes from the session registry only. A test asserts the rejection of an unknown user.

## Open questions

- [ ] The design's sudoers example lists `gluy`, `user2`, `user3`. The actual account names, and whether they exist on the target VPS, are not settled — the design's own open question "Who owns which department by default?" overlaps this. The file ships with the design's example names and a header comment saying it must be regenerated per host.
- [ ] Granting `NOPASSWD: /usr/bin/tmux` in full lets `office` run `tmux new-session` with **any** command as those users. The design accepts this; note that a tighter rule would need a wrapper script. Not changing it here, but recording it as a deliberate choice rather than an oversight.
- [ ] Whether the orchestrator or tmux owns the queue for mid-turn messages depends on ticket 003's finding. This ticket exposes both `sendKeys` and `sendLiteral` and leaves the queueing decision to ticket 008.
