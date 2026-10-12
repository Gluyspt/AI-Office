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

- [x] `newSession` starts a detached tmux session as the target user with the project working
      directory and environment set — *"starts a detached session with the config dir, working
      directory and argv command"*, and *"refuses a launch command tmux would hand to a shell"*.
      Confirmed on the target: `new-session -e` survives `sudo -u` (§7, 7/7) and sessions started
      this way took messages 20/20.

      **Two clauses of the original wording are superseded rather than met, deliberately.**
      `CLAUDE_CONFIG_DIR` is *not* set by default — one config directory per Linux user, GLU-44 —
      and the adapter only accepts an override. And *"`hasSession` reports it within 2 s"* is the
      wrong question: this ticket's own Decided section establishes that `hasSession` being true
      proves the **session** started, not that the agent can receive anything, with three separate
      conditions observed leaving it true while the composer never appeared. `newSession` waits for
      a composer instead — *"does not treat has-session as readiness — it waits for a composer"*,
      *"kills the session and reports not_ready when no composer ever appears"*, and
      *"fails when the pane command exits immediately, rather than reporting a live desk"*. The 2 s
      figure is not asserted anywhere and should not be: readiness on the target took seconds, not
      milliseconds, and a tight bound on it would flake on a host whose clock steps backwards.
- [x] Commands are built as **argument arrays**, never by string interpolation into a shell line. A
      test asserts that a message containing `; rm -rf ~` reaches the agent as literal text and
      executes nothing. `buildTmuxCommand` has *"never produces a single string — every element is
      its own argv entry"*, and `shell-quote.test.ts` carries the payload
      `"first; rm -rf ~; second"` under *"semicolon and a destructive-looking command"*, asserting
      it appears as **exactly one** argv element. Confirmed end to end on the VPS: the semicolon
      class round-tripped `echoed_intact` through `send-keys -l`.
- [x] Every character class from ticket 003's findings (double quote, single quote, backtick, dollar, semicolon, newline, non-ASCII) round-trips into the agent's prompt intact, using the mechanism that spike recorded. **Verified on the VPS 2026-10-07, transcript-checked in both directions: 35/36, with `send-keys -l` passing all nine classes.** See (a2a).
- [x] A message longer than the tmux buffer limit is delivered whole or fails loudly — never
      truncated silently. State the measured limit in a code comment. **Measured on the VPS
      2026-10-07, and the criterion's wording was wrong: "the tmux buffer limit" names
      `paste-buffer`, which the adapter does not use.** The limit that matters is `send-keys -l`'s.
      **It carries at least 16 000 characters intact and refuses everything at 65 536 and above —
      loudly, at two distinct layers: tmux's own "command too long" at 64 KB, and `execve`'s
      "Argument list too long" from 256 KB to 4 MB. No size truncated silently.** That is the
      criterion in its acceptable form. For the code comment: **16 000 chars is the measured safe
      floor; refuse or chunk above a conservative bound.** The exact boundary between 16 000 and
      65 536 is unpinned and does not need pinning.
- [x] `sendEscape` halts a mid-turn agent and leaves the session alive, verified by `hasSession`
      afterwards. Unit: *"interrupts with a single Escape keystroke"*. **Measured on the VPS through
      `sudo -n -u`: 20/20, session alive every time, p50 179 ms, p95 212 ms.**
- [x] `killSession` on a non-existent session returns a typed "not found" result rather than
      throwing. *"returns a typed not-found result instead of throwing"*, plus *"reports a sudo
      refusal as a sudo problem, not a missing session"* — the two are distinguished, which is the
      part that would have been easy to conflate.
- [x] Session names are stable across restarts for the same inputs, and two projects with the same
      role and owner produce different names — asserted by a table-driven test. `naming.test.ts`:
      *"is stable across restarts — the same inputs give the same name every call"* and *"separates
      the four fields pairwise — 16 distinct desks, 16 distinct names"*, plus *"keeps two hostile
      projects apart even when both slugify to nothing"*.
- [x] Every tmux invocation has a timeout; a hung `sudo` rejects rather than leaking a process.
      Verified with a stub binary that sleeps: *"kills a hung command and resolves as timedOut
      instead of leaking it"*, and separately *"reports a missing binary as spawn_failed rather than
      hanging"*.
- [x] `deploy/host/sudoers.d/office` passes `visudo -c -f`. Verified 2026-10-07 **on the target
      host** (`/tmp/office-sudoers: parsed OK`), on the regenerated `agent1/2/3` file — previously
      only ever checked inside the container image. Note this proves syntax, not that the grant
      works: that needs the accounts to exist, which is criterion (b).
