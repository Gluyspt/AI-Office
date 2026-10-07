# Spike 002 — tmux control of a live Claude Code TUI

**Ticket:** [003](../tasks/003-spike-tmux-tui-control.md) · **Harness:** [`spikes/tmux/drive-session.sh`](../../spikes/tmux/drive-session.sh)

> ## These are WSL numbers. They are provisional, and ticket 007 re-measures on the VPS.
>
> Every question this spike exists to answer is timing-, memory- or `sudo`-dependent, and the
> machine available is a **Windows host with a WSL2 Ubuntu**. The target is a Linux VPS with an
> `office` user and a scoped sudoers file. Timings measured against a WSL2 kernel, RSS measured
> against WSL2's memory accounting, and `sudo -u` behaviour measured on a box where `sudo` demands
> a password would all be wrong in ways nobody could see later. A findings doc carrying numbers
> like that as settled fact is worse than one that is honestly empty, because the numbers get
> copied into ticket 007's adapter and ticket 018's cap and never questioned again.
>
> The first pass therefore built the instrument and deliberately took no reading — the login had
> expired. **This pass ran it against a working login on WSL.** What follows is a *WSL reading*:
> better than nothing, not the final answer. Every section states the environment it was measured
> in, inline. **No figure here may be promoted into a settled fact or copied into config**; the
> [Carried requirement](#carried-requirement) — ticket 007 re-measures on the VPS — stands
> unchanged.
>
> §7 `sudo -u` parity was DEFERRED, NOT ATTEMPTED in the WSL pass and was later closed in a
> container, 7/7 — see
> [§7](#7-does-sudo--u-user-tmux--behave-identically-to-running-as-that-user--measured-container-all-seven-rows-green).
> This banner said otherwise until 2026-10-07, and its anchor had not pointed at the heading since
> the heading was renamed. A container measures permission *semantics* faithfully and timing and RSS
> not at all, so §7 being green does not make the rest of this document a VPS reading.
>
> The table of [downstream exposure](#downstream-exposure) is the load-bearing part of this
> document: it now marks which rows the WSL run closes, which it narrows, and which are still open.

## What was observed on, and what that means

The environment below applies to every measurement in this document unless a section says
otherwise; each section repeats it in short form so no figure can be read without it.

| | |
| --- | --- |
| Host | Windows 10 Pro 19045, WSL2, kernel `6.18.33.2-microsoft-standard-WSL2` |
| Distro | Ubuntu 24.04.4 LTS, 8 GB assigned (`MemTotal` 8 097 908 KB) |
| tmux | 3.4 (Ubuntu package) |
| Claude Code | **2.1.278 at the start of the measurement run, 2.1.278 at the end** — checked both times, it did not move. An earlier pass saw it auto-update 2.1.178 → 2.1.278, see [Incidental observations](#incidental-observations) |
| Model / plan | `--model sonnet` (Sonnet 5), Claude Pro — the cheapest option, chosen because the trials spend real tokens |
| Login | **working** — the earlier pass's expired login is what deferred these measurements in the first place |
| Working dir | `~/spike003-tmp/proj`, a throwaway git repo — **not** the orchestrator repo |
| `sudo` | requires a password for this user, and there is no `office` user; `sudo -u` still never attempted |
| Permission mode | **auto mode was active** — this matters, see §1 and [Incidental observations](#incidental-observations) |

**Why a WSL figure is not a VPS figure**, restated because it is the easiest thing to forget when
copying a number out of a table: WSL2 runs a Microsoft-patched kernel inside a Hyper-V utility VM
with dynamically ballooned memory, so RSS attribution and reclaim have no counterpart on the VPS;
the agents measured here carry no MCP servers, no hooks, no `--agent` role file and an empty repo,
where real ones carry all four; and `sudo -u`, the account layout and the tmux socket topology are
the VPS's alone.

## The target host, surveyed — `rtdvps`, 2026-10-07

A box was available for the first time. **No measurement in this document changed**, because the two
things the harness needs are both still missing; what follows is the survey that establishes that,
and the host profile every later figure will have to be read against.

| | |
| --- | --- |
| Host | `rtdvps`, Ubuntu 26.04.1 LTS, kernel `7.0.0-34-generic` — a real kernel, not WSL2's |
| CPU | Intel i3-7100T @ 3.40 GHz, 4 threads (2 physical cores) |
| Memory | **`MemTotal` 3 360 800 KB (3.2 GB)**, `MemAvailable` 2 540 736 KB, 3.8 GB swap |
| Disk | 114 GB, 11% used |
| tmux | **3.6** (needs ≥ 3.2 for `new-session -e`) |
| node / git | v22.23.3 / 2.53.0 |
| Claude Code | **2.1.283 at `/usr/local/bin/claude`** — a system-wide install |
| Login | **none.** No `~/.claude` and no `~/.claude.json` for any account |
| `sudo` | **`gluy` may not run sudo at all** — `sudo: Sorry, user gluy may not run sudo on rtdvps` |
| Accounts | no `office`, no agent accounts, no `/etc/sudoers.d/office`, no `/srv/office` |
| Occupancy | five human accounts; `rtd` (uid 1000, in `sudo` and `lxd`) is the server admin and was logged in on tty1 |

`doctor` was run from this login and is green on every binary it needs — `tmux`, `ps`, `awk`,
`grep`, `sed`, `claude`, and the millisecond clock — with one row that is the whole story:

```
doctor  0  sudo  not_configured  -  -  SPIKE_USER empty: tmux runs as gluy, which is NOT what the VPS will do
```

**Three things this survey changes, none of them a number:**

1. **The memory figure is the headline, and it is small.** 3.2 GB total with 2.5 GB available, on a
   host that must also run the orchestrator, Postgres and a graph server per project. Against the
   unresolved idle-RSS spread this document already records — 0.26 GB measured under WSL versus
   0.57–0.58 GB for an earlier build on the same machine, see
   [RSS across builds](#rss-across-builds--why-the-spread-matters-more-than-the-number) — the
   difference between those two figures is the difference between roughly nine concurrent agents and
   roughly four, before anything else on the box is counted. Ticket 018's cap cannot be guessed from
   either end of that spread, and ticket 018's global `/proc/meminfo` floor stops being a nicety on a
   host this size.
2. **`claude` is not where ticket 007 said it would be.** That ticket recorded the binary as
   per-account at `/home/<user>/.local/bin/claude`, resolved from the target user. Here it is a
   single system-wide install and no per-account path exists. The absolute-path rule survives
   intact — bare `claude` still dies in tmux's non-interactive shell — but the *derivation* does
   not, and deriving it would have produced ENOENT on every spawn wearing the empty-capture symptom
   from §4. It is host config now, alongside `TMUX_BIN`.
3. **The shipped sudoers default would have granted root on this host.** `TMUX_AGENT_USERS`
   defaulted to `gluy,user2,user3`; `gluy` here is a human login in the `docker` group, and this
   document's own §7 note that full-tmux permits an arbitrary command completes the path:
   `office` → shell as `gluy` → docker socket → root. `provision-host.sh` reported
   "office cannot run tmux as root" as `ok` the entire time, because nothing passed through
   `(root)`. Fixed in ticket 007: purpose-created `agent1/2/3`, and a privileged-group refusal in
   the provisioner, verified under `dash` to reject `gluy`, `rtd` and `ronna` on this host.

## VPS readings — `rtdvps`, 2026-10-07, through `sudo -n -u agent1`

The host was provisioned the same day it was surveyed, so these ran on the real path:
`sudo_prefix sudo -n -u agent1`, `target_user agent1`, `project_dir /srv/office/projects/throwaway`,
`--model sonnet`, claude 2.1.283, `CLAUDE_CONFIG_DIR` unset. **These are VPS figures, not WSL ones.**
They are also **bare-agent** figures — no MCP servers, no hooks, no `--agent` role file, an empty
repo — which is a floor, and ticket 018 owns the loaded measurement (see its Decided).

### §7 `sudo -u` parity — **MEASURED (VPS), 7/7**

Previously green only in a container. On the real host, all seven: `nopasswd` ok; `tmux_path`
tmux 3.6; sockets are per-user (`/tmp/tmux-1007` vs `/tmp/tmux-1006`); the pane reports `agent1`;
`HOME=/home/agent1` matching passwd; `CLAUDE_CONFIG_DIR` unset, as decided in GLU-44; and
**the agent user's tmux cannot see the caller's sessions.**

### §6 RSS — **MEASURED (VPS). The 2× spread is resolved, toward the low end**

Two independent 20-sample idle runs, one minute apart:

| | run 1 | run 2 |
| --- | --- | --- |
| median | 299 MB | 290 MB |
| peak | **342 MB** | **343 MB** |
| range | 279–351 MB | 283–351 MB |

**This retires the worry recorded in [RSS across builds](#rss-across-builds--why-the-spread-matters-more-than-the-number).**
WSL measured ≈0.26 GB and an earlier Claude Code build measured 0.57–0.58 GB on the same machine;
the document said the spread mattered more than the number and that 018's cap must not be set from
either end. The VPS says **≈0.29 GB median, 0.34 GB peak** — within about 10% of the WSL figure.
So WSL2's memory accounting was *not* misleading for this particular quantity, and the 0.58 GB
figure belonged to a different build rather than to a different kernel. Worth stating plainly
because the inverse was assumed for two weeks.

**Idle is not flat.** Both runs sit around 290 MB and then spike transiently to ~350 MB before
falling back — run 1 at samples 11–19, run 2 at samples 10–11. A single sample taken shortly after
startup understates the peak by roughly 20%. Any cap derived from one reading is derived from the
wrong one.

### Mid-turn RSS — **MEASURED (VPS) for the first time on any host, and it is a floor**

Ten samples during a turn: 312 → 335 MB, rising monotonically, `turn_ended` at sample 10.
**Peak 327 MB — *below* the idle peak of 343 MB.**

That contradicts the assumption carried in ticket 018's Decided, that "mid-turn is what actually
determines whether the box survives N concurrent agents". On this evidence it does not. **But the
series had not plateaued when the turn ended**, so 327 MB is a lower bound truncated by a trivial
ten-second turn, not a ceiling — a long or tool-heavy turn is unmeasured and may well exceed idle.
The honest form: *mid-turn on a trivial turn does not exceed idle peak; mid-turn under real work
remains unmeasured.*

### What the cap arithmetic actually says

`MemTotal` 3 360 800 KB. `MemAvailable` **2 310 768 KB (2.20 GB)** with one agent running — this is
the figure ticket 018's floor reads. At 0.34 GB peak per bare agent that is **≈6 bare agents**, and
every term pushes it down from there: the orchestrator and Postgres are not yet on the box, a graph
server per project arrives at step 5, and loaded agents carry four things these did not.

### Payload-size limit — **STILL DEFERRED, and now for a structural reason**

`chars --mode echo` **cannot be run as `office`.** It establishes ground truth from Claude Code's
own JSONL transcript — deliberately, because the pane renders markdown and made backticks look
mangled when they had arrived byte for byte. That transcript lives in the agent's home:
`/home/agent1/.claude/sessions` is mode **700**, `/home/agent1` is 750, and `office` gets
`denied`. Per-agent credential isolation is exactly what makes the verification channel
unreachable from the orchestrator account.

So the run produced one `startup ready` row and exited nonzero: `transcript_file()` returned empty,
and under `set -eu` the harness aborted instead of emitting an outcome — a gap in a harness whose
whole principle is to report a failure as an outcome rather than a wrong number.

**This measurement has to run as `agent1` directly, with no sudo in the path, and that is
legitimate:** the payload-size limit is a property of tmux's buffers and the TUI, not of sudo.
Nothing about `sudo -n -u` changes where a 1000-character paste starts collapsing into
`[Pasted text #N]`. It is the one reading in this document for which the unwrapped path is not a
caveat.

**Why the measurements still did not run.** They need one of two things that a non-root login
without a Claude session cannot supply:

| Half of the re-measurement | Needs | State |
| --- | --- | --- |
| RSS idle + mid-turn, payload-size limit | a Claude login on the box. **No root, no sudo, no `office` account** — these run as the agent's own user, because what WSL got wrong was the kernel and memory accounting | blocked on one `/login`, which costs the operator the session they are working in |
| everything through `sudo -n -u`, and §7 on real accounts | the `office` account and `/etc/sudoers.d/office`, i.e. root | blocked on the server admin |

That split is now two separate acceptance criteria on ticket 007. As one criterion, "no root" held
up a figure that never needed root — and that figure is the one on the critical path.

**A probe note — three instances now, and they are one lesson.** All three reported a *correct*
configuration as broken, which is the expensive direction: it sends someone to fix what is not
wrong.

1. **Earlier, in this document:** `drive-session.sh` probed sudo with `... true`, a **wider**
   permission than the one granted — which a correctly scoped sudoers file must deny.
2. **2026-10-07, the privileged-group refusal.** An `ssh` one-liner reported `gluy -> allowed`,
   missing `docker`. The guard was right; the probe ran under **zsh**, which does not word-split an
   unquoted `$VAR`, so `for g in $PRIVILEGED_GROUPS` iterated once over the whole six-word string
   and grepped for a group of that name. `provision-host.sh` is `#!/bin/sh` → dash, where it
   splits. **Run a probe in the shell the thing it probes runs in.**
3. **2026-10-07, the login precondition — the sharpest of the three, because it was written as a
   precondition *for* the isolation it then failed to respect.** `run-007b.sh` ran
   `[ -e ~agent1/.claude.json ]` as `office` to check the agent had logged in. `office` cannot
   traverse `~agent1` (`drwxr-x--- agent1 agent1`), and **`test -e` cannot distinguish
   permission-denied from absent**, so the check reported "no Claude login" on a host where the
   login and the folder trust had both just been done. It would have failed on *every* correctly
   provisioned host, because `office` not reading `~agent1` is the entire point of giving each
   agent its own account.

   The fix is not a better probe — it is accepting that the question cannot be asked from there.
   The script now says the login is unverifiable from `office` by design, prints the two root-side
   commands that do answer it, and leans on the harness reporting `auth_failed` per row rather than
   inventing a measurement.

**The general rule this document keeps relearning: a probe that needs access the boundary is
supposed to refuse is not a test of the boundary, it is a second implementation of it — and the
failure is silent and backwards.** Check from a vantage point that legitimately has the access, or
state that you cannot check.

## Running the harness on the VPS

Two invocations, because ticket 007's re-measurement is two criteria with different blockers — see
[the host survey](#the-target-host-surveyed--rtdvps-2026-10-07).

**(a) Needs a Claude login and nothing else.** No root, no `office` account, no sudo in the path.
Run as the account the agent will be:

```sh
chmod +x spikes/tmux/drive-session.sh       # the repo may not carry the exec bit (Windows checkout)

export SPIKE_CLAUDE=/usr/local/bin/claude   # rtdvps: system-wide install, NOT ~/.local/bin
export SPIKE_CLAUDE_ARGS="--model sonnet"   # these trials spend real tokens; pick the cheapest
export SPIKE_PROJECT_DIR="$HOME/spike003-tmp/proj"   # a throwaway repo, not the orchestrator repo
# SPIKE_USER deliberately unset: no office account exists, and neither of these needs one.
# SPIKE_CONFIG_DIR deliberately unset: $HOME already selects this account's login (GLU-44).

./drive-session.sh doctor                            # versions, stale sessions, sudo reachability
./drive-session.sh rss   --samples 20 --interval 1   > rss-idle.tsv
./drive-session.sh rss   --samples 20 --interval 1 --midturn > rss-midturn.tsv
./drive-session.sh chars --mode echo                 > chars-echo.tsv
```

**(b) Needs the provisioned host.** `provision-host.sh` run as root, so `office` and the agent
accounts exist and `/etc/sudoers.d/office` is installed:

```sh
# as the office user, with the sudoers rule from ticket 007 in place
export SPIKE_USER=agent1                    # purpose-created; never a human login (see ticket 007)
export SPIKE_CLAUDE=/usr/local/bin/claude
export SPIKE_PROJECT_DIR=/srv/office/projects/throwaway
export SPIKE_CLAUDE_ARGS="--model sonnet"
export SPIKE_TMPDIR=/srv/office/spike003    # must be writable by SPIKE_USER: the hook runs as them

./drive-session.sh doctor                   # the `sudo` row must now say ok, not not_configured
./drive-session.sh sudo-parity
./drive-session.sh all --trials 20 > 003-results.tsv 2> 003-run.log
```

Every subcommand takes `--dry-run`, which prints the exact commands it would run and launches
nothing. Review that first — `all` starts real agents and spends real tokens. Sessions are named
`spike003-*`; the harness never runs `tmux kill-server` and never touches a session it did not
create, so it is safe to run on a box where other people have tmux sessions open.

Paste `003-results.tsv` into each section below, replacing the DEFERRED banner with the rows.

### How the WSL pass in this document was invoked, verbatim

Recorded so the rows below are reproducible and so the VPS run can be compared against a known
invocation. Each subcommand was run from a Windows host through WSL, one `wsl.exe` call per run —
**a backgrounded process does not survive between `wsl.exe` invocations, so anything long-lived has
to live inside tmux** (the harness already does this; a hand-rolled replacement will not).

```sh
# inside WSL: bash -l, so nvm puts node 22 and `claude` on PATH
export SPIKE_CLAUDE_ARGS="--model sonnet"     # cheapest model on this login
export SPIKE_PROJECT_DIR="$HOME/spike003-tmp/proj"
export SPIKE_REPLY_TIMEOUT=45                 # chars run only: fail fast rather than 180 s

bash spikes/tmux/drive-session.sh chars --mode echo
bash spikes/tmux/drive-session.sh session-end --trials 3
bash spikes/tmux/drive-session.sh session-end --trials 3 --midturn
bash spikes/tmux/drive-session.sh rss --samples 12 --interval 1 --midturn
bash spikes/tmux/drive-session.sh interrupt --trials 3
bash spikes/tmux/drive-session.sh interrupt --trials 3 --with-queued
bash spikes/tmux/drive-session.sh deliver --state idle    --trials 8
bash spikes/tmux/drive-session.sh deliver --state midturn --trials 5
bash spikes/tmux/drive-session.sh deliver --state prompt  --trials 3
```

`SPIKE_USER` was left empty, so tmux ran as the invoking user with **no `sudo` in the path** — which
is *not* what the VPS will do. Every row below inherits that caveat.

---

## Findings by acceptance criterion

### 1. Does `send-keys "<text>" Enter` deliver reliably when the agent is idle, mid-turn, and at a permission prompt? — **MEASURED (WSL)**

> **Environment for this section:** WSL2 kernel `6.18.33.2-microsoft-standard-WSL2`, Ubuntu 24.04.4
> LTS, tmux 3.4, Claude Code **2.1.278**, `--model sonnet`, no `sudo` in the tmux path.
> Provisional — ticket 007 re-measures on the VPS.

```sh
bash spikes/tmux/drive-session.sh deliver --state idle    --trials 8
bash spikes/tmux/drive-session.sh deliver --state midturn --trials 5   # plus 3 at SPIKE_MIDTURN_DELAY=1
SPIKE_PERMISSION_PROMPT='Use the Bash tool to run: touch …/PERMRAN.txt' \
  bash spikes/tmux/drive-session.sh deliver --state prompt --trials 3  # --permission-mode default
```

Each trial sends a message asking for an assembled token back (`ACK` + digits the prompt names but
never spells out, so the harness cannot match its own echoed prompt and report a round trip from an
agent that never answered — an earlier version did exactly that and reported 14 ms).

| State | N | Delivered | Failures | Latency |
| --- | --- | --- | --- | --- |
| **idle** | 8 | **8/8 `ok`** | 0 — no `stuck_in_composer`, no `timeout` | 1 299 – 4 418 ms; the 4 418 ms is the first trial of a fresh session, the other seven are 1 299 – 1 949 ms |
| **mid-turn** | 8 | **8/8 `queued`** | 0 dropped, 0 interleaved | see [§2](#2-what-happens-to-a-message-sent-mid-turn-queued-dropped-or-interleaved--measured-wsl-queued-88) |
| **at a permission prompt** | 3 | 3/3 delivered — **and all three approved the pending tool call** | **3/3 is the failure**, see below | ~3 330 ms |

**N is 8 / 8 / 3, not the 20 each the ticket asks for.** Reduced deliberately: a rate limit had
already killed one attempt at this spike and a second agent was consuming the same quota. An honest
small N is recorded rather than an aborted large one.

#### ⚠ A chat message delivered while a permission dialog is up **approves it**. 3/3.

This is the outcome the design's "do not build keystroke injection to answer permission prompts"
rule exists to prevent, and it is reachable through the **ordinary chat path**, with no keystroke
injection feature anywhere in the system. `send_message` is `send-keys -l -- "<text>"` followed by
`send-keys Enter`; the dialog ignores the text and **the Enter selects the highlighted default,
`1. Yes`**.

Ground truth from the session transcript — not the pane, and not the harness's own labels:

| # | Tool call pending in the dialog | What the injected chat message did |
| --- | --- | --- |
| 1 | `ls -la /home/gluy/spike003-tmp/out …` | **approved — the command ran**, output returned to the agent |
| — | `touch …/PERMRAN.txt` | refused — this is the harness's *deliberate* Escape between trials (`The user doesn't want to proceed with this tool use`) |
| 2 | `touch …/PERMRAN.txt` | **approved — ran** |
| 3 | `touch …/PERMRAN.txt` | **approved — ran again, "timestamp updated"** |

`PERMRAN.txt` exists on disk afterwards. The file is the proof: the dialog's highlighted option was
selected by a message whose text was "Reply with exactly the three capital letters ACK…".

**Consequences that belong to other tickets:**

- **008 must not deliver a queued message while a dialog is up.** Since mid-turn messages queue
  (§2) and a permission dialog can appear at any point in a turn, an orchestrator that flushes its
  queue on a timer will eventually approve a tool call nobody approved. Dialog state has to gate
  delivery.
- **027's banner guidance ("open that tmux session and answer there") is still right**, but the
  system has an unintended keystroke path into permission decisions, and the ticket should say so.
- The harness's own row labels for this state (`changed_other`, `dialog_dismissed`) **understated
  what happened** — see [Harness status](#harness-status); the transcript and the created file are
  the evidence, the labels are not.

#### Not every tool call raises a dialog

With `--permission-mode default`, `echo spike003-permission-probe` — the harness's built-in probe —
**ran with no dialog at all**, on a machine with no allowlist in `~/.claude/settings.json` and no
project-level `settings.local.json`. Claude Code 2.1.278 decides some commands are safe enough not
to ask. The probe had to be changed to a *write* (`touch`) to produce a dialog. Anything reasoning
about "the agent is blocked on a permission prompt" as a predictable state should know that the
state depends on the command, not just on the mode.

Also note the default permission mode is **not** what a bare `claude` starts in here: sessions came
up in `⏵⏵ auto mode`, which handles these prompts by itself, and had to be forced to
`--permission-mode default` for a dialog to be reachable at all.

Known and confirmed: `tmux has-session` returning true does **not** mean the agent can receive a
message, and neither does the presence of `? for shortcuts` — see
[Incidental observations](#incidental-observations) items 3 and 3b.

### 2. What happens to a message sent mid-turn: queued, dropped, or interleaved? — **MEASURED (WSL): queued, 8/8**

> **Environment for this section:** WSL2 kernel `6.18.33.2-microsoft-standard-WSL2`, Ubuntu 24.04.4
> LTS, tmux 3.4, Claude Code **2.1.278**, `--model sonnet`, no `sudo` in the tmux path.
> Provisional — ticket 007 re-measures on the VPS.

```sh
bash spikes/tmux/drive-session.sh deliver --state midturn --trials 5                        # sent 4 s into the turn
SPIKE_MIDTURN_DELAY=1 bash spikes/tmux/drive-session.sh deliver --state midturn --trials 3  # sent 1 s into the turn
```

| Sent into a running turn at | N | `queued` | `interleaved` | `dropped` | `stuck_in_composer` |
| --- | --- | --- | --- | --- | --- |
| 4 s (≈ 0.3 s before the turn ended) | 5 | **5** | 0 | 0 | 0 |
| 1 s (seconds of genuine overlap) | 3 | **3** | 0 | 0 | 0 |

**The TUI holds the queue. The design's chat model — "a message queues until the agent's current
turn ends" — is correct on this build.** End-to-end latency from send to reply, i.e. the remainder
of the running turn plus the queued turn: 1 942 – 6 282 ms at the 4 s delay, 5 737 – 9 012 ms at
the 1 s delay.

**The running turn is not truncated.** Verified in the transcript, not on the pane: in all eight
trials the interrupted-looking long turn in fact ran to completion (a full 1→60 count, 1 756 and
2 129 characters respectively, ending on the sentence about 60), and only then was the queued
message answered. Strict alternation, no interleaving, nothing lost.

**For ticket 008:** tmux *can* be trusted with the queue on this evidence, so the orchestrator-side
durable queue is not forced. Before relying on it, note what is untested: N = 8, one message deep,
on WSL. Nothing here says what happens when *several* messages are queued behind one turn, or when
a message arrives while a permission dialog is up (§1) — and "the TUI holds it" means the queue
dies with the session, so a queued-but-undelivered message is lost on a kill and **survives an
Interrupt and then runs** (§3).

#### A trap for anyone polling the TUI: the busy marker lies once a message is queued

The harness reports "turn end" from the disappearance of `esc to interrupt`. Across all eight
trials that marker cleared **148 – 342 ms after the second message was submitted** — including the
trial where the message was sent just 1 s into a turn that the transcript proves ran for several
seconds more. The marker is not tracking the turn; it clears when the composer takes the submitted
message.

**Anything that decides "is this agent busy?" by scraping `esc to interrupt` will report an agent
as idle while it is still working**, as soon as one message has been queued to it. That affects
ticket 007's adapter, ticket 008's state machine and ticket 026's "the agent is working" affordance.
The "turn end" values in the TSV appendix carry this artefact and should be read as "busy marker
cleared", not "turn finished".

### 3. Does `send-keys Escape` halt the turn without killing the session, and how fast? — **MEASURED (WSL): yes, ~124 ms**

> **Environment for this section:** WSL2 kernel `6.18.33.2-microsoft-standard-WSL2`, Ubuntu 24.04.4
> LTS, tmux 3.4, Claude Code **2.1.278**, `--model sonnet`, no `sudo` in the tmux path.
> Provisional — ticket 007 re-measures on the VPS.

```sh
bash spikes/tmux/drive-session.sh interrupt --trials 3
bash spikes/tmux/drive-session.sh interrupt --trials 3 --with-queued
```

| Variant | N | Outcome | Escape → idle |
| --- | --- | --- | --- |
| Escape mid-turn, nothing queued | 3 | **3/3 `ok`** — turn halted, `has-session` still true, pane shows an interrupted marker | **124, 123, 125 ms** |
| Escape mid-turn, a message queued 1 s earlier | 3 | **3/3 `ok`**, session alive | 2 189, 2 918, 1 391 ms — **see below, this is not Escape latency** |

**Escape halts the turn and leaves the session alive: 3/3, ~124 ms, no `session_died` row.**
Ticket 007's `sendEscape` contract and ticket 008's "returns within 2 s and leaves the session
`running`" both hold with an order of magnitude to spare — on WSL, at N = 3. Ticket 027's
"reflects its effect within two seconds" likewise.

#### What Interrupt does to a queued message — ticket 027's open question

**The queued message survives the interrupt and runs immediately afterwards. 3/3.** From the pane
snapshot of trial 1, in order:

```
30. Thirty marks three full decades.
31. Thirty-one is often the number
⎿  Interrupted · What should Claude do instead?
❯ Reply with exactly the three capital letters ACK followed immediately by the characters 93494q1 …
● ACK93494q1
```

The long turn was genuinely cut off mid-sentence at 31 of 60. The message that had been sent one
second before the Escape was **not discarded** — it became the next turn and was answered.

This also explains the second row's timings: the harness measures "Escape until the pane is no
longer busy", and with a queued message the pane goes busy again *with that message's turn*, so
1 391 – 2 918 ms is Escape-plus-the-queued-turn, **not** Escape latency. The clean figure is 124 ms.

**For ticket 027 this is a product decision, not a bug:** on this build, Interrupt means "stop what
you are doing and start on the next thing I said", not "stop". If Interrupt is meant to mean stop,
the orchestrator has to drain its own queue as part of the interrupt, and the UI must not describe
Interrupt as cancelling pending messages.

**Also relevant to ticket 010:** the interrupted turn leaves `Interrupted · What should Claude do
instead?` in the pane. Whether that fires `Stop` was not captured here — the interrupt trials ran
without the hook settings file. What *is* known is the neighbouring case: a turn ended by
`kill-session` fires **no `Stop` at all** ([§5](#5-does-tmux-kill-session-reliably-fire-sessionend--measured-wsl-yes-88)).

### 4. Do quotes, backticks, dollars, semicolons, newlines and non-ASCII survive delivery? — **MEASURED (WSL)**

> **Environment for this section:** WSL2 kernel `6.18.33.2-microsoft-standard-WSL2`, Ubuntu 24.04.4
> LTS, tmux 3.4, Claude Code **2.1.278**, `--model sonnet`, no `sudo` in the tmux path.
> Provisional — ticket 007 re-measures on the VPS.

```sh
bash spikes/tmux/drive-session.sh chars --mode echo    # SPIKE_REPLY_TIMEOUT=45
```

Nine payloads (double quote, single quote, backtick, dollar, semicolon, shell metacharacters,
non-ASCII including CJK and an emoji, embedded newline, and all of them combined) against four
mechanisms, **36 trials, echo mode**, i.e. what the *agent* received, not what the composer showed.

| Payload | `send-keys` | `send-keys -l` | `load-buffer`+`paste-buffer` | `paste-buffer -p` |
| --- | --- | --- | --- | --- |
| `she said "hello" to me` | intact | intact | intact | intact |
| `it's an agent's job` | intact | intact | intact | intact |
| ``run `whoami` now`` | intact | intact | intact | intact |
| `cost is $HOME and $(id -u)` | intact | intact | intact | intact |
| `first; rm -rf ~; second` | intact | intact | intact | intact |
| `a|b&c>d<e*f?g[h]i{j}k` | intact | intact | intact | intact |
| `café naïve 你好 — ✅` | intact | intact | intact | intact |
| `line one`⏎`line two` | intact | intact | **SPLIT INTO TWO TURNS** | intact |
| all of the above combined | intact | intact | intact | intact |

**35 of 36 `echoed_intact`; 1 `not_received`.** Round-trip latency for the 35 intact trials:
**min 1 342 ms, mean 1 626 ms, max 2 504 ms** (WSL, Sonnet, a one-line echo task — a floor for
latency, not a model of real turns).

#### Re-run **through `sudo -n -u`** — 2026-09-22, compose mode

> Ubuntu 24.04.4, tmux 3.4, Claude Code 2.1.278, `--model sonnet`, driven by the **`office`**
> account through `sudo -n -u gluy`, with gluy's real login and the scoped sudoers rule installed.
> Everything above was measured with `SPIKE_USER` empty — **no sudo in the tmux path**. This is the
> first run of the matrix over the path the adapter actually uses.

`chars --mode compose` rather than `--mode echo`: it types into the composer and never presses
Enter, so it spends no tokens. That makes it a **weaker** check than the echo run above — it shows
what the composer holds, not what the agent received — and a **complementary** one, because it is
the only one taken through sudo. Read the two together: echo proves the agent gets the bytes,
compose proves sudo does not mangle them on the way.

**35 of 36 intact.** The one failure is the same mechanism the echo run condemned, failing slightly
differently:

| Payload | `send-keys` | `send-keys -l` | `load-buffer`+`paste-buffer` | `paste-buffer -p` |
| --- | --- | --- | --- | --- |
| all eight non-newline payloads | intact | intact | intact | intact |
| `line one`⏎`line two` | intact | intact | **VANISHED** | intact |

`newline/buffer` left "nothing in the composer and nothing on screen". Over WSL without sudo the
same mechanism **split the message into two turns**; through sudo it disappeared outright. Either
way `paste-buffer` is ruled out for newline-bearing payloads, and **`send-keys -l` — ticket 007's
chosen mechanism — is intact on all nine payloads through sudo**, which is the result that
mattered.

**The payload-size question stays open.** Every probe collapsed to a placeholder, exactly as before:

| Size | Mechanism | Outcome |
| --- | --- | --- |
| 1 000 / 4 000 / 16 000 / 65 536 chars | `load-buffer`+`paste-buffer` | `[[Pasted text #N]]` in the composer |

Compose mode cannot see past the placeholder — only `--mode echo` can, and that costs tokens per
trial. So `TMUX_MAX_MESSAGE_BYTES=131072` in `.env.example` is **still** the kernel's
`MAX_ARG_STRLEN` rather than a measured TUI limit.

#### Three spawn-path requirements this run established

None of these are visible from Windows, and each produces a session that `has-session` reports
**alive** while the composer never appears — the exact hazard this document warned about.

1. **The spawn must name the binary by absolute path.** tmux runs its command through a
   non-interactive shell, and Ubuntu's stock `.bashrc` returns on line 6 when not interactive, so
   `~/.local/bin` never joins `PATH`. Bare `claude` gives a pane that dies instantly with an empty
   capture. Use `/home/<user>/.local/bin/claude`, resolved per account.
2. **`CLAUDE_CONFIG_DIR` relocates `.claude.json` as well as the credential.** Pointing it at a
   directory that has no `.claude.json` sends the agent into **onboarding**, not the composer
   (`Claude configuration file not found at: <dir>/.claude.json`, then the welcome screen).
   Ticket 009 must place `.claude.json` inside the config dir it provisions, not rely on
   `$HOME/.claude.json`. Separate Linux accounts already isolate logins through `$HOME`.

   **Settled since:** ticket 009 decided **not to use `CLAUDE_CONFIG_DIR` at all** — one config
   directory per Linux user, roles by `--agent`. This finding therefore describes a trap the
   system now avoids rather than a requirement it must meet, and it takes the design's "two logins
   at once" question (line 724) off the critical path.
3. **The folder-trust dialog gates readiness, and Enter does not clear it.** An untrusted working
   directory parks the agent on the dialog indefinitely — observed alive at 80 s. The run that
   succeeded used a directory already in the account's trust list. Ticket 009 must pre-trust the
   project directory during provisioning; ticket 007's readiness check must treat "session exists"
   and "composer reached" as different questions.

#### Two harness notes from the same run

- **`sudo-parity` row 6 mis-reported `config_dir`.** The probe ran `printenv CLAUDE_CONFIG_DIR`
  and read line 3 of the pane; with the variable unset `printenv` emits no line, so `pwd` was
  read into that slot and the row claimed `CLAUDE_CONFIG_DIR='/mnt/d/project/ai_office'`. Fixed —
  the probe now emits `(unset)` explicitly.
- **`doctor`'s `project_dir` check runs as the caller, not the agent**, so a project directory
  under the agent's home reads as `missing` when that home is mode 750 and `office` cannot
  traverse it — even though the agent starts there perfectly well. Not a bug in production, where
  `PROJECT_ROOT=/srv/office/projects` is owned by `office`, but worth knowing before trusting the
  row.

#### The measurement method had to change, and this is itself a finding

**The pane cannot answer this question.** The TUI renders messages as markdown, so the payload
``run `whoami` now`` is drawn — in both the user message and the reply — as `run whoami now`. A
`capture-pane` grep therefore reports a payload that arrived **byte for byte intact** as mangled.
The first attempt at this run did exactly that and was on course to record "backticks do not
survive tmux delivery", which is false, and which would have been written straight into ticket
007's `shell-quote.ts`.

The harness now reads **Claude Code's own JSONL transcript** (`~/.claude/projects/<slug>/*.jsonl`),
counting occurrences of the payload in `"type":"user"` lines (what the agent received) and
`"role":"assistant"` lines (what it echoed), against a baseline taken before each submit. That is a
direct answer to the ticket's wording — "what the agent actually received" — rather than a proxy.
Anything downstream that asserts on message content, **ticket 011 included, must do the same**.

#### The failure, at the agent, not at the composer

Plain `load-buffer` + `paste-buffer` with an embedded newline does not mangle the message — it
**splits it into two separate turns**. From the transcript, three consecutive user messages:

```
line one\nline two <- repeat the text before this arrow back to me exactly once, with nothing else.   (send-keys -l: one message, intact)
line one                                                                                              (paste-buffer: half a message, sent alone)
line two <- repeat the text before this arrow back to me exactly once, with nothing else.             (paste-buffer: the rest, as a second turn)
```

The agent answered the first half on its own — *"It looks like your message just says 'line one' —
did you mean to include more text or the repeat instruction?"* — and then answered the remainder.
**No error is raised anywhere.** A chat message containing a newline becomes two turns, one of them
nonsense, and the orchestrator has no way to know.

#### Bare `send-keys` passed, and must still not be used

All nine payloads round-tripped intact through bare `send-keys "<text>"` — but that is a property
of *these payloads*, not of the mechanism. tmux parses each argument as a key name first. A
separate zero-token probe (a pane running `cat`, so the received bytes are visible directly):

| Sent | Bytes that arrived |
| --- | --- |
| `tmux send-keys -t <s> 'Enter'` | a newline — tmux executed the **Enter key**; the word never arrived |
| `tmux send-keys -t <s> -l -- 'Enter'` | `Enter` |

A user whose chat message is exactly `Enter` (or `Escape`, `C-c`, `Space`, `Up`…) would have it
executed as a keystroke instead of delivered. The matrix contains no such payload, so it passed.

#### Decision for ticket 007 — the invocation, verbatim

```sh
tmux send-keys -t "$SESSION" -l -- "$TEXT"    # the whole message, one argument, verbatim
sleep 0.3                                      # the TUI needs the composer settled before submit
tmux send-keys -t "$SESSION" Enter             # submit as a SEPARATE call
```

`send-keys -l --` is the mechanism: intact on all nine payloads including the embedded newline, no
key-name parsing, no bracketed-paste dependency. `--` matters — without it a payload starting with
`-` is read as a flag. `paste-buffer -p` (bracketed) was equally intact on all nine and is the
fallback if a payload ever exceeds what one argv element can carry; **plain `paste-buffer` without
`-p` must not be used at all.**

Note that `shell-quote.ts`, as ticket 007 names it, is a misleading name for what this needs: there
is **no shell** in this path and nothing to shell-quote. `send-keys -l --` takes the text as a
single `execve` argument, so the required encoding is *none* — the module's real job is to refuse
or split what cannot be delivered (see the size question below), not to escape anything.

#### Still open: the payload-size limit — **DEFERRED**

The size probe (1 000 / 4 000 / 16 000 / 65 536 characters, via `load-buffer`) came back
`collapsed_to_placeholder` at **every** size: the composer replaces the text with `[Pasted text #N]`,
so the pane cannot confirm what arrived. **These payloads were never submitted**, so nothing is
known about what the agent would receive. Ticket 007's "state the measured limit in a code comment"
is therefore still unanswered — but it is now *answerable*: submit each size and count the payload
in the transcript, exactly as the character matrix does. It was left out of this pass to keep token
spend down.

### 5. Does `tmux kill-session` reliably fire SessionEnd? — **MEASURED (WSL): yes, 8/8**

> **Environment for this section:** WSL2 kernel `6.18.33.2-microsoft-standard-WSL2`, Ubuntu 24.04.4
> LTS, tmux 3.4, Claude Code **2.1.278**, `--model sonnet`, no `sudo` in the tmux path.
> Provisional — ticket 007 re-measures on the VPS.

```sh
bash spikes/tmux/drive-session.sh session-end --trials 5
bash spikes/tmux/drive-session.sh session-end --trials 3 --midturn
```

| Variant | N | Fired | Kill-to-hook latency |
| --- | --- | --- | --- |
| Killed while **idle** at the prompt | 5 | **5/5** | 225, 231, 231, 238, 241 ms |
| Killed **mid-turn** (4 s into a running turn) | 3 | **3/3** | 121, 123, 144 ms |

**No `not_fired` row in either variant.** A mid-turn kill fires the hook roughly *twice as fast* as
an idle one, consistently — the opposite of the intuition that the harder case is the slower one.
N is small (8 total) and the mid-turn N is 3, below the ticket's 5; that was a budget choice, and
3/3 is not 20/20.

The hook payload for a `kill-session` carries everything a lock-release path needs:

```json
{"session_id":"b219554e-…","transcript_path":"/home/gluy/.claude/projects/…/b219554e-….jsonl",
 "cwd":"/home/gluy/spike003-tmp/proj","scratchpad_dir":"/tmp/claude-1001/…/scratchpad",
 "prompt_id":"9b334d22-…","hook_event_name":"SessionEnd","reason":"other"}
```

**`reason` is `"other"` for an external `kill-session`** — not a distinct value. Ticket 008 cannot
tell "the orchestrator killed it", "a human killed the tmux session" and "something else ended it"
apart from this field; it must infer that from its own state.

**A mid-turn kill fires `SessionEnd` but never fires `Stop`.** The throwaway settings file
registered `SessionStart`, `SessionEnd` and `Stop`; across the three mid-turn trials the hook log
holds 3 `SessionStart` and 3 `SessionEnd` and **zero `Stop`**, although every session was killed
with a turn in flight. Ticket 010 should note that a turn ended by a kill produces no `Stop` at all
— the case it planned to handle as "an interrupted turn fires Stop with no assistant text" does not
arise this way. (This is a *kill*, not an Escape interrupt; §3 covers Escape.)

**For ticket 015:** on this evidence SessionEnd is a usable release path and the TTL stays a
backstop rather than becoming primary. Two cautions before that is treated as settled: N = 8 on
WSL with no `sudo` in the path, and the hook here is a `command` hook writing a line — it measures
the hook *firing*, not the event reaching an orchestrator that must then be up to receive it.

### 6. RSS of an idle and a mid-turn `claude` process — **MEASURED (WSL), mid-turn included**

> **Environment for this section:** WSL2 kernel `6.18.33.2-microsoft-standard-WSL2`, Ubuntu 24.04.4
> LTS, tmux 3.4, Claude Code **2.1.278**, `--model sonnet`, no `sudo` in the tmux path, 8 GB
> assigned to the VM. **WSL2 memory accounting is not a VPS's** — see the caveats below.
> Provisional — ticket 007 re-measures on the VPS.

```sh
bash spikes/tmux/drive-session.sh rss --samples 12 --interval 1 --midturn
```

Whole pane process tree, not just the `claude` pid. One session, 12 idle samples at 1 s, then the
same session sampled through a live turn.

| | KB | GB |
| --- | --- | --- |
| First sample, immediately after the prompt appears | 258 812 | 0.25 |
| **Idle, settled** (11 samples) | **300 280 – 308 264** | ≈ 0.29 – 0.29 |
| Idle peak | 308 264 | 0.29 |
| **Mid-turn** (9 samples, the turn ended after 9) | **330 768 – 343 164** | ≈ 0.32 – 0.33 |
| Mid-turn peak | 343 164 | 0.33 |
| Host `MemTotal` | 8 097 908 | 7.72 |
| Host `MemAvailable` at sample time | 6 689 092 | 6.38 |

**Mid-turn costs about 11 % more than idle — roughly 35 MB, not a multiple.** That is the headline
for ticket 018: mid-turn is *not* the cliff the cap was feared to need protecting against, at least
for this kind of turn.

**Read that with the caveats, all of which push the real number up:**

- The measured turn was **"count from 1 to 60 with a sentence each" — no tools, no file reads, no
  MCP servers, no hooks, no `--agent` role file, and an empty throwaway repo.** A real agent in
  this system has all of those, and a turn that reads a large file or runs a subagent is a
  different measurement entirely. 11 % is the floor of mid-turn growth, not its ceiling.
- **WSL2 is not the VPS.** A Microsoft-patched kernel in a Hyper-V utility VM with ballooned
  memory; RSS attribution for shared pages and reclaim behaviour have no counterpart on a bare
  host.
- One session, one turn. N = 1 for the mid-turn peak.

If a number is needed before the VPS run: **≈ 0.31 GB idle, ≈ 0.34 GB mid-turn for a bare agent**,
and treat **0.6 GB per agent** as the defensible planning figure — it covers the 2× spread seen
between two Claude Code builds a day apart (below) and leaves room for the tooling a real agent
carries. Record in ticket 018's config comment that the value is provisional and that the VPS run
replaces it.

### 7. Does `sudo -u <user> tmux …` behave identically to running as that user? — **MEASURED (container), all seven rows green**

```sh
docker compose -f deploy/vps-sim/compose.yml run --rm vps-sim \
  ./spikes/tmux/drive-session.sh sudo-parity
```

**Measured 2026-09-22 in `deploy/vps-sim/`** — Debian 12, tmux 3.3a, Claude Code 2.1.278, with the
real `deploy/host/sudoers.d/office` installed by `deploy/host/provision-host.sh` and the real
`office` / `gluy` / `user2` / `user3` accounts. This is the one criterion a container answers at
**full fidelity**: it is user, permission and process semantics, not hardware. The reason it was
deferred — WSL's `sudo` demands a password and there were no accounts to become — is a property of
that machine, not of the question, and inside a container we own `/etc/sudoers`.

| # | Row | Outcome | Detail |
| --: | --- | --- | --- |
| 1 | `nopasswd` | **ok** | `sudo -n -u gluy /usr/bin/tmux -V` succeeds |
| 2 | `tmux_path` | **ok** | `tmux 3.3a` at `/usr/bin/tmux`, matching the rule byte for byte |
| 3 | `socket` | **per_user** | agent `/tmp/tmux-1002/default`, office `/tmp/tmux-1001/default` |
| 4 | `whoami` | **ok** | pane reports `gluy` |
| 5 | `home` | **ok** | `HOME=/home/gluy`, matching `getent passwd` |
| 6 | `config_dir` | **present** | `CLAUDE_CONFIG_DIR` set with `new-session -e` reaches the pane process |
| 7 | `isolation` | **ok** | the agent user's tmux cannot kill a session owned by the caller |

**Row 3 was re-verified with both servers running**, since the harness reads the socket path from a
server that may not exist yet and would report two "no such file" paths that merely differ by uid.
With a live session under each account: the paths differ, and each server sees **only** its own
session — `office sees: officelive`, `agent sees: agentlive`. Mutual invisibility, not inferred
from path strings.

So the failure mode this criterion existed to catch is ruled out: the two users do **not** share a
tmux server, and `$HOME` does follow. Tickets 008 and 015 were both exposed to the other answer.

**What this does not settle.** Everything else in this document was measured with `SPIKE_USER`
empty — **no `sudo` in the tmux path at all** — and that is still true. Delivery, interrupt, the
character matrix and `SessionEnd` have never been run *through* `sudo -n -u`, because those
subcommands drive a live TUI and need an authenticated agent. The accounts and the grant are now
proven; what travels over them is not.

**A harness bug found while doing this, now fixed** (`spikes/tmux/drive-session.sh`): both the
`doctor` and `sudo-parity` preconditions probed the grant with `sudo -n -u "$SPIKE_USER" true`. A
correctly scoped sudoers file **denies** that — the rule permits `/usr/bin/tmux` and nothing else —
so against a working host the harness reported `sudo unavailable` and skipped every row, pointing
the operator at the one file that was right. Both sites now probe with `"$SPIKE_TMUX" -V`. On the
VPS this would have read as "provisioning is broken" and cost a session.

Everything else in this document was measured with `SPIKE_USER` empty, i.e. **with no `sudo` in the
tmux path at all**. The VPS adapter's every tmux call goes through `sudo -n -u`, so even the rows
that are closed below are closed for the unwrapped case only.

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
| ~~**007** tmux adapter~~ **ANSWERED (WSL)** | "Every character class from ticket 003's findings round-trips into the agent's prompt intact, **using the mechanism that spike recorded**" — and `shell-quote.ts` is specified as "the message-delivery encoding **chosen in ticket 003**" | **Closed provisionally.** The mechanism is `send-keys -l -- "$TEXT"` then a separate `send-keys Enter`: 9/9 payloads intact at the agent, verified in the transcript ([§4](#4-do-quotes-backticks-dollars-semicolons-newlines-and-non-ascii-survive-delivery--measured-wsl)). Plain `paste-buffer` is confirmed to **split a newline-bearing message into two turns** at the agent, not just in the composer. Note `shell-quote.ts` is a misnomer — there is no shell in this path and the required escaping is none | `chars --mode echo` — compose mode **re-run through sudo 2026-09-22, 35/36 intact**; echo mode still VPS-only |
| **007** | "A message longer than the tmux buffer limit is delivered whole or fails loudly — **state the measured limit in a code comment**" | **Still open.** All four sizes (1 000 – 65 536) collapse to a `[Pasted text #N]` placeholder in the composer and were never submitted, so nothing is known about what the agent receives. Now *answerable* by the transcript method §4 uses; skipped this pass to limit token spend | `chars --mode echo`, size rows |
| **007** **WORSE THAN THOUGHT** | "`newSession` … and `hasSession` reports it within 2 s" | Still wrong, and for a second reason now. `hasSession` was already the wrong signal (a dialog sits behind a live session); this pass also found the *pane* signal moving — `? for shortcuts` is replaced by `⏵⏵ auto mode on (shift+tab to cycle)` whenever a permission mode is active, and the harness declared a perfectly ready session `not_ready` for 90 s because of it. **007's readiness check must key on the composer's structure, not one hint string**, and must treat an unrecognised pane as not-ready | `deliver --state idle` (startup rows), `doctor` |
| ~~**007**~~ **ANSWERED (WSL)** | "`sendEscape` halts a mid-turn agent and leaves the session alive" | **Closed provisionally: 3/3, ~124 ms, session alive every time**, pane shows an interrupted marker ([§3](#3-does-send-keys-escape-halt-the-turn-without-killing-the-session-and-how-fast--measured-wsl-124-ms)). Interrupt is not Kill on this build | `interrupt` — **re-run on the VPS** |
| ~~**007**~~ **ANSWERED (container)** | The scoped sudoers file, `$HOME` and `CLAUDE_CONFIG_DIR` resolution under `sudo -u` | **Closed, 7/7** ([§7](#7-does-sudo--u-user-tmux--behave-identically-to-running-as-that-user--measured-container-all-seven-rows-green)). Per-user tmux sockets with mutual invisibility, `$HOME` follows, `CLAUDE_CONFIG_DIR` reaches the pane, the agent user cannot kill the caller's session. Full fidelity — permission semantics, not hardware | `sudo-parity` — **done in `deploy/vps-sim/`** |
| **008** session registry **ANSWERED (WSL), with a new hazard** | "owns the session state machine **and the message queue if ticket 003 showed tmux cannot be trusted with it**"; open question: "whether a message sent to a mid-turn agent is queued by us or by tmux" | **tmux/the TUI does hold the queue: 8/8 `queued`, nothing dropped, the running turn not truncated** ([§2](#2-what-happens-to-a-message-sent-mid-turn-queued-dropped-or-interleaved--measured-wsl-queued-88)), so the orchestrator-side durable queue is not forced. **Two new obligations instead:** (a) delivery must be gated on dialog state, because a message delivered while a permission dialog is up **approves it** ([§1](#1-does-send-keys-text-enter-deliver-reliably-when-the-agent-is-idle-mid-turn-and-at-a-permission-prompt--measured-wsl)); (b) `esc to interrupt` is not a busy signal once a message is queued — it clears within ~150–340 ms while the turn runs on | `deliver --state midturn` |
| ~~**008**~~ **ANSWERED (WSL)** | "`POST /sessions/:id/interrupt` returns within 2 s and leaves the session `running`" | **Both hold with an order of magnitude to spare: ~124 ms, session alive 3/3.** Note the interrupt does *not* cancel a queued message — it runs next (§3) | `interrupt` |
| **008** **NARROWED (WSL)** | "A SessionEnd event marks the row `ended` even when the kill came from outside the orchestrator" | SessionEnd fired **8/8** on `kill-session`, idle and mid-turn ([§5](#5-does-tmux-kill-session-reliably-fire-sessionend--measured-wsl-yes-88)), so the mechanism exists. But `reason` is `"other"` for every external kill — 008 **cannot** use the payload to tell an orchestrator kill from a human's `tmux kill-session`, and must infer that from its own state | `session-end` — **re-run on the VPS** |
| **015** locks **ANSWERED (WSL)** | Release on `SessionEnd` is one of the three paths the design says must all exist | **Closed provisionally: SessionEnd fires on kill, 8/8** (5 idle at 225–241 ms, 3 mid-turn at 121–144 ms). TTL stays a *backstop*; it does not have to become the primary release path, and the undecided TTL value comes off the critical path. Caveats: N = 8, WSL, no `sudo` in the tmux path, and this measures the hook firing — not the event reaching an orchestrator that must be up to receive it | `session-end`, both variants — **re-run on the VPS** |
| **018** caps **NARROWED (WSL)** | **Stated outright in the ticket:** "Per-project max concurrent agents — required config, no default shipped. **Set from ticket 003's RSS measurement against the VPS's actual RAM**" | **Mid-turn is no longer unmeasured**: ≈ 0.31 GB idle → ≈ 0.34 GB mid-turn, **+11 %, not a multiple** ([§6](#6-rss-of-an-idle-and-a-mid-turn-claude-process--measured-wsl-mid-turn-included)). The "mid-turn OOM cliff" fear is not supported for a no-tool turn. Still exposed in the other direction: the measured agent had no MCP servers, hooks, role file or repo, and the same build varies ~15 % run to run and ~2× between builds. Treat the figure as configuration with provenance, not a literal | `rss --midturn` on the VPS |
| **018** | The global memory floor read from `/proc/meminfo` | Now has a per-agent figure to be chosen against (0.31 / 0.34 GB bare, 0.6 GB as the planning figure), on a host reporting `MemTotal` 8 097 908 KB / `MemAvailable` 6 689 092 KB — but the VPS's capacity is the one that matters | `rss` host rows |
| **019** planning flow | "The protection that makes this safe is the spawn cap from ticket 018" | The safety property of the whole planning flow inherits 018's unfounded number | via 018 |
| ~~**026** chat panel~~ **ANSWERED (WSL)** | "The panel **makes clear that a message queues until the agent's current turn ends**" — copy shown to the user | **The copy is true.** 8/8 queued and delivered at turn end, nothing dropped or interleaved (§2). The panel should additionally not claim the agent is idle from a pane scrape — the busy marker clears while the turn continues (§2) | `deliver --state midturn` |
| ~~**027** agent controls~~ **ANSWERED (WSL)** | "Interrupt … reflects its effect **within two seconds**"; open question about what Interrupt does to a queued-but-undelivered message | 2 s budget met 16× over (~124 ms). **The open question now has an observed answer: the queued message is NOT discarded — it runs immediately after the interrupt, 3/3** (§3). On this build Interrupt means "stop and start the next thing I said". If it is meant to mean *stop*, 027 must drain the orchestrator's queue as part of the interrupt and must not describe Interrupt as cancelling pending messages | `interrupt --with-queued` |
| **027** ⚠ **CONFIRMED HAZARD** | "The banner tells the human what to do — open that tmux session and answer there" | The guidance is fine, but the feared path is **real and reachable**: an ordinary chat message delivered while a permission dialog is up **selects the highlighted `1. Yes` and the tool runs — 3/3, verified in the transcript and by the file the approved command created** (§1). The system has a keystroke path into permission decisions that nobody intended. 027 should state it, and 008 must gate delivery on dialog state | `deliver --state prompt` |
| **028** pause/stop **NARROWED (WSL)** | "Pause interrupts every agent … waits up to the configured deadline, then kills"; "Emergency stop … completes in under five seconds with ten sessions running" | The unit costs now exist: **Escape → idle ≈ 124 ms; kill → SessionEnd 121–241 ms.** Ten sessions at those costs fit inside five seconds with large margin *if the work is concurrent and the box is not saturated* — neither was tested (every measurement here is one session at a time). The pause deadline still has no value, and Pause must account for §3: an interrupted agent runs its queued message next unless the queue is drained | `interrupt`, `session-end` |
| **029** stop controls UI | Shows the pause deadline and which limit refused each queued spawn | Displays 018's and 028's unfounded numbers to the user as if they were chosen | via 018, 028 |
| **009** roles + provisioning | "A session started through ticket 008's API with `--agent dev-lead` reaches `running`, and its SessionStart event arrives" | Provisioning writes into a **fresh** `CLAUDE_CONFIG_DIR`, and a fresh config dir means first-run dialogs. Both a folder-trust prompt and an onboarding modal were observed blocking the prompt indefinitely. Provisioning must pre-seed whatever suppresses them, or every newly provisioned user hangs on its first session | `deliver --state idle` startup rows; `doctor` |
| **009** | Provisioned settings are stable | Claude Code auto-updated itself **during this spike** and the new version introduced a new blocking modal. An orchestrator scraping the pane depends on TUI strings that change without anyone deploying anything | — pin or disable auto-update on the VPS |
| **010** transcript **PARTLY ANSWERED (WSL)** | "A turn that ends with no assistant text (**tool call only, or an interrupted turn**) does not append an empty message" | Half answered: a turn ended by `kill-session` fires **`SessionEnd` but no `Stop` at all** (0 `Stop` lines across 3 mid-turn kills, with a `Stop` hook registered) — §5. The *Escape* case is still unknown: the interrupt trials ran without the hook settings file, so whether Escape fires `Stop`, `StopFailure` or nothing was not captured. Cheap to close: run `interrupt` with the `session-end` settings file | `interrupt` + ticket 002's hook capture |
| **011** spine e2e **NARROWED** | Asserts round-trip latency, an intact special-character message, a mid-turn interrupt, and SessionEnd after a kill | All four now have provisional WSL numbers to assert against instead of being discovered against the full stack. **One hard warning for how 011 is written: it must not assert on message content by scraping the pane** — the TUI renders markdown, and a backtick payload that arrived intact reads as mangled on screen. Assert against the JSONL transcript (§4) | all of the above |
| **021** coordination tests **NARROWED (WSL)** | "Lock release, all three paths … **SessionEnd after a kill**"; "the suite leaves no tmux sessions behind" | SessionEnd fired 8/8 with a tight spread (121–241 ms), so the release test has a real timing budget to assert against rather than a guess. Prefix-scoped cleanup also held throughout this pass — no `spike003-*` session or `claude` process was left behind across ~20 sessions | `session-end` |

---

## RSS across builds — why the spread matters more than the number

The measured figures are in [§6](#6-rss-of-an-idle-and-a-mid-turn-claude-process--measured-wsl-mid-turn-included).
What that section cannot show on its own is how unstable the figure is **between Claude Code
builds**, which is the part that should govern how ticket 018's cap is written.

| Reading | Build | Idle | Mid-turn |
| --- | --- | --- | --- |
| This pass, process tree, 12 samples | 2.1.278 | 300 280 – 308 264 KB | 330 768 – 343 164 KB |
| Earlier pass, process tree, 8 + 5 samples | 2.1.278 | ≈ 262 000 – 266 000 KB | not measured (login expired) |
| Earlier pass, single process at the welcome screen | 2.1.178 | 571 000 – 578 000 KB | not measured |

Two builds a day apart differ by **roughly 2×**, and two runs of the *same* build differ by ~15 %.
The cap is therefore not a constant to be discovered once: **ticket 018 should treat the per-agent
figure as configuration with a documented provenance, not as a literal in the code**, and ticket
009's open question about pinning the CLI version on the VPS is partly a memory-budget question.

All of these are WSL2 readings. None is a measurement of the target.

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
3b. **Neither is `? for shortcuts` — the readiness marker moves with the permission mode.** The
   harness waited 90 s and reported `not_ready` against a session that was up and accepting input
   the whole time. The hint line under the composer reads `? for shortcuts` only in the default
   permission mode; with a mode active it is replaced by `⏵⏵ auto mode on (shift+tab to cycle)`.
   Same build, same binary, different string. **Ticket 007's readiness check must not key on a
   single hint-line string**: match the composer's structure (the U+2500 rules and the U+276F
   marker) or accept a set of hint lines, and treat an unknown pane as not-ready rather than
   ready. This is the second time in this spike that a TUI string moved under the harness; the
   first was an auto-update.
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
   assertion — including ticket 011's — needs the same care. (Re-verified on a live login this
   pass, at N = 2 before any full run: round trips of 3 889 ms and 2 829 ms, with the reply
   carrying `ACK54558i1` / `ACK54558i2`, strings the prompt never contains.)
9. **The pane cannot be used to check message *content* at all — the TUI renders markdown.**
   Found while running `chars --mode echo`: the payload ``run `whoami` now`` is drawn in the pane,
   in both the user message and the reply, as `run whoami now`. The backticks are consumed as
   inline-code formatting. A `capture-pane` grep therefore reports a payload that arrived **byte
   for byte intact** as mangled, and would have produced a false "backticks do not survive
   delivery" finding — which is exactly the kind of number that gets written into ticket 007's
   `shell-quote.ts` and never questioned. Anything asserting on message content must read Claude
   Code's **JSONL transcript**, not the pane; the harness now does. Affects any `*`, `_`, `` ` ``,
   `#` or `[]()` in a payload, and affects ticket 011's assertions directly.
10. **`claude --model sonnet` does not touch the global config.** The model was selected by CLI flag
    for every session here; `~/.claude/settings.json` was `{"theme": "dark"}` before the run and
    `{"theme": "dark"}` after it. (The `/model` *slash command* does write to it — avoid that path
    in anything automated.)

## Harness status

| Path | Exercised against a live TUI? |
| --- | --- |
| session start, dialog handling, readiness, prefix-scoped cleanup | yes |
| `rss` idle **and mid-turn** sampling, `/proc/meminfo` rows | **yes — mid-turn now run against a live turn** |
| `chars --mode compose`, size probes | yes |
| `chars --mode echo` | **yes — 36 live turns**, now transcript-verified rather than pane-verified |
| `session-end`, both idle and `--midturn` | **yes — 8 live kills** |
| `deliver --state idle` | **yes — 10 live turns** (8 + 2 validation) |
| `deliver --state midturn` | **yes — 8 live turns** across two `SPIKE_MIDTURN_DELAY` settings |
| `deliver --state prompt` | **yes — 3 live permission dialogs** |
| `interrupt`, `interrupt --with-queued` | **yes — 6 live interrupts** |
| `doctor`, every `--dry-run` plan | yes |
| `sudo-parity` | **yes — measured in `deploy/vps-sim/`, 7/7.** Did not need the VPS after all; see §7 |

**Every turn-dependent path in the harness has now executed against a live login.** Four bugs were
found by doing so, all fixed in this pass; the first three would each have produced a *plausible
and wrong* number rather than an error, which is the argument for running the instrument before
trusting it.

| # | Bug | What it would have produced |
| --- | --- | --- |
| 1 | `RE_READY` matched only `? for shortcuts`, but the hint line becomes `⏵⏵ auto mode on (shift+tab to cycle)` whenever a permission mode is active | Every run aborted with `not_ready` against a session that was up and accepting input. Nothing ran at all |
| 2 | `chars --mode echo` verified the reply **by grepping the pane**, which renders markdown | "Backticks do not survive tmux delivery" — false, and headed for `shell-quote.ts`. Now reads the JSONL transcript |
| 3 | `chars --mode echo` sampled its occurrence baseline *after* submitting, behind a 2 s sleep; replies land in 1.3 – 2.5 s | Intact round trips reported as `echoed_mangled`, at random, depending on how fast the model answered |
| 4 | `clear_composer()` counted with `i` — the same global the trial loops count with — so calling it ended the loop | `interrupt --trials 3` silently ran **one** trial and reported success. `deliver --state prompt --trials 20` would have done the same |
| 5 | The "did the tool actually run" check hardcoded `spike003-permission-probe` while the prompt it belongs to is configurable | Three trials in which the injected message really did approve a tool call were labelled `dialog_dismissed` / `changed_other`. Now `SPIKE_PERMISSION_MARKER` |

Bug 4 is why the interrupt N is 3 and not more: the first run of it produced one trial per variant.

## Carried requirement

**Re-measuring on the VPS must be an acceptance criterion of the ticket that sets up the VPS.**
**The WSL numbers in this document do not discharge this.** They were taken on a Microsoft-patched
kernel in a utility VM, with no `sudo` in the tmux path, against a bare agent with no MCP servers,
no hooks, no role file and an empty repo. They narrow the risk; they do not close it. Anything that
consumes a figure from this document — 007's encoding choice and buffer-limit comment, 015's lock
release, 018's cap — cites it as provisional and names the VPS run as the source of the real one.

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

## Open questions

### Answered provisionally on WSL (the VPS run must confirm)

- [x] **Does a mid-turn message queue in the TUI at all?** **Yes — 8/8 queued**, delivered at turn
      end, the running turn not truncated. Ticket 008 is not forced into an orchestrator-side
      durable queue.
- [x] **What does Interrupt do to a queued-but-undelivered message?** **It survives and runs
      immediately after the interrupt, 3/3.** The product decision is still ticket 027's; the
      observation is no longer missing.
- [x] **Which delivery mechanism does ticket 007 standardise on?** **`send-keys -l -- "$TEXT"`
      followed by a separate `send-keys Enter`.** Intact on 9/9 payloads at the agent. Plain
      `paste-buffer` is ruled out (splits on a newline); bare `send-keys` is ruled out (parses key
      names); `paste-buffer -p` is the fallback for oversized payloads.
- [x] **Does `kill-session` fire SessionEnd?** **Yes, 8/8**, idle and mid-turn. Ticket 015's TTL
      stays a backstop.
- [x] **What is the per-agent RSS, idle and mid-turn?** On WSL: ≈ 0.31 GB idle, ≈ 0.34 GB mid-turn
      (+11 %). On the VPS: still unknown — see below.

### Still open

- [ ] **What is the real per-agent RSS, idle and mid-turn, on the VPS, for an agent that actually
      has MCP servers, hooks, a role file and a real repo?** The WSL figure is a floor measured on
      a bare agent, and the same binary varied ~15 % between two runs and ~2× between two builds.
      Ticket 018's cap still has no target-measured input.
- [ ] **What is the payload-size limit, and does an oversized message fail loudly?** Unanswered:
      every size from 1 000 up collapses to a `[Pasted text #N]` placeholder and none was
      submitted. Ticket 007's "state the measured limit in a code comment" cannot be written yet.
      Now cheaply answerable with the transcript method.
- [ ] **Does an *Escape-interrupted* turn fire `Stop`, `StopFailure`, or nothing?** A *killed*
      mid-turn session fires neither `Stop` nor `StopFailure` (§5), but the Escape case was not
      captured — the interrupt trials ran without the hook settings file. Ticket 010 needs this.
- [ ] **How does the orchestrator know a permission dialog is up, so it can refuse to deliver into
      one?** Newly raised, and now urgent: delivering a message into a live dialog **approves the
      pending tool call** (§1). Pane-scraping for the dialog is the obvious answer and is exactly
      the kind of version-fragile string match that broke twice during this spike.
- [ ] **Does `sudo -u` preserve `$HOME` and `CLAUDE_CONFIG_DIR`, and are the tmux servers per-user?**
      Untested, and untestable here. If the tmux socket turns out to be shared, the isolation the
      design assumes is not there and the sudoers file is not the boundary it looks like.
- [ ] **Should the Claude Code version be pinned on the VPS?** Still needs a human decision, and
      this pass strengthens the case: as well as the earlier mid-spike auto-update, the readiness
      string turned out to vary with *permission mode* on a single build, and the harness read a
      live session as dead for 90 s because of it. Anything that scrapes the pane breaks silently
      when either changes.
- [ ] **What is a sensible default permission mode for agent sessions?** Raised by this pass. A bare
      `claude` here started in `⏵⏵ auto mode`, which approves tool calls without asking; forcing
      `--permission-mode default` was required before a dialog appeared at all. Which mode the
      orchestrator launches agents in is a safety decision no ticket currently owns.

---

## Appendix — raw TSV from the WSL run

Every number in this document comes from these rows. Same run environment throughout:

```
# host        Linux 6.18.33.2-microsoft-standard-WSL2 x86_64
# os          Ubuntu 24.04.4 LTS
# tmux        tmux 3.4
# claude      2.1.278 (Claude Code)          [checked again at the end of the run: 2.1.278]
# sudo_prefix (none)
# target_user gluy
# project_dir /home/gluy/spike003-tmp/proj
# config_dir  (default)
# claude_args --model sonnet                 [deliver-prompt also: --permission-mode default]
```

Columns are `test · trial · variant · outcome · value · unit · detail`; the harness's leading UTC
`ts` column is dropped for width. Each block names its `run_id`.

```tsv
--- doctor.tsv (run_id 43890) ---
doctor	0	bin:tmux	ok	-	-	/usr/bin/tmux
doctor	0	bin:ps	ok	-	-	/usr/bin/ps
doctor	0	bin:awk	ok	-	-	/usr/bin/awk
doctor	0	bin:grep	ok	-	-	/usr/bin/grep
doctor	0	bin:sed	ok	-	-	/usr/bin/sed
doctor	0	bin:claude	ok	-	-	/home/gluy/.local/bin/claude 2.1.278 (Claude Code)
doctor	0	date_ms	ok	1790024850156	ms	millisecond clock available
doctor	0	tmux_version	info	-	-	tmux 3.4 (needs >= 3.2 for new-session -e)
doctor	0	project_dir	ok	-	-	/home/gluy/spike003-tmp/proj
doctor	0	sudo	not_configured	-	-	SPIKE_USER empty: tmux runs as gluy, which is NOT what the VPS will do
doctor	0	stale_sessions	info	0	count	existing spike003-* sessions; run cleanup to remove them
doctor	0	markers	info	-	-	ready=/\? for shortcuts/ busy=/esc to interrupt/ — verify against the installed Claude Code version before trusting any row

--- validate-idle.tsv (run_id 54558) — the N=2 check that the anti-false-positive token works ---
deliver-idle	0	startup	ready	-	-	prompt reached
deliver-idle	1	idle	ok	3889	ms	reply carried ACK54558i1
deliver-idle	2	idle	ok	2829	ms	reply carried ACK54558i2

--- chars-echo2.tsv (run_id 66960) — transcript-verified, SPIKE_REPLY_TIMEOUT=45 ---
chars	0	startup	ready	-	-	prompt reached
chars	1	dquote/keys	echoed_intact	1747	ms	transcript: received byte for byte and echoed byte for byte
chars	2	dquote/literal	echoed_intact	1407	ms	transcript: received byte for byte and echoed byte for byte
chars	3	dquote/buffer	echoed_intact	1513	ms	transcript: received byte for byte and echoed byte for byte
chars	4	dquote/buffer-bracket	echoed_intact	2000	ms	transcript: received byte for byte and echoed byte for byte
chars	5	squote/keys	echoed_intact	1488	ms	transcript: received byte for byte and echoed byte for byte
chars	6	squote/literal	echoed_intact	1521	ms	transcript: received byte for byte and echoed byte for byte
chars	7	squote/buffer	echoed_intact	1661	ms	transcript: received byte for byte and echoed byte for byte
chars	8	squote/buffer-bracket	echoed_intact	1637	ms	transcript: received byte for byte and echoed byte for byte
chars	9	backtick/keys	echoed_intact	1833	ms	transcript: received byte for byte and echoed byte for byte
chars	10	backtick/literal	echoed_intact	1448	ms	transcript: received byte for byte and echoed byte for byte
chars	11	backtick/buffer	echoed_intact	1495	ms	transcript: received byte for byte and echoed byte for byte
chars	12	backtick/buffer-bracket	echoed_intact	1740	ms	transcript: received byte for byte and echoed byte for byte
chars	13	dollar/keys	echoed_intact	1540	ms	transcript: received byte for byte and echoed byte for byte
chars	14	dollar/literal	echoed_intact	1553	ms	transcript: received byte for byte and echoed byte for byte
chars	15	dollar/buffer	echoed_intact	1513	ms	transcript: received byte for byte and echoed byte for byte
chars	16	dollar/buffer-bracket	echoed_intact	1780	ms	transcript: received byte for byte and echoed byte for byte
chars	17	semicolon/keys	echoed_intact	1820	ms	transcript: received byte for byte and echoed byte for byte
chars	18	semicolon/literal	echoed_intact	2504	ms	transcript: received byte for byte and echoed byte for byte
chars	19	semicolon/buffer	echoed_intact	1455	ms	transcript: received byte for byte and echoed byte for byte
chars	20	semicolon/buffer-bracket	echoed_intact	1412	ms	transcript: received byte for byte and echoed byte for byte
chars	21	shellmeta/keys	echoed_intact	1874	ms	transcript: received byte for byte and echoed byte for byte
chars	22	shellmeta/literal	echoed_intact	1483	ms	transcript: received byte for byte and echoed byte for byte
chars	23	shellmeta/buffer	echoed_intact	1867	ms	transcript: received byte for byte and echoed byte for byte
chars	24	shellmeta/buffer-bracket	echoed_intact	1641	ms	transcript: received byte for byte and echoed byte for byte
chars	25	nonascii/keys	echoed_intact	1366	ms	transcript: received byte for byte and echoed byte for byte
chars	26	nonascii/literal	echoed_intact	1650	ms	transcript: received byte for byte and echoed byte for byte
chars	27	nonascii/buffer	echoed_intact	1560	ms	transcript: received byte for byte and echoed byte for byte
chars	28	nonascii/buffer-bracket	echoed_intact	1550	ms	transcript: received byte for byte and echoed byte for byte
chars	29	newline/keys	echoed_intact	1342	ms	transcript: received byte for byte and echoed byte for byte
chars	30	newline/literal	echoed_intact	1520	ms	transcript: received byte for byte and echoed byte for byte
chars	31	newline/buffer	not_received	45082	ms	transcript: NO user message carried the payload byte for byte — the send mechanism mangled or split it
chars	32	newline/buffer-bracket	echoed_intact	1416	ms	transcript: received byte for byte and echoed byte for byte
chars	33	combined/keys	echoed_intact	1568	ms	transcript: received byte for byte and echoed byte for byte
chars	34	combined/literal	echoed_intact	1876	ms	transcript: received byte for byte and echoed byte for byte
chars	35	combined/buffer	echoed_intact	1694	ms	transcript: received byte for byte and echoed byte for byte
chars	36	combined/buffer-bracket	echoed_intact	1459	ms	transcript: received byte for byte and echoed byte for byte
chars	0	size-1000/buffer	collapsed_to_placeholder	1000	chars	composer shows [[Pasted text #1]] — verify with chars --mode echo
chars	0	size-4000/buffer	collapsed_to_placeholder	4000	chars	composer shows [[Pasted text #2]] — verify with chars --mode echo
chars	0	size-16000/buffer	collapsed_to_placeholder	16000	chars	composer shows [[Pasted text #3]] — verify with chars --mode echo
chars	0	size-65536/buffer	collapsed_to_placeholder	65536	chars	composer shows [[Pasted text #4]] — verify with chars --mode echo

--- sessend-idle.tsv (run_id 89298) — SessionEnd payloads truncated here for width ---
session-end	1	idle	fired	241	ms	SessionEnd {"session_id":"3f61fed4-…","transcript_path":"…/3f61fed4-….jsonl","cwd":"/home/gluy/spike003-tmp/proj","scratchpad_dir":"/tmp/claude-1001/…","reason":"other"}
session-end	2	idle	fired	231	ms	SessionEnd {"session_id":"121b6844-…", … }
session-end	3	idle	fired	231	ms	SessionEnd {"session_id":"b9b440b6-…", … }
session-end	4	idle	fired	225	ms	SessionEnd {"session_id":"5e2a726c-…", … }
session-end	5	idle	fired	238	ms	SessionEnd {"session_id":"7e0d8a41-…", … }

--- sessend-mid.tsv (run_id 90361) — hook log held 3 SessionStart + 3 SessionEnd + ZERO Stop ---
session-end	1	midturn	fired	123	ms	SessionEnd {"session_id":"b219554e-…", … }
session-end	2	midturn	fired	121	ms	SessionEnd {"session_id":"b0578c69-…", … }
session-end	3	midturn	fired	144	ms	SessionEnd {"session_id":"396e28c2-…", … }

--- rss.tsv (run_id 91396) ---
rss	0	pane_pid	info	91417	pid	claude --model sonnet
rss	1	idle	sample	258812	KB	process tree total
rss	2	idle	sample	300280	KB	process tree total
rss	3	idle	sample	300324	KB	process tree total
rss	4	idle	sample	304240	KB	process tree total
rss	5	idle	sample	307236	KB	process tree total
rss	6	idle	sample	304620	KB	process tree total
rss	7	idle	sample	304600	KB	process tree total
rss	8	idle	sample	308264	KB	process tree total
rss	9	idle	sample	306124	KB	process tree total
rss	10	idle	sample	306624	KB	process tree total
rss	11	idle	sample	307196	KB	process tree total
rss	12	idle	sample	307128	KB	process tree total
rss	0	idle	peak	308264	KB	highest idle sample over 12 samples
rss	1	midturn	sample	331200	KB	process tree total during a turn
rss	2	midturn	sample	331476	KB	process tree total during a turn
rss	3	midturn	sample	330768	KB	process tree total during a turn
rss	4	midturn	sample	331728	KB	process tree total during a turn
rss	5	midturn	sample	332928	KB	process tree total during a turn
rss	6	midturn	sample	335108	KB	process tree total during a turn
rss	7	midturn	sample	335080	KB	process tree total during a turn
rss	8	midturn	sample	340640	KB	process tree total during a turn
rss	9	midturn	sample	343164	KB	process tree total during a turn
rss	9	midturn	turn_ended	-	-	turn finished after 9 samples
rss	0	midturn	peak	343164	KB	highest mid-turn sample
rss	0	host	memtotal	8097908	KB	MemTotal from /proc/meminfo
rss	0	host	memavailable	6689092	KB	MemAvailable at sample time

--- interrupt.tsv (run_id 93066) — the clean Escape latency ---
interrupt	1	escape	ok	124	ms	turn halted, session alive, pane shows an interrupted marker
interrupt	2	escape	ok	123	ms	turn halted, session alive, pane shows an interrupted marker
interrupt	3	escape	ok	125	ms	turn halted, session alive, pane shows an interrupted marker

--- interruptq.tsv (run_id 93494) — "escape" here INCLUDES the queued turn, see §3 ---
interrupt	1	escape	ok	2189	ms	turn halted, session alive, pane shows an interrupted marker
interrupt	1	queued-after-escape	delivered	12	ms	the message queued before Escape still ran — 027 must decide if that is wanted
interrupt	2	escape	ok	2918	ms	turn halted, session alive, pane shows an interrupted marker
interrupt	2	queued-after-escape	delivered	11	ms	the message queued before Escape still ran
interrupt	3	escape	ok	1391	ms	turn halted, session alive, pane shows an interrupted marker
interrupt	3	queued-after-escape	delivered	14	ms	the message queued before Escape still ran

--- deliver-idle.tsv (run_id 94620) ---
deliver-idle	1	idle	ok	4418	ms	reply carried ACK94620i1
deliver-idle	2	idle	ok	1506	ms	reply carried ACK94620i2
deliver-idle	3	idle	ok	1437	ms	reply carried ACK94620i3
deliver-idle	4	idle	ok	1390	ms	reply carried ACK94620i4
deliver-idle	5	idle	ok	1299	ms	reply carried ACK94620i5
deliver-idle	6	idle	ok	1450	ms	reply carried ACK94620i6
deliver-idle	7	idle	ok	1949	ms	reply carried ACK94620i7
deliver-idle	8	idle	ok	1506	ms	reply carried ACK94620i8

--- deliver-mid.tsv (run_id 95942) — message sent 4 s into the turn ---
--- "turn end" = the busy marker clearing, which is NOT turn end; see §2 ---
deliver-midturn	1	midturn	queued	6282	ms	delivered after turn end (342ms); queue latency 5940ms
deliver-midturn	2	midturn	queued	2172	ms	delivered after turn end (328ms); queue latency 1844ms
deliver-midturn	3	midturn	queued	1942	ms	delivered after turn end (327ms); queue latency 1615ms
deliver-midturn	4	midturn	queued	2510	ms	delivered after turn end (329ms); queue latency 2181ms
deliver-midturn	5	midturn	queued	2208	ms	delivered after turn end (327ms); queue latency 1881ms

--- deliver-mid-early.tsv (run_id 97787) — SPIKE_MIDTURN_DELAY=1, seconds of real overlap ---
deliver-midturn	1	midturn	queued	9012	ms	delivered after turn end (148ms); queue latency 8864ms
deliver-midturn	2	midturn	queued	5858	ms	delivered after turn end (331ms); queue latency 5527ms
deliver-midturn	3	midturn	queued	5737	ms	delivered after turn end (339ms); queue latency 5398ms

--- deliver-prompt.tsv (run_id 102532) — --permission-mode default, probe = a touch, not an echo ---
--- THESE LABELS UNDERSTATE WHAT HAPPENED. Ground truth is the transcript below. ---
deliver-prompt	1	permission	changed_other	3334	ms	dialog still up but pane changed
deliver-prompt	2	permission	dialog_dismissed	3326	ms	dialog disappeared without the tool running
deliver-prompt	3	permission	dialog_dismissed	3348	ms	dialog disappeared without the tool running
```

### Ground truth for the permission-prompt trials

The harness's labels above are wrong for the reason given in [Harness status](#harness-status)
(bug 5). What actually happened, from the session's JSONL transcript — tool calls and their
results, in order:

```
TOOL_USE : ls -la /home/gluy/spike003-tmp/out 2>&1 || ls -la /home/gluy/spike003-tmp
  RESULT : total 116\ndrwxr-xr-x 2 gluy gluy 4096 …          <- APPROVED by the injected message
TOOL_USE : touch /home/gluy/spike003-tmp/out/PERMRAN.txt
  RESULT : ERROR The user doesn't want to proceed …          <- the harness's own Escape, between trials
TOOL_USE : touch /home/gluy/spike003-tmp/out/PERMRAN.txt
  RESULT : (Bash completed with no output)                   <- APPROVED by the injected message
TOOL_USE : touch /home/gluy/spike003-tmp/out/PERMRAN.txt
  RESULT : (Bash completed with no output)                   <- APPROVED by the injected message
```

and on disk afterwards: `-rw-r--r-- 1 gluy gluy 0 Sep 22 04:23 /home/gluy/spike003-tmp/out/PERMRAN.txt`.

### The newline split, from the transcript

Three consecutive user messages, showing one message becoming two turns under plain `paste-buffer`:

```
line one\nline two <- repeat the text before this arrow back to me exactly once, with nothing else.
line one
line two <- repeat the text before this arrow back to me exactly once, with nothing else.
```
