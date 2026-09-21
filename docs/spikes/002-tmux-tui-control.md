# Spike 002 — tmux control of a live Claude Code TUI

**Ticket:** [003](../tasks/003-spike-tmux-tui-control.md) · **Harness:** [`spikes/tmux/drive-session.sh`](../../spikes/tmux/drive-session.sh)

> ## Measurements are DEFERRED. This document contains no numbers from the target.
>
> Every question this spike exists to answer is timing-, memory- or `sudo`-dependent, and the
> machine available when it was run is a **Windows host with a WSL2 Ubuntu**. The target is a Linux
> VPS with an `office` user and a scoped sudoers file. Timings measured against a WSL2 kernel, RSS
> measured against WSL2's memory accounting, and `sudo -u` behaviour measured on a box where `sudo`
> demands a password would all be wrong in ways nobody could see later. A findings doc carrying
> numbers like that is worse than one that is honestly empty, because the numbers get copied into
> ticket 007's adapter and ticket 018's cap and never questioned again.
>
> **So this spike built the instrument and did not fake the reading.** The harness runs unmodified
> on the VPS and emits every measurement the ticket asks for, as TSV, one row per trial. Each
> section below names the exact command that answers it.
>
> The table of [downstream exposure](#downstream-exposure) is the load-bearing part of this
> document: it lists every ticket whose assumptions depend on a number that does not exist yet, so
> nothing proceeds silently on a placeholder.

## What was observed on, and what that means

| | |
| --- | --- |
| Host | Windows 10 Pro 19045, WSL2, kernel `6.18.33.2-microsoft-standard-WSL2` |
| Distro | Ubuntu 24.04.4 LTS, 8 GB assigned (`MemTotal` 8 097 908 KB) |
| tmux | 3.4 (Ubuntu package) |
| Claude Code | **2.1.178 at the start of the spike, 2.1.278 by the end** — it auto-updated mid-session, see [Incidental observations](#incidental-observations) |
| Login | **expired** — every submitted turn returned `API Error: 401 OAuth access token is invalid` |
| `sudo` | requires a password for this user; `sudo -u` was never attempted |

The expired login is why the turn-dependent trials could not be run even provisionally: an agent
that cannot take a turn cannot be measured mid-turn, interrupted, or asked to echo a string back.
It also means **this spike spent no tokens**.

## Running the harness on the VPS

```sh
chmod +x spikes/tmux/drive-session.sh       # the repo may not carry the exec bit (Windows checkout)

# as the office user, with the sudoers rule from ticket 007 in place
export SPIKE_USER=gluy                      # the Linux user the agent runs as
export SPIKE_PROJECT_DIR=/srv/throwaway     # a throwaway repo, not the orchestrator repo
export SPIKE_CONFIG_DIR=/home/gluy/.claude  # which login the agent uses
export SPIKE_CLAUDE_ARGS="--model sonnet"   # these trials spend real tokens; pick the cheapest

./drive-session.sh doctor                   # prerequisites, versions, stale sessions, sudo reachability
./drive-session.sh all --trials 20 > 003-results.tsv 2> 003-run.log
```

Every subcommand takes `--dry-run`, which prints the exact commands it would run and launches
nothing. Review that first — `all` starts real agents and spends real tokens. Sessions are named
`spike003-*`; the harness never runs `tmux kill-server` and never touches a session it did not
create, so it is safe to run on a box where other people have tmux sessions open.

Paste `003-results.tsv` into each section below, replacing the DEFERRED banner with the rows.

---

## Findings by acceptance criterion

### 1. Does `send-keys "<text>" Enter` deliver reliably when the agent is idle, mid-turn, and at a permission prompt? — **DEFERRED**

```sh
./drive-session.sh deliver --state idle    --trials 20
./drive-session.sh deliver --state midturn --trials 20
./drive-session.sh deliver --state prompt  --trials 20
```

Each trial sends a message asking for an assembled token back (`ACK` + digits the prompt names but
never spells out, so the harness cannot match its own echoed prompt and report a round trip from an
agent that never answered — an earlier version of the harness did exactly that, and reported 14 ms).
Outcomes per row: `ok` with a latency, `stuck_in_composer`, `timeout`, `auth_failed`.

The permission-prompt trials additionally classify what an injected message does to a live dialog:
`dialog_answered` / `answered_and_replied` (the message selected an option — the outcome the
design's "do not build keystroke injection to answer prompts" rule exists to avoid),
`text_into_dialog`, `ignored`. **Record the failure count per state, out of 20.**

Known, unmeasured: `tmux has-session` returning true does **not** mean the agent can receive a
message. See [Incidental observations](#incidental-observations) — a first-run dialog can hold the
TUI for as long as nobody answers it.

### 2. What happens to a message sent mid-turn: queued, dropped, or interleaved? — **DEFERRED**

```sh
./drive-session.sh deliver --state midturn --trials 20
```

The harness classifies each mid-turn message as `queued` (token arrived after the turn ended, with
the queue latency), `interleaved` (token arrived while the first turn was still running),
`dropped`, or `stuck_in_composer`, and records turn-end time alongside so the two can be separated.

**This open question stays open. Ticket 008 must not assume tmux holds the queue.** The design's
chat model — "a message queues until the agent's current turn ends" — is an assumption about the
TUI's input buffer that nobody has tested. If mid-turn delivery proves unreliable, the queue moves
into the orchestrator, which is ticket 008's stated fallback and changes its schema (a durable
queue that survives an orchestrator restart).

### 3. Does `send-keys Escape` halt the turn without killing the session, and how fast? — **DEFERRED**

```sh
./drive-session.sh interrupt --trials 20 --with-queued
```

Per trial: milliseconds from the Escape keystroke to the busy indicator clearing, and whether
`has-session` still reports the session afterwards (`ok` vs `session_died`).

`--with-queued` also answers the ticket's third open question — what Interrupt does to a message
that was queued but not yet delivered. Rows come back as `queued-after-escape delivered` or
`discarded`. Record the observation; the product decision belongs to ticket 027.

### 4. Do quotes, backticks, dollars, semicolons, newlines and non-ASCII survive delivery? — **DEFERRED**

```sh
./drive-session.sh chars --mode compose   # free: types into the composer, never presses Enter
./drive-session.sh chars --mode echo      # spends tokens: submits and asks the agent to echo it back
```

Nine payloads (double quote, single quote, backtick, dollar, semicolon, shell metacharacters,
non-ASCII including CJK and an emoji, embedded newline, and all of them combined) against four
mechanisms (`send-keys`, `send-keys -l`, `load-buffer`+`paste-buffer`, and `paste-buffer -p`
bracketed), plus a payload-size probe at 1 000 / 4 000 / 16 000 / 65 536 characters.

**The criterion is only satisfied by `--mode echo`**, because it asks what the *agent* received.
Compose mode measures what tmux delivered to the TUI's input box, which is a different question —
necessary but not sufficient. Ticket 007 needs the verbatim working invocation; that is the mechanism
whose `--mode echo` rows come back `echoed_intact` for every payload.

Compose-mode results were produced while validating the harness and are recorded, clearly
unpromoted, under [Incidental observations](#incidental-observations). They already contain one
result that should change how 007 is written.

### 5. Does `tmux kill-session` reliably fire SessionEnd? — **DEFERRED**

```sh
./drive-session.sh session-end --trials 5
./drive-session.sh session-end --trials 5 --midturn    # killed mid-turn, the harder case
```

The harness writes a throwaway settings file (passed with `--settings`, so no global config is
touched) whose `SessionEnd` hook appends a timestamped line, then measures kill-to-hook latency per
trial. Run **both** variants: a kill while idle and a kill mid-turn are different races.

This is the criterion ticket 015 is waiting on. A `not_fired` row, even one in twenty, means lock
release may not depend on this path and the TTL stops being a backstop and becomes the primary
mechanism — which puts the still-undecided TTL value on the critical path.

### 6. RSS of an idle and a mid-turn `claude` process — **DEFERRED** (a provisional idle figure is below)

```sh
./drive-session.sh rss --samples 20 --interval 1 --midturn
```

Samples the whole pane process tree — not just the `claude` pid — because the per-project cap has to
be set against what the box actually loses per agent. Emits per-sample rows, an idle peak, a
mid-turn peak, and `MemTotal` / `MemAvailable` from `/proc/meminfo` so the cap and ticket 018's
memory floor can be reasoned about against real capacity.

See [Provisional RSS](#provisional-rss-wsl-only-not-the-target) — idle only, and not from the target.

### 7. Does `sudo -u <user> tmux …` behave identically to running as that user? — **DEFERRED, NOT ATTEMPTED**

```sh
./drive-session.sh sudo-parity
```

`sudo` requires a password for the user available here, so nothing about this was tested — not even
badly. This is the criterion with the least excuse for a guess: `$HOME`, `CLAUDE_CONFIG_DIR`, the
tmux socket path and cross-user visibility all depend on the real sudoers file, the real accounts
and the real PAM configuration.

The harness checks: that the NOPASSWD rule exists at all; that `/usr/bin/tmux` is the permitted path
byte for byte; whether the two users share a tmux socket or get one each (**if they share one, the
isolation the design assumes is not there**); whether `$HOME` follows the target user; whether
`CLAUDE_CONFIG_DIR` set with `new-session -e` reaches the process, as against the design's inline
`'CLAUDE_CONFIG_DIR=… claude'` form; and that the agent user's tmux cannot kill a session owned by
the caller. Without a passwordless rule every row comes back `skipped` rather than invented.

---

## Downstream exposure

Every ticket whose assumptions depend on a number this spike did not produce. **Nothing here should
proceed on a placeholder.** Derived by reading the ticket files, not by memory.

| Ticket | Assumption at risk | What breaks if the real measurement contradicts it | Answered by |
| --- | --- | --- | --- |
| **007** tmux adapter | "Every character class from ticket 003's findings round-trips into the agent's prompt intact, **using the mechanism that spike recorded**" — and `shell-quote.ts` is specified as "the message-delivery encoding **chosen in ticket 003**" | There is no chosen mechanism. Compose-mode validation already shows plain `paste-buffer` turning an embedded newline into Enter: the agent receives *half* a message and answers it, and the rest sits in the composer. An adapter built on the obvious mechanism ships that bug into every chat message containing a newline | `chars --mode echo` |
| **007** | "A message longer than the tmux buffer limit is delivered whole or fails loudly — **state the measured limit in a code comment**" | No measured limit exists. Worse, the limit is not observable the easy way: pastes of 1 000 characters and up collapse into a `[Pasted text #N]` placeholder, so the composer cannot confirm what arrived. The comment would be fiction and the "fails loudly" branch would be untested | `chars --mode echo`, size rows |
| **007** | "`newSession` … and `hasSession` reports it within 2 s" | The 2 s is a guess, and `hasSession` is the wrong readiness signal: tmux reports the session instantly while the TUI sits behind a trust prompt or an onboarding modal. 008 then marks the session `running` and sends a message that answers a dialog instead | `deliver --state idle` (startup rows), `doctor` |
| **007** | "`sendEscape` halts a mid-turn agent and leaves the session alive" | Unverified. If Escape ends the session on this version, Interrupt is Kill and step 1's stated gate is not met | `interrupt` |
| **007** | The scoped sudoers file, `$HOME` and `CLAUDE_CONFIG_DIR` resolution under `sudo -u` | Completely unmeasured. If the two users share a tmux socket, or `$HOME` does not follow, provisioning and session isolation are both wrong, and the failure looks like "the agent used the wrong login" | `sudo-parity` |
| **008** session registry | "owns the session state machine **and the message queue if ticket 003 showed tmux cannot be trusted with it**"; open question: "whether a message sent to a mid-turn agent is queued by us or by tmux" | Unknown. If 008 assumes tmux queues and it does not, messages sent while an agent is working are silently lost — with a 200 response. The schema consequence is real: an orchestrator-side queue must survive a restart, which is a migration 008 has not planned for | `deliver --state midturn` |
| **008** | "`POST /sessions/:id/interrupt` returns within 2 s and leaves the session `running`" | The 2 s budget has no measurement behind it, and "leaves it running" is criterion 3's unverified claim | `interrupt` |
| **008** | "A SessionEnd event marks the row `ended` even when the kill came from outside the orchestrator" | If SessionEnd is unreliable, sessions linger as `running` forever and the UI shows agents that are gone | `session-end` |
| **015** locks | Release on `SessionEnd` is one of the three paths the design says must all exist | If SessionEnd does not fire on kill, TTL expiry becomes the *only* release path for a killed agent — and the TTL value is itself an open question with no default. Files stay locked, dependent tasks serialise, and the failure is invisible until someone reads the registry | `session-end`, both variants |
| **018** caps | **Stated outright in the ticket:** "Per-project max concurrent agents — required config, no default shipped. **Set from ticket 003's RSS measurement against the VPS's actual RAM**" | The cap's only stated input does not exist. Set it from the provisional WSL idle figure and it is wrong in both directions: mid-turn growth is entirely unmeasured (too high → OOM under load), and a VPS agent with MCP servers and hooks loaded is heavier than this bare one (too low → the spawn queue never drains and Start working looks broken) | `rss --midturn` on the VPS |
| **018** | The global memory floor read from `/proc/meminfo` | The threshold needs a per-agent figure to be chosen against; without one, any value is arbitrary | `rss` host rows |
| **019** planning flow | "The protection that makes this safe is the spawn cap from ticket 018" | The safety property of the whole planning flow inherits 018's unfounded number | via 018 |
| **026** chat panel | "The panel **makes clear that a message queues until the agent's current turn ends**" — copy shown to the user | If mid-turn messages are dropped or interleaved, the panel states something false, and the ticket's own worst case applies: "a message that vanished is indistinguishable from one the agent ignored" | `deliver --state midturn` |
| **027** agent controls | "Interrupt … reflects its effect **within two seconds**"; open question about what Interrupt does to a queued-but-undelivered message | The 2 s is unmeasured. If Escape takes longer, the reflexive control the design cares most about feels broken; if a queued message survives the interrupt and runs afterwards, Interrupt does not mean stop | `interrupt --with-queued` |
| **027** | "The banner tells the human what to do — open that tmux session and answer there" | Rests on the untested claim that an injected chat message cannot answer a permission dialog. If it *can*, the guidance is fine but the system has a keystroke path into permission decisions that nobody intended | `deliver --state prompt` |
| **028** pause/stop | "Pause interrupts every agent … waits up to the configured deadline, then kills"; "Emergency stop … completes in under five seconds with ten sessions running" | The choreography is built on Escape latency and kill/SessionEnd timing. The five-second budget for ten sessions is a guess made without knowing what one kill costs. The pause deadline has no value at all | `interrupt`, `session-end` |
| **029** stop controls UI | Shows the pause deadline and which limit refused each queued spawn | Displays 018's and 028's unfounded numbers to the user as if they were chosen | via 018, 028 |
| **009** roles + provisioning | "A session started through ticket 008's API with `--agent dev-lead` reaches `running`, and its SessionStart event arrives" | Provisioning writes into a **fresh** `CLAUDE_CONFIG_DIR`, and a fresh config dir means first-run dialogs. Both a folder-trust prompt and an onboarding modal were observed blocking the prompt indefinitely. Provisioning must pre-seed whatever suppresses them, or every newly provisioned user hangs on its first session | `deliver --state idle` startup rows; `doctor` |
| **009** | Provisioned settings are stable | Claude Code auto-updated itself **during this spike** and the new version introduced a new blocking modal. An orchestrator scraping the pane depends on TUI strings that change without anyone deploying anything | — pin or disable auto-update on the VPS |
| **010** transcript | "A turn that ends with no assistant text (**tool call only, or an interrupted turn**) does not append an empty message" | Whether an Escape-interrupted turn fires `Stop`, `StopFailure`, or nothing is unknown; the assertion cannot be written until it is | `interrupt` + ticket 002's hook capture |
| **011** spine e2e | Asserts round-trip latency, an intact special-character message, a mid-turn interrupt, and SessionEnd after a kill | Every one of these is a spike question. If 003 stays deferred, 011 is where all of them are discovered at once, against a full stack, with real tokens — the most expensive place to find them | all of the above |
| **021** coordination tests | "Lock release, all three paths … **SessionEnd after a kill**"; "the suite leaves no tmux sessions behind" | A test written against an unreliable SessionEnd is flaky, and a flaky release test gets disabled rather than fixed | `session-end` |

---

## Provisional RSS (WSL only — **not** the target)

Recorded solely to unblock the per-project cap choice in ticket 018, which has no other input. It is
**not a measurement of the target** and must not be copied into config as though it were.

| | |
| --- | --- |
| **Idle, one `claude` process tree** | **≈ 262 000 – 266 000 KB (≈ 0.26 GB)**, steady across two fresh sessions, 8 + 5 samples at 2 s |
| First sample after the prompt appears | up to 299 604 KB — allow for a startup spike |
| On the pre-auto-update build (2.1.178), single process | 571 000 – 578 000 KB idle at the welcome screen, 350 000 KB after a failed turn — **a 2× spread between two builds a day apart** |
| **Mid-turn** | **NOT MEASURED.** The login was rejected, so no turn ever ran |
| Host context | `MemTotal` 8 097 908 KB, `MemAvailable` ≈ 6 700 000 KB at sample time |

How it was obtained: `drive-session.sh rss --samples 8 --interval 2`, summing RSS across the tmux
pane process and every descendant, on **WSL2 kernel 6.18.33.2-microsoft-standard-WSL2, Ubuntu
24.04.4 LTS, Claude Code 2.1.278, tmux 3.4**.

Why it cannot stand in for the target:

- **WSL2 memory accounting is not a VPS's.** It runs a Microsoft-patched kernel inside a Hyper-V
  utility VM with dynamically ballooned memory; RSS attribution for shared pages and page cache
  differs from a bare Linux host, and the VM's own reclaim behaviour has no counterpart on the VPS.
- **The measured agent was doing nothing.** No turn, no MCP servers, no hooks, no `--agent` role
  file, no repo of any size in the working directory. The real agents in this system have all of
  those, and a mid-turn agent is the case the cap must survive.
- **The version moved 2.1.178 → 2.1.278 mid-spike and the two readings differ by 2×.** Whatever the
  cap is set from should come from the build actually deployed.

If a number is needed before the VPS run: treat **0.6 GB per idle agent** as the defensible upper
bound of what was seen here, treat mid-turn as unknown rather than as a multiple of it, and record
in ticket 018's config comment that the value is provisional and where the real one comes from.

---

## Incidental observations

Produced while validating that the harness actually drives a TUI. **None of these is a measurement
against the target** and none of them closes a criterion above. They are here because they change
how downstream tickets should be written.

1. **A fresh working directory blocks on a trust prompt.** "Is this a project you created or one you
   trust?" with `Enter to confirm · Esc to cancel`. The session exists in tmux the whole time.
2. **Claude Code auto-updated from 2.1.178 to 2.1.278 during the spike, and the new build added a
   second blocking dialog** — "Try the new fullscreen renderer?" — which held the prompt
   indefinitely. Nothing was deployed; the TUI changed under a running experiment. The harness now
   answers the trust dialog with Enter, cancels unknown modals with Escape, and reports every dialog
   it had to get past in the `startup` row. An orchestrator needs the same defence, plus a decision
   about pinning the CLI version on the VPS.
3. **`has-session` is not readiness.** Both dialogs above sit behind a session tmux reports as alive.
4. **Composer-level character delivery, `--mode compose`, 9 payloads × 4 mechanisms.** Every
   single-line payload — double quote, single quote, backtick, `$HOME` and `$(id -u)`,
   `first; rm -rf ~; second`, `a|b&c>d<e*f?g[h]i{j}k`, `café naïve 你好 — ✅` — arrived in the
   composer byte for byte through all four mechanisms. **The newline payload did not:** plain
   `load-buffer` + `paste-buffer` submitted `line one` as a turn and left `line two` in the composer,
   while `send-keys`, `send-keys -l` and `paste-buffer -p` (bracketed paste) all kept it as a
   multi-line draft. Half a message, sent and answered, with no error anywhere — this is the failure
   ticket 007's encoding has to make impossible. It still needs `--mode echo` confirmation on the
   VPS, because the composer is not the agent.
5. **Payloads of 1 000 characters and up collapse into a `[Pasted text #N]` placeholder** in the
   composer. Whatever the buffer limit is, it cannot be found by reading the pane.
6. **`tmux kill-session` fired `SessionEnd` on 2 of 2 attempts** (267 ms and 378 ms from kill to hook
   line), with a payload carrying `session_id`, `transcript_path`, `cwd` and `scratchpad_dir`. Two
   idle trials on WSL is not evidence that ticket 015 may depend on this path — run
   `session-end --trials 5` and `--midturn` on the VPS before treating it as a release mechanism.
   (A third, earlier `not_fired` row came from a counting bug in the harness, since fixed. It is
   mentioned because it is exactly the kind of artefact that would otherwise be read as a finding.)
7. **Pane-scraping gotchas, for whoever writes 007's adapter or a supervisor:** the composer pads
   with U+00A0, not a space; the input box is delimited by U+2500 rules and the prompt marker is
   U+276F; `Ctrl-U` clears one composer line so a multi-line draft needs several; `Escape` does *not*
   clear the composer; `Ctrl-C` clears it but a second `Ctrl-C` exits Claude Code.
8. **Reading the whole pane is how a harness lies to you.** The first version of the delivery test
   matched its own echoed prompt text and reported a 14 ms round trip from an agent whose login was
   rejected. The harness now asks the agent to *assemble* a token the prompt never spells out, and
   counts occurrences above the composer rather than anywhere on screen. Any future pane-based
   assertion — including ticket 011's — needs the same care.

## Harness status

| Path | Exercised against a live TUI? |
| --- | --- |
| session start, dialog handling, readiness, prefix-scoped cleanup | yes |
| `rss` idle sampling, `/proc/meminfo` rows | yes |
| `chars --mode compose`, size probes | yes |
| `session-end` (settings file, hook log, kill-to-hook timing) | yes |
| `doctor`, every `--dry-run` plan | yes |
| `deliver` (all three states), `interrupt`, `chars --mode echo` | **no — these need a working login.** The code paths that require a real turn have never executed one. Expect to debug the harness a little on the first VPS run; the failure modes it reports are `auth_failed`, `not_ready`, `no_turn` and `no_dialog`, none of which is silent |

## Carried requirement

**Re-measuring on the VPS must be an acceptance criterion of the ticket that sets up the VPS.**

There is no such ticket in steps 1–3. Nothing in the 32-ticket set provisions the host, creates the
`office` account or the agent users, or installs the sudoers file as a host-setup step. The closest
owner is **ticket 007**, which owns `deploy/sudoers.d/office` and is the only ticket that touches
host configuration at all — and it is already blocked by 003, so the dependency edge exists.

**Proposed:** ticket 007 gains an acceptance criterion along the lines of

> On the target VPS, with `deploy/sudoers.d/office` installed, `spikes/tmux/drive-session.sh all
> --trials 20` is run as the `office` user and its TSV output is pasted into
> `docs/spikes/002-tmux-tui-control.md`, replacing every DEFERRED banner. The adapter's encoding
> choice, its buffer-limit comment and its readiness check cite rows from that run.

This spike does not make that edit. Ticket 007 and the ticket index belong to other tickets' scopes;
the parent session applies it. If instead a new host-setup ticket is created later, the criterion
moves there — what matters is that it lands somewhere with an owner, because right now the
re-measurement is nobody's job.

## Open questions — still open

- [ ] **Does a mid-turn message queue in the TUI at all?** Unknown. Ticket 008 must not assume tmux
      holds the queue; if it does not, the queue moves into the orchestrator and must survive a
      restart.
- [ ] **What does Interrupt do to a queued-but-undelivered message?** Unknown. The harness records
      it (`interrupt --with-queued`); the product decision is ticket 027's.
- [ ] **Which delivery mechanism does ticket 007 standardise on?** Undecided pending
      `chars --mode echo`. Compose-mode evidence rules *against* bare `paste-buffer`; it does not by
      itself rule *for* any of the other three.
- [ ] **What is the real per-agent RSS, idle and mid-turn, on the VPS?** Unknown. Ticket 018's cap
      has no other input.
- [ ] **Does `sudo -u` preserve `$HOME` and `CLAUDE_CONFIG_DIR`, and are the tmux servers per-user?**
      Untested. If the tmux socket turns out to be shared, the isolation the design assumes is not
      there and the sudoers file is not the boundary it looks like.
- [ ] **Should the Claude Code version be pinned on the VPS?** Raised by this spike rather than
      inherited from the design: the CLI updated itself mid-experiment and changed the TUI. Anything
      that scrapes the pane — the adapter's readiness check, a supervisor, ticket 011's assertions —
      breaks silently when that happens. Needs a human decision, not an invention here.