- [x] The adapter never runs as root, and never passes a user-supplied value as the `sudo -u`
      target — the target comes from the session registry only. A test asserts the rejection of an
      unknown user. *"refuses every operation when its own uid is 0, before spawning anything"*,
      *"rejects &lt;user&gt; without spawning anything"* over a table of hostile values, and
      *"accepts an allowlisted account and passes it verbatim as the -u argument"*. Also
      *"runs normally on a platform with no uids at all"*, so the root check does not break the
      Windows development host. The kernel-side half of this is now verified on the target too:
      `office` cannot reach root or a shell through the grant.

The VPS re-measurement was one criterion until 2026-10-07. It is **two**, because its halves have
different blockers and bundling them meant neither could close: the figure on the critical path
needs a Claude login on the box, and nothing else; the rest needs a provisioned host, which needs
root. Keeping them together let "no root" hold up a measurement that never needed root.

- [x] **(a1) Bare-agent RSS, idle and mid-turn, on the real host.** **Done 2026-10-07**, and taken
      through `sudo -n -u agent1` rather than the weaker unwrapped path, because root arrived the
      same day. **Idle ≈290 MB median, 342–343 MB peak** over two independent 20-sample runs
      agreeing to within 1 MB on peak. **Mid-turn peak 327 MB — below the idle peak**, which
      contradicts 018's assumption, though the series had not plateaued when the turn ended, so it
      is a truncated lower bound and not a ceiling. Recorded as a **floor**, explicitly not the
      cap's input. Raw rows in `docs/spikes/002-vps-results/`.
- [x] **(a2a) The character matrix, transcript-verified — 35/36, identical to WSL.** Run as
      `agent1` 2026-10-07 (it cannot run as `office`; see below). 9 classes × 4 mechanisms, verified
      in both directions. **The one failure is the one WSL found: `newline` via plain
      `paste-buffer`, `not_received`.** Two hosts, two kernels, one path with sudo and one without —
      plain `paste-buffer` is now definitively ruled out for multi-line text, not provisionally.
      **`send-keys -l` passed all nine classes including `newline`**, so the adapter's mechanism is
      confirmed. This closes the "every character class round-trips, using the mechanism that spike
      recorded" criterion above.
- [x] **(a2b) The payload-size limit — measured 2026-10-07.** `send-keys -l` delivers whole at
      1 000 / 4 000 / 16 000 chars (170–412 ms) and is **refused loudly at 65 536, 262 144,
      1 048 576 and 4 194 304** — tmux's "command too long" at the first, `execve`'s "Argument list
      too long" at the rest. `paste-buffer` is the opposite and worse shape: it delivered 64 KB
      whole in 181 ms and the tmux layer accepted **4 MB** without a word, because it goes via
      stdin rather than argv, so it has **no loud failure at any size** — which on top of losing
      newlines on two hosts is why it stays ruled out despite being the only mechanism that carries
      64 KB.

      Closing this needed the probe rewritten: the original measured `paste-buffer` and read the
      composer, which collapses anything over ~1 000 chars to `[Pasted text #N]`. The rewrite
      verifies from the **transcript's user line** — "did it arrive", which is the actual question,
      not whether the agent echoed it — and splits the work by cost, since only half of it costs
      anything: refusal needs no submit and is free, delivery needs a submit and becomes input
      tokens (256 KB ≈ 65 000 of them for one trial). So delivery is verified to 64 KB and refusal
      probed to 4 MB for nothing.

      **Two rows in the first pass were artefacts of my own probe and are not findings:** a
      `not_delivered_whole` at 59.9 s and another at 59.2 s — the full timeout — between trials
      that passed in 155 ms. The size loop omitted the `wait_idle` the matrix loop has, so a submit
      landed while the agent was busy and tmux queued it. Both pass after the fix. **A failure whose
      duration equals the timeout is a queueing artefact until proven otherwise.**
**NOTE — the host's clock steps backwards, and every timing criterion inherits it.** One row reported
      **`-494 ms`** — impossible by construction, since `t0` precedes the loop, so the wall clock
      moved back about half a second between two `date +%s%3N` calls. NTP on a freshly provisioned
      box is the obvious cause. This ticket and 008 both assert on timings (the 101 ms hook round
      trip, the ~124 ms `Escape`), so: **assert on percentiles over many trials, never a single
      reading, and treat a negative or impossibly-small duration as a clock event rather than a
      fast path.** Left open as a standing constraint on how timing criteria are written.
