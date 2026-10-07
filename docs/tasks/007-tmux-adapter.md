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
- [x] `deploy/host/sudoers.d/office` passes `visudo -c -f`. Verified 2026-10-07 **on the target
      host** (`/tmp/office-sudoers: parsed OK`), on the regenerated `agent1/2/3` file — previously
      only ever checked inside the container image. Note this proves syntax, not that the grant
      works: that needs the accounts to exist, which is criterion (b).
- [ ] The adapter never runs as root, and never passes a user-supplied value as the `sudo -u` target — the target comes from the session registry only. A test asserts the rejection of an unknown user.

The VPS re-measurement was one criterion until 2026-10-07. It is **two**, because its halves have
different blockers and bundling them meant neither could close: the figure on the critical path
needs a Claude login on the box, and nothing else; the rest needs a provisioned host, which needs
root. Keeping them together let "no root" hold up a measurement that never needed root.

- [ ] **(a) The figures no other host can supply are measured and recorded.** Run as the agent's own
      Linux user with no `sudo` in the path — correct for both of these, since what WSL got wrong
      was the kernel and memory accounting, not sudo. Replaces the matching sections of
      `docs/spikes/002-tmux-tui-control.md`:
      **per-agent RSS of a bare agent, idle and mid-turn** — bare because nothing that would load
      it exists yet; see the cycle below. Recorded as a **floor**, explicitly not as the cap's
      input. Mid-turn has never been measured on any host, so even the bare figure is new. And
      **the payload-size limit** via `chars --mode echo`, which the acceptance criterion above asks
      for in a code comment and which cannot be scraped from the pane (≥ ~1000 chars renders as
      `[Pasted text #N]`).
- [ ] **(b) The `sudo -n -u` path is measured on a provisioned host.** Requires the `office`
      account and `/etc/sudoers.d/office`, i.e. root. `drive-session.sh all --trials 20` with
      `SPIKE_USER` set, plus `sudo-parity` for `$HOME`, `CLAUDE_CONFIG_DIR` and the tmux socket;
      delivery reliability for idle / mid-turn / permission-prompt at 20 trials each, `Escape`
      interrupt timing, the character round-trip matrix, and whether `kill-session` fires
      SessionEnd — all of which currently carry a WSL or container label.
- [ ] `deploy/host/provision-host.sh` runs clean as root on the target host, and
      `visudo -c -f deploy/host/sudoers.d/office` passes there. Part of (b); listed separately
      because it is the install, not a measurement.

**Root became available the same day the split was made (2026-10-07), so both run together.** The
split stands as the record of why neither could close while they were one criterion, but (a) no
longer has to be taken the weaker way: `spikes/tmux/run-007b.sh` runs as `office` with
`SPIKE_USER=agent1` and covers both, which makes even the RSS floor a reading through the real
`sudo -n -u` path rather than one carrying 003's caveat. `run-007a.sh` is kept as the no-root
fallback and is superseded wherever root exists. Remaining human step: one interactive `/login` on
`agent1`, in the project directory, so the folder-trust dialog is cleared in the same sitting.

## Decided

- **`newSession` does not set `CLAUDE_CONFIG_DIR`.** Each agent runs as its own Linux user, so
  `$HOME` already selects that user's `~/.claude` — the design's example (line 121) sets it to
  `/home/gluy/.claude` while running as `gluy`, which is that user's default anyway. Setting it was
  the cause of the onboarding failure on 2026-09-22; unset, the same spawn reached the composer.
  The adapter still *accepts* an override for a caller that needs one, but passes nothing by
  default. Decision and rationale live in ticket 009.

- **`newSession` names the Claude binary by absolute path, never bare `claude`.** Measured
  2026-09-22 on Ubuntu 24.04: tmux runs its command through a **non-interactive** shell, and the
  stock `.bashrc` returns on line 6 when not interactive, so `~/.local/bin` never joins `PATH`.
  Bare `claude` produces a pane that dies instantly with an **empty** capture — indistinguishable
  from a slow start.

  **The path is host configuration, not a function of the target user.** The earlier form of this
  decision said it was per-account (`/home/<user>/.local/bin/claude`) and "resolved from the session
  registry's target user". Measured on `rtdvps` 2026-10-07 that is wrong: the binary is a
  system-wide install at `/usr/local/bin/claude` (2.1.283) and no `~/.local/bin/claude` exists for
  any account. Deriving the path from the user would have produced ENOENT on every spawn, with the
  empty-capture symptom above and nothing naming the cause. `CLAUDE_BIN` belongs in config with
  `TMUX_BIN`, which has the same byte-for-byte-match problem for the same reason.

- **"Session exists" and "composer reached" are different questions, and the readiness check owns
  the second.** Three separate conditions were observed leaving a session that `hasSession`
  reports **alive** while the composer never appears: the binary not found (pane dies), a
  `CLAUDE_CONFIG_DIR` with no `.claude.json` (agent enters onboarding), and an untrusted working
  directory (agent parks on the folder-trust dialog — observed still waiting at 80 s). A readiness
  check that only asks tmux whether the session exists reports all three as healthy. Source:
  `docs/spikes/002-tmux-tui-control.md` §4.

