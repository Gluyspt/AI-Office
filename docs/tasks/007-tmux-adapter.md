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

- `packages/server/src/features/orchestrator/tmux.ts` — `newSession`, `sendKeys`, `sendLiteral`, `sendEscape`, `killSession`, `hasSession`, `listSessions`, each shelling out through `sudo -u <user> tmux`
- `packages/server/src/features/orchestrator/naming.ts` — deterministic session names from (project, role, dept, owner), with collision handling
- `packages/server/src/features/orchestrator/shell-quote.ts` — argument construction and the message-delivery encoding chosen in ticket 003
- `deploy/host/sudoers.d/office` — the scoped sudoers file from the design, with a comment per line

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
- [ ] `deploy/host/sudoers.d/office` passes `visudo -c -f`.
- [ ] The adapter never runs as root, and never passes a user-supplied value as the `sudo -u` target — the target comes from the session registry only. A test asserts the rejection of an unknown user.

- [ ] **The VPS re-measurement is run and recorded.** `spikes/tmux/drive-session.sh` is executed on the
      target VPS as the `office` user, and its TSV output replaces the DEFERRED sections of
      `docs/spikes/002-tmux-tui-control.md`: delivery reliability for idle / mid-turn / permission-prompt
      states at 20 trials each, `Escape` interrupt timing, the character round-trip matrix, whether
      `kill-session` fires SessionEnd, per-agent RSS both idle and mid-turn, and `sudo -u` parity for
      `$HOME`, `CLAUDE_CONFIG_DIR` and the tmux socket.

## Decided

- **This ticket owns ticket 003's deferred measurements.** 003 built the harness but deliberately took
  no readings: the only machine available was Windows with a WSL2 Ubuntu, and timings against a WSL2
  kernel, RSS against WSL2 memory accounting, and `sudo -u` on a host where sudo demands a password
  would all have been wrong in ways that stop being visible once copied into this adapter. No ticket in
  steps 1–3 sets up the VPS, so the criterion lands here — 007 is the first ticket that needs a real
  Linux host and it already owns `deploy/host/sudoers.d/office`.
- **Three criteria above currently have no source.** "Every character class from ticket 003's
  findings", "using the mechanism that spike recorded", and "state the measured limit in a code
  comment" all cite measurements that do not exist yet. They are not satisfiable until the
  re-measurement runs — which is precisely why it is an acceptance criterion of this ticket and not a
  footnote somewhere.
- **The provisional idle RSS figure is not a substitute.** WSL measured ≈0.26 GB per idle agent, but the
  previous Claude Code build measured 0.57–0.58 GB on the same machine — 2× apart, neither from the
  target. Ticket 018's cap must not be set from it.

- **`tmux has-session` is not a readiness signal.** Source: `docs/spikes/002-tmux-tui-control.md`. A first launch in an unseen
  directory raises a folder-trust dialog, and a fresh install raises onboarding modals; the session
  exists and reports alive while the TUI is blocked behind them. The criterion above that `hasSession`
  reports within 2 s therefore proves the *session* started, not that the agent can receive a message.
  `newSession` must confirm the composer is up — not merely that tmux has a session — before anything
  sends a brief, or the first message answers a dialog.
- **`load-buffer` + `paste-buffer` is not safe for multi-line text.** With an embedded newline it
  submitted early: `line one` was sent as a turn and `line two` was left in the composer — half a
  message, delivered and answered, no error raised. `send-keys`, `send-keys -l` and `paste-buffer -p`
  all kept it as a draft. Use one of those; the plain form is a correctness bug, not a style choice.
- **The tmux buffer limit is not observable from the pane.** Pastes of roughly 1000 characters or more
  collapse to `[Pasted text #N]` in the rendered pane, so the criterion above asking for the measured
  limit in a code comment cannot be satisfied by scraping — it needs the harness's own instrumentation.

## Open questions

- [ ] The design's sudoers example lists `gluy`, `user2`, `user3`. The actual account names, and whether they exist on the target VPS, are not settled — the design's own open question "Who owns which department by default?" overlaps this. The file ships with the design's example names and a header comment saying it must be regenerated per host.
- [ ] Granting `NOPASSWD: /usr/bin/tmux` in full lets `office` run `tmux new-session` with **any** command as those users. The design accepts this; note that a tighter rule would need a wrapper script. Not changing it here, but recording it as a deliberate choice rather than an oversight.
- [ ] **Should the Claude Code CLI version be pinned on the VPS?** Source: `docs/spikes/002-tmux-tui-control.md`. The binary
      auto-updated 2.1.178 to 2.1.278 *during* the spike, and the new build added a blocking modal that
      held the prompt indefinitely. The TUI changed under a running experiment with nothing deployed.
      Anything that scrapes or drives the pane breaks silently when that happens. New question, raised
      by 003.
- [ ] Whether the orchestrator or tmux owns the queue for mid-turn messages depends on ticket 003's finding. This ticket exposes both `sendKeys` and `sendLiteral` and leaves the queueing decision to ticket 008.