**NOTE — why (a2) cannot run as `office`. A finding, not a failure.** `chars --mode echo` takes
      ground truth from Claude Code's JSONL transcript, on purpose: the pane renders markdown and
      once made backticks look mangled when they had arrived byte for byte. Two walls, stacked:
      **(i)** `transcript_file()` resolved the *caller's* `$HOME`, so under sudo it searched
      `/home/office/.claude/projects` while the agent wrote to
      `/home/agent1/.claude/projects/` — a plain bug, now fixed by resolving the home from
      `SPIKE_USER`; **(ii)** even corrected, `~agent1` is 0750 and the `.jsonl` files 0600, so
      `office` is denied. **Per-agent credential isolation is exactly what makes the verification
      channel unreachable from the orchestrator account.** Uncorrected, the office-side run would
      have reported all 36 trials `not_received` — total delivery failure for payloads that
      arrived intact. `chars --mode echo` now refuses up front with one `transcript unreadable`
      row instead, naming the path and the fix. Running it as `agent1` with no sudo is
      legitimate here and nowhere else in this re-measurement: the size and escaping behaviour are
      properties of tmux and the TUI, and `sudo -n -u` moves neither. Left unticked as a standing
      note rather than a task.
- [x] **(b1) `sudo -u` parity on a provisioned host — 7/7.** **Done 2026-10-07**, previously green
      only in a container. `nopasswd`; `tmux_path` 3.6; per-user sockets (`/tmp/tmux-1007` vs
      `/tmp/tmux-1006`); pane reports `agent1`; `HOME=/home/agent1` matching passwd;
      `CLAUDE_CONFIG_DIR` unset per GLU-44; and the agent user's tmux cannot see the caller's
      sessions.
- [x] **(b2) The delivery trials through `sudo -n -u` — RUN 2026-10-07.** Not via `all`, which
      would have redone the character matrix and RSS; the individual subcommands, so nothing already
      measured was paid for twice. Rows in `docs/spikes/002-vps-results/b2/`.

      | trial | result |
      | --- | --- |
      | `deliver --state idle` | **20/20 ok**, p50 2 176 ms, p95 2 888 ms |
      | `deliver --state midturn` | **20/20 delivered, never dropped** — but the queued-vs-interleaved label is noise, see below |
      | `deliver --state prompt` | **20/20 `dialog_answered`** — the hazard confirmed on the target |
      | `interrupt` | **20/20 ok**, p50 179 ms, p95 212 ms, session survives |
      | `interrupt --with-queued` | **17 delivered, 2 discarded** — non-deterministic, see below |
      | `session-end` | **5/5 fired** idle, **5/5 fired** mid-turn |

      **Three of these are worth more than their pass marks:**

      **The permission-prompt hazard is confirmed, 20/20, with proof of execution** — the approved
      `touch` left its file on disk. It took two fixes to see at all: auto mode is now the default
      and raises no dialog, and the harness's `echo` probe is auto-allowed even under `manual`.
      Three earlier runs reported `no_dialog` and blamed the allowlist. A row saying "this state did
      not occur" is not a row saying "this state is safe".

      **The mid-turn ordering question is not measurable this way, and ticket 008 has been told so.**
      `interleaved` vs `queued` is decided by comparing two pane-scraped timestamps separated by
      ≤ 14 ms in 14 of 20 trials, against a 100 ms poll interval. WSL's "queued 8/8" and this run's
      "interleaved 20/20" are the same noise read twice, not a host difference.

      **A message queued before `Escape` usually still runs — 17 of 19 — and sometimes does not.**
      Same host, same command, two behaviours. Ticket 027 cannot build on either branch; recorded
      there.

      Still carrying a WSL label and not re-run: nothing. The character matrix and RSS were measured
      earlier the same day under (a1)/(a2a).
- [x] `deploy/host/provision-host.sh` runs clean as root on the target host, and
      `visudo -c -f deploy/host/sudoers.d/office` passes there. **Done 2026-10-07 on `rtdvps`.**
      Part of (b); listed separately because it is the install, not a measurement.

      Verified independently of the script's own report, by exercising the grant rather than
      reading the file: `office` (uid 1006) and `agent1/2/3` (1007–1009) exist with **no
      supplementary groups**; `/etc/sudoers.d/office` is `0440 root:root`; `visudo -c` passes on
      the whole set; `office → agent1/2/3 /usr/bin/tmux` returns `tmux 3.6`; **`office → root` is
      refused**; **`office → /bin/sh as agent1` is refused**, which is the direct test of the
      escalation found this morning; and `sudo -n -l` as `office` lists exactly three grants and
      nothing else. `/srv/office/{projects,tls}` exist owned by `office`.

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