- **`send-keys -l` is confirmed through `sudo -n -u`.** The character matrix was re-run over the
  real sudo path on 2026-09-22: all nine payload classes intact via `send-keys -l`. Plain
  `paste-buffer` lost a newline-bearing payload entirely (it *split* it into two turns over the
  unwrapped path), so it stays ruled out.


- **The loaded RSS figure cannot be measured by this ticket — it is a dependency cycle, now broken
  by moving the measurement rather than the dependency.** The criterion asked for RSS "for an agent
  with MCP servers, hooks, a role file and a real repo", which is the right thing to want: those
  four are what make a real agent, and ticket 018's note says the WSL agents carried none of them.
  But hooks and the `--agent` role file are **ticket 009's** output (`scripts/provision-user.sh`
  writes the eight hook entries and installs the agent definitions), MCP servers are 016/018's, and
  the chain is `007 → 008 → 009 → 016 → 018`. **007 cannot close a criterion that needs 009 to have
  run.** Nobody introduced this; splitting the criterion is what made it visible.

  Resolution: 007 measures the **bare-agent floor on a real kernel**, which is the part only a real
  host can supply and which replaces WSL2's memory accounting. The **loaded figure moves to 018**,
  which already owns the cap, already ships it as required config with no default, and by its own
  `blocked_by: [008, 016]` runs after 009 and 016 — so it is the first ticket that can load an
  agent to measure it. The floor is not a substitute and 018's cap must not be set from it; it
  bounds the loaded figure from below and nothing more.

- **Agent accounts must be purpose-created, and the sudoers template no longer names a human
  login.** The file shipped with the design's example names and `provision-host.sh` defaulted to
  `TMUX_AGENT_USERS=gluy,user2,user3`. On `rtdvps` 2026-10-07, `gluy` is a real human login in the
  `docker` group — so `office ALL=(gluy) NOPASSWD: /usr/bin/tmux`, combined with the deliberate
  decision below that full-tmux allows an arbitrary command, is a two-hop path to root:
  `office` → shell as `gluy` → docker socket → root. The script's own
  "office cannot run tmux as root" check reports `ok` throughout, because the escalation never
  passes through `(root)`.

  This is a property of the grant, not of that one host: **this file's privilege is the union of
  what its named accounts hold.** The template now names `agent1/agent2/agent3`, and
  `provision-host.sh` refuses any agent account in `docker`, `lxd`, `sudo`, `admin`, `wheel` or
  `adm`, refuses uid 0, and warns when it is granting an account it did not create itself. Verified
  under `dash` against `rtdvps`'s real accounts: `gluy`, `rtd` and `ronna` are all refused, which
  is to say the shipped default would have been refused on the host it was aimed at.

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

- [x] ~~The design's sudoers example lists `gluy`, `user2`, `user3`.~~ **Half answered 2026-10-07.**
      The *rule* is now settled and enforced (purpose-created accounts, no privileged groups — see
      Decided above), and the template names `agent1/agent2/agent3`. What remains open is **which
      department each account owns**, which is the design's own open question
      ("Who owns which department by default?") and not this ticket's to answer.
- [x] ~~**Is `rtdvps` the deployment target, or only a measuring instrument?**~~ **Answered by a
      human 2026-10-07: it is the box the office deploys on, and root is available on it.** Which
      settles the account question too — the agent accounts are provisioned there for real, not as
      a simulation, so `provision-host.sh` and criterion (b) both become runnable. Survey, retained
      because every later figure has to be read against it:
      Ubuntu 26.04.1, tmux 3.6, node 22.23.3, claude 2.1.283, 4×i3-7100T, **3.2 GB RAM**, and four
      other people's accounts on it (`rtd` uid 1000 is the server admin — `sudo`, `lxd`). `gluy`
      has **no sudo at all**, so nothing here can be provisioned from this login. The design
      anticipates this split — "office admin is not server admin. The server admin runs the VPS and
      controls Linux users, Claude logins, gateway keys, and secrets" (design line 575) — so the
      answer was a person's, not a ticket's — and the person has given it. What remains is one
      interactive `/login` on `agent1`, which is also when the folder-trust dialog must be cleared:
      a fresh account trusts nothing, and §4 of the spike found Enter does not dismiss that dialog,
      so an unattended first run parks on it with tmux reporting a live session.
- [ ] Granting `NOPASSWD: /usr/bin/tmux` in full lets `office` run `tmux new-session` with **any** command as those users. The design accepts this; note that a tighter rule would need a wrapper script. Not changing it here, but recording it as a deliberate choice rather than an oversight.
- [ ] **Should the Claude Code CLI version be pinned on the VPS?** Source: `docs/spikes/002-tmux-tui-control.md`. The binary
      auto-updated 2.1.178 to 2.1.278 *during* the spike, and the new build added a blocking modal that
      held the prompt indefinitely. The TUI changed under a running experiment with nothing deployed.
      Anything that scrapes or drives the pane breaks silently when that happens. New question, raised
      by 003.
- [ ] Whether the orchestrator or tmux owns the queue for mid-turn messages depends on ticket 003's finding. This ticket exposes both `sendKeys` and `sendLiteral` and leaves the queueing decision to ticket 008.
