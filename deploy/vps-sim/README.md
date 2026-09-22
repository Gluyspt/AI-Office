# VPS simulator

A container that provisions itself into a Linux host shaped like the target VPS, so the
host-shaped checks tickets 001–007 defer to "the VPS" can run without renting one.

| File | What |
| --- | --- |
| `Dockerfile` | The image: Node 22 on Debian, provisioned by `deploy/host/provision-host.sh` |
| `compose.yml` | The service. Build context is the repo root, mounted read-only at `/srv/office/orchestrator` |
| `README.md` | This file — what the simulator proves, and what it cannot |

It shares its provisioning with the real host: `deploy/host/provision-host.sh` runs here at build
time and on the VPS as root, so the steps cannot drift apart. `deploy/host/sudoers.d/office` (ticket
007's file) is installed unmodified.

Host provisioning is the step **no ticket in steps 1–3 owns** — spike 002 says so directly:
"Nothing in the 32-ticket set provisions the host, creates the `office` account or the agent
users, or installs the sudoers file as a host-setup step." `host/provision-host.sh` is that step,
written so it is exercised on every image build instead of improvised once on a rented box.

## Running it

```sh
docker compose -f deploy/vps-sim/compose.yml build     # provisioning runs, and must pass
docker compose -f deploy/vps-sim/compose.yml run --rm vps-sim

# inside:
./spikes/tmux/drive-session.sh doctor
./spikes/tmux/drive-session.sh sudo-parity
```

The build **fails** if the sudo grant does not actually work, so a broken sudoers file cannot
reach a running container. On a real VPS, run `host/provision-host.sh` as root — it is idempotent,
and re-running after a partial failure is the intended recovery.

## What this proves, at full fidelity

These are user, permission and process semantics. A container has the real ones.

- **`sudo -u` parity — spike 002 §7, which was `DEFERRED, NOT ATTEMPTED`.** It was deferred
  because WSL's sudo demands a password. Here we own `/etc/sudoers`.
- `visudo -c -f` on the sudoers file, and `visudo -c` on the whole set after install
- That `office` cannot reach root, and cannot run anything but `/usr/bin/tmux`
- That `TMUX_AGENT_USERS` and the sudoers file agree — two lists that must not drift
- **Node 22 exactly** (`v22.23.2`), closing ticket 001's criterion. `package.json` declares
  `">=22"`, so the earlier v24 run satisfied it vacuously
- The provisioning steps themselves

### §7 results — 2026-09-22, container, Debian 12, tmux 3.3a, Claude Code 2.1.278

| Row | Outcome | Detail |
| --- | --- | --- |
| `nopasswd` | ok | the grant works non-interactively |
| `tmux_path` | ok | `tmux 3.3a` at `/usr/bin/tmux`, matching the rule byte for byte |
| `socket` | **per_user** | agent `/tmp/tmux-1002/default`, office `/tmp/tmux-1001/default` — re-verified live, each server sees only its own session |
| `whoami` | ok | pane reports `gluy` |
| `home` | ok | `HOME=/home/gluy`, matching `getent passwd` |
| `config_dir` | present | `CLAUDE_CONFIG_DIR` set via `new-session -e` reaches the pane process |
| `isolation` | ok | the agent user's tmux cannot see or kill a session owned by `office` |

This answers the question 015 and 008 were both exposed to: *"If the two users share a tmux
socket, or `$HOME` does not follow, provisioning and session isolation are both wrong, and the
failure looks like 'the agent used the wrong login'."* They do not share, and it does follow.

The socket row was re-checked with a session running under **each** account, because the harness
reads the path from a server that may not exist yet and would otherwise report two "no such file"
paths that merely differ by uid. Live: the paths differ, and `office sees: officelive` /
`agent sees: agentlive` — mutual invisibility, not inferred from path strings.

## What this CANNOT prove

**Per-agent RSS, and every timing.** Docker Desktop on Windows runs on the WSL2 kernel —
measured on this machine:

```
kernel 6.18.33.2-microsoft-standard-WSL2    MemTotal 8.29 GB
```

That is the same Microsoft-patched kernel, the same Hyper-V utility VM and the same ballooned
memory that spike 003 already warned its numbers came from — and the same 8 GB host the spike
recorded (`MemTotal 8 097 908 KB`). **A container here adds no fidelity to a memory or timing
number.** Ticket 018's cap still has no target-measured input, and ticket 007 still owns the
VPS re-measurement.

If a real figure is wanted before renting a box, the middle option is a Hyper-V or VirtualBox VM
running stock Ubuntu with **statically assigned** RAM: no Microsoft-patched kernel, no
ballooning, so the memory accounting is real. Still not the VPS's CPU, disk or contention.

**Whether `CLAUDE_CONFIG_DIR` keeps two logins authenticated simultaneously.** That is an
account question, not a host question, and the answer is identical in a container and on a VPS.
Still open — see `docs/spikes/001-hook-payloads.md`.

## A harness bug this found — now fixed

**Fixed in `spikes/tmux/drive-session.sh`; recorded here because the failure mode is worth
recognising.** Both the `doctor` and `sudo-parity` preconditions probed for the sudo grant with:

```sh
sudo -n -u "$SPIKE_USER" true
```

A **correctly scoped** sudoers file denies that, because the rule permits `/usr/bin/tmux` and
nothing else. Verified in the simulator:

```
true:  DENIED
tmux:  ALLOWED
```

So with the real `deploy/host/sudoers.d/office` installed and working, `doctor` reports
`sudo unavailable` and `cmd_sudo_parity` **skips every row** with "no passwordless rule, or a
password is required" — a false negative pointing at the one file that is correct. On the VPS
this reads as "provisioning is broken" and costs a session.

The fix is to probe with the command the rule actually permits:

```sh
sudo -n -u "$SPIKE_USER" "$SPIKE_TMUX" -V
```

Two call sites: `cmd_doctor` and the `cmd_sudo_parity` precondition. Both now probe with
`"$SPIKE_TMUX" -V`, and `doctor` reports `passwordless sudo to gluy for /usr/bin/tmux works`
against this image. The §7 table above is produced by the repo's own harness, unpatched.

## Authentication — mount a copy, never the live directory

The image installs Claude Code but deliberately does **not** log in. A Claude login on this
account is single-session: authenticating inside a container can cost the host session.

```sh
cp -r ~/.claude /tmp/claude-copy
# then in deploy/vps-sim/compose.yml, under volumes:
#   - /tmp/claude-copy:/home/gluy/.claude
```

Without auth, `doctor` and `sudo-parity` run in full. The subcommands that drive a live TUI —
`deliver`, `chars`, `interrupt`, `session-end`, `rss` — need an authenticated agent, because
they all call `start_agent` and wait for the composer. Note `chars --mode compose` needs the
agent but spends no tokens: it types into the composer and never presses Enter.

## Related: the suite on Linux

`deploy/linux-check/` runs the repo's own tests inside this same image, against the dev database.
Every test run before 2026-09-22 happened on Windows; the suite now passes on Linux too — 218
passed, 1 skipped, the same as Windows — using the TLS material `provision-host.sh` generates, so
the certs are exercised rather than assumed.

## What is left for the real VPS

1. Per-agent RSS, idle and mid-turn, for an agent that has MCP servers, hooks, a role file and
   a real repo — ticket 018's cap depends on it
2. Delivery, interrupt and `session-end` timings under the VPS's CPU and contention
3. Whether `CLAUDE_CONFIG_DIR` keeps two logins authenticated at once
4. The account-name question: `deploy/host/sudoers.d/office` ships the design's example names
   (`gluy`, `user2`, `user3`) and says to regenerate per host