### Added 2026-10-12 — measure a WORKING desk, not an idle one

018's two spawn limits ship as required config with no default, and the question "what values?" was
put to a human on 2026-10-12. The answer was **measure first**, and the reason is a gap in what is
already known rather than caution: **~290 MB is the *idle* figure.** Nobody has measured a desk
mid-turn — reading files, holding a transcript, running a tool — and that is the number both limits
actually depend on. Guessing from the idle figure sets a cap that is wrong in an unknown direction.

This ticket owns the VPS re-measurement (see the ownership note in `README.md`'s decisions), so the
reading lands here:

- [ ] RSS of a desk **mid-turn**, not idle: during a file read, during a tool call, and holding a
      long transcript. Three readings, not an average of one.
- [ ] The same for two and three concurrent working desks, since the interesting failure is
      contention rather than a single process.
- [ ] `MemAvailable` at each point, so the global floor has a basis. The cold-run minimum of
      1 439 MB is the only figure that exists today and it was measured with `pnpm install` running,
      which is not the shape of a working office.
- [ ] Both numbers then written into the deploy config with the readings cited beside them, per
      015's lock-TTL precedent: no default ships, so the value is chosen deliberately on the box.

Runs in the same sitting as criterion (b) and the interactive `/login` — all three need the box and
the server admin, and batching them is the point.

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
- [x] ~~Granting `NOPASSWD: /usr/bin/tmux` in full lets `office` run `tmux new-session` with **any**
      command as those users.~~ **Answered by a human 2026-10-12: accept it as-is, and the reason is
      a decision already taken rather than a tolerance for risk.** The grant's blast radius is
      bounded by this ticket's own refusal of privileged accounts: it reaches `agent1/2/3` only —
      purpose-created accounts holding nothing of `rtd`, `ronna`, `korn` or `music`. A wrapper would
      guard against `office` *itself* being compromised, which is a different threat from the one
      originally flagged, and it would add a new place session launch can break: argument handling
      here is already subtle enough that the session name eats the message payload. Revisit if
      `office` ever runs code it did not author — step 8's preview containers are the first
      candidate.
- [x] ~~**Should the Claude Code CLI version be pinned on the VPS?**~~ **Answered by a human
      2026-10-12: pin it, and align the dev host to the same build.** The VPS pins at **2.1.283**
      and the dev host moves **2.1.268 → 2.1.283**, so one version runs in both places and a bump
      becomes a deliberate act with a re-measurement attached. Aligning dev is the half that is easy
      to skip and shouldn't be: a version skew between where the code is written and where it runs
      is how one of the two surprises below stayed hidden. Two follow-on actions, neither owned by
      this ticket's code: hold the package on the VPS so `unattended-upgrades` cannot move it, and
      record the CLI version at session start so a bump that happens anyway is visible in the
      timeline rather than arriving as unexplained behaviour. The evidence that decided it:
      Two things moved under the build in a single day's measuring: **auto mode became
      Claude Code's default permission mode**, which silently removed the permission dialog and made
      one of this ticket's criteria unmeasurable until the mode was forced; and the
      `--permission-mode` vocabulary no longer contains `default`, the value hook payloads still
      report, so a provisioned config naming it would be rejected by the CLI. Neither change
      announced itself to anything that scrapes or drives the pane. The installed build is
      **2.1.283**; `unattended-upgrades` is running on the box. This is no longer a hypothetical
      about a TUI string — it is two measured instances of the risk. Source below, plus
      §§ permission-prompt and permission-mode vocabulary. The binary
      auto-updated 2.1.178 to 2.1.278 *during* the spike, and the new build added a blocking modal that
      held the prompt indefinitely. The TUI changed under a running experiment with nothing deployed.
      Anything that scrapes or drives the pane breaks silently when that happens. New question, raised
      by 003.
- [x] ~~Whether the orchestrator or tmux owns the queue for mid-turn messages depends on ticket
      003's finding.~~ **Answered 2026-10-07: the orchestrator owns it, and ticket 008 has been told
      so.** Not because tmux failed — because the finding this was waiting on **cannot be obtained
      by the method that was supposed to produce it.** `interleaved` vs `queued` is decided by
      comparing two pane-scraped timestamps that were ≤ 14 ms apart in 14 of 20 trials, against a
      100 ms poll interval. Delivery is solid (20/20, never dropped); ordering is unobservable. A
      second result points the same way: a message queued before `Escape` still ran in 17 of 19
      trials and was discarded in 2 — non-deterministic on one host. This ticket still exposes both
      `sendKeys` and `sendLiteral`; 008 queues above them, which also makes interrupting mean *not
      sending*.
