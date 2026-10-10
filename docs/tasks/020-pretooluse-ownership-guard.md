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
- `packages/server/src/features/locks/routes/guard.ts` — `POST /guard/check` and `POST /guard/flush`
- `packages/server/src/features/locks/guard-check.ts` — decision logic over ticket 015's registry, plus the heartbeat refresh
- `packages/server/src/features/locks/unguarded-edits.ts` — ingest a flushed buffer, check retroactively whether any unguarded edit touched a file owned by a different active task, flag those tasks for review
- `packages/server/src/features/locks/handlers/tool.ts` — records tool events and refreshes the lock heartbeat
- `db/migrations/0010_unguarded_edits.sql` — the unguarded-edit log and the review flag on tasks

### Files modified

None.

## Acceptance criteria

- [x] An agent editing a file owned by another active task is blocked, and the feedback it receives names the owning task and its owner.
- [x] An agent editing a file inside its own declared scope proceeds with no visible delay.
- [x] An agent editing a file owned by **nobody** proceeds — the guard enforces the registry, it does not require every file to be claimed. A test covers this explicitly, since the opposite behaviour would stop all work.
- [x] Read-only tools are never blocked; only mutating tools are checked, and the checked list is enumerated in one place.
- [x] **The check times out at ~2 s.** An agent never hangs waiting on an unreachable orchestrator; the timeout is config, and a test with a stalled endpoint asserts the agent proceeds.
- [x] **On a failed check the guard fails open and appends the attempted edit to a local buffer file.** It cannot POST a warning when the orchestrator is down, so it buffers on disk — asserted with the server stopped.
- [x] **The buffer flushes on the next successful check**, and is cleared only after the orchestrator acknowledges it.
- [x] **On receiving a flush, the orchestrator checks retroactively** whether any unguarded edit touched a file owned by a different active task, and flags those tasks for review. Asserted end to end: stop the server, have an agent edit a file owned by another task, restart, and confirm both tasks are flagged.
- [x] A flush that arrives twice does not double-flag; flushes are idempotent by edit id.
- [x] Guard degradation and recovery are emitted as events, so the UI can show a degraded-guard banner while checks are failing and list the unguarded edits afterwards.
- [ ] The buffer file is written under a path owned by `office`, is size-capped, and drops oldest-first with a recorded count rather than growing without bound.
- [x] Guard latency is measured under 100 sequential tool calls and recorded; the number appears in the ticket's completion summary.
- [x] The heartbeat refresh keeps a lock alive across a long-running task — a test with a short TTL asserts the lock never expires while tools are being used.
- [x] The guard script passes `shellcheck` and never interpolates payload text into a shell command.
- [x] The script does not read or log file contents, only paths.

## Decided

**Fail open, but never silently.** An unreachable orchestrator must not freeze every agent on the box, so the edit proceeds — and the guard buffers it to disk, flushes on recovery, and the orchestrator then works out retroactively whether anything was actually violated. During an outage the protection degrades to `claim_task` alone; afterwards, the damage is enumerated rather than guessed at.

- **The guard endpoint is `https`**, per the system-wide decision (see the ticket index). Transport
  only — `"type": "http"` stays the hook-config keyword.
- **The 2 s fail-open needs an explicit `"timeout": 2`** on the hook entry. Spike 002 measured the
  default at 30 s, and it stalls the turn.
- **An `http` hook blocks with a 2xx whose body carries `decision`/`continue` — not an exit code, and a
  non-2xx does not block.** The blocking field differs per event, and
  `hookSpecificOutput.permissionDecision` did *not* block the event it was tested on. The `PreToolUse`
  mapping specifically is **unverified**, so this ticket must confirm it before building on it.
- **`!` bash mode bypasses `PreToolUse` entirely.** The guard constrains the agent, not the session:
  anyone with the tmux pane can run shell commands it never sees. Document the limit; do not claim
  coverage the mechanism does not have.

## Open questions

- [ ] The retroactive check finds conflicts after the fact, when both agents may have already edited. It flags for review; it cannot undo. Whether a flagged task should also be paused automatically is unaddressed by the design — not implemented, because auto-pausing on a stale signal is its own failure mode.
- [x] **The blocking mechanism depends entirely on ticket 002.** If an http hook can block, the script may be unnecessary and the fragment points straight at the event server. If it cannot, the command script is the only path and its per-call latency becomes a real cost. This ticket's scope assumes the script; drop it if 002 says otherwise. **— ANSWERED: an http hook CAN block a PreToolUse (spike 001 §2b), so the http entry does the deciding. The script is kept anyway, for the one thing an http hook cannot do: write the outage record to disk. See `### Decided` below.**
- [x] The design lists `PostToolUse` as the heartbeat trigger but does not include it in its hook config block. This ticket registers it in the fragment. If that is wrong, the heartbeat has no source and ticket 015's TTL will expire live locks. **— ANSWERED, and the ticket text above is overruled: `PostToolUse` is NOT registered. The heartbeat hangs off the base template's existing unmatched `PreToolUse` entry, for three reasons in `### Decided` below, and a test asserts the fragment adds no `PostToolUse` entry.**
- [ ] What the guard should do about a tool call that mutates a file *outside* the repo (a global config, a temp file) is unspecified. Currently allowed; worth revisiting once agents run unattended.
- [ ] The design notes hooks run shell commands on a box holding three people's logins, and says to read every hook script before installing. That review is a human step this ticket cannot self-certify — request it explicitly at completion.

## Landed 2026-10-10

**7 scoped files created, 5 test files, 1 migration applied. 744 passed, 1 skipped, 37 files;
typecheck clean on all three packages.** The baseline before this ticket was 673 / 1 / 32, so this
adds 71 tests and 5 files and regresses nothing.

Everything in this section was run on a Windows authoring machine against the dev Postgres in
Docker. Anything needing a live Claude Code desk or a Linux host is marked `UNVERIFIABLE-HERE`
with the reason, not ticked on the strength of code that looks right.

### Decided: an `http` hook blocks, AND the script still earns its place

The ticket's open question was whether the script is needed at all. Spike 001 §2b answered the
first half on build 2.1.278, and it **overrules the design's "hooks block by exiting with code
2"**: an `http` hook blocks a `PreToolUse` outright with
`hookSpecificOutput.permissionDecision: "deny"`, and blocking is carried by the **body of a
2xx** — a 500 does not block. So the decision needs no script, and does not pay the ~20 ms
process spawn the spike measured for a `command` hook. The guard's http entry is therefore the
thing that refuses an edit.

**The script is kept, for exactly one reason: an http hook cannot write a file.** This ticket's
own Decided section says the guard fails open but *never silently* — it buffers the attempted
edit to disk, flushes on recovery, and the orchestrator then works out retroactively what was
violated. An http hook that cannot reach the orchestrator simply fails; it leaves no record, and
`POST /guard/flush` would have nothing to receive. That is the whole justification, and it is why
the script's only jobs are *probe, buffer, flush* — it never repeats the decision on its normal
path and always exits 0.

So the fragment registers **two** hooks in one group: the http entry decides, the command entry
records. They run concurrently (spike 001: in 19 of 20 samples the http POST arrived before the
command hook had even started), so adding the script costs its own duration, not the sum.

Four corollaries written into the code:

- **`continue: false` is never emitted, and there is no code path to it.** Measured twice: the
  tool runs IN FULL and then neither `Stop` nor `StopFailure` fires. As an ownership guard it
  would leak precisely the content the guard protects and hang the chat panel's spinner forever.
  A test asserts the string `continue` is absent from every body the guard sends.
- **Both blocking fields are sent at once.** `permissionDecision` is authoritative on
  `PreToolUse` and inert on `UserPromptSubmit`; top-level `decision: "block"` blocked both. The
  mapping is per-event and has already moved once, so sending one field only would fail silently
  on a future build.
- **An allow carries NO `hookSpecificOutput` at all.** `permissionDecision: "allow"` is not the
  opposite of `"deny"` — it means *bypass the permission system*, which would auto-approve the
  writes the design wants a human to see through the `PermissionRequest` hook. The allow body
  reports under an `office` key the hook client ignores. This was nearly a serious bug.
- **`OFFICE_GUARD_ENFORCE=1`** turns on a second mode where the script also asks `/guard/check`
  and exits 2 on a refusal. Off by default, because the http entry already blocks and enabling it
  doubles the requests per tool call. It exists as the lever to pull if a build changes the
  blocking vocabulary again — "it blocks today" is not "it blocks forever". Tested: exit 2, the
  orchestrator's reason on stderr, and no refusal when the orchestrator is merely unreachable.

### Decided: the heartbeat hangs off `PreToolUse`, not `PostToolUse`

This ticket's open question said to register `PostToolUse` in the fragment. **It is not
registered, and the fragment adds no `PostToolUse` entry at all** — a test asserts that. The
heartbeat is an event handler on `PreToolUse`, which the base template already delivers to
`/events/tool` with no matcher, so it needed no new hook entry. This also closes ticket 015's
explicitly-open "what triggers a heartbeat". Three reasons, in order of weight:

1. **`PostToolUse.tool_response` carries the tool's entire output** — for a `Read` the whole file
   body, for a `Write` everything written (spike 001 §5). Registering it would push a copy of
   every source file an agent touches into the `events` table, which the spike flags as a real
   size *and* confidentiality question. `PreToolUse` already flows there; a second copy buys
   nothing.
2. **It is strictly more frequent.** `PreToolUse` fires before every tool call including
   read-only ones — all of which are proof the agent is alive, which is all a heartbeat asserts.
   A turn that halts *at* a tool call fires no `PostToolUse` and no `Stop` either.
3. **It cannot be silenced by a block.** The guard's own refusals stop `PostToolUse` from firing.
   A heartbeat hanging off it would go quiet for a task being refused repeatedly, and the TTL
   would then expire the locks of an agent that is demonstrably still working.

### Decided: the retroactive check uses locks held AT THE TIME of the edit

Not locks held now. An outage is exactly when tasks finish and release their scope, so a
"currently held" check loses the collision the moment the owner completes. `file_locks` can
answer the historical question because 015 made release set a timestamp instead of deleting the
row. The window is widened by a five-minute grace either side, because `attempted_at` comes off
the *agent's* clock — a different machine, and this project's target host was measured stepping
its wall clock backwards twice in one session. A missing `attempted_at` falls back to "held at any
point", the conservative branch. Both directions are tested.

### Criterion-by-criterion

| # | Criterion | Verdict |
| --- | --- | --- |
| 44 | blocked, feedback names task and owner | **Met.** `guard-check.test.ts` "BLOCKS a file owned by another active task…" asserts the owning task id, its title and its owner in the reason; `routes/guard.test.ts` asserts the 200-plus-blocking-body over the real app. That Claude Code honours that body is spike 001 §2b's measurement, not this run's — see UNVERIFIABLE-HERE. |
| 45 | own scope proceeds, no visible delay | **Met.** Two tests (own scope via `sessions.id` and via the Claude session id), plus the latency figure below. |
| 46 | a file owned by nobody proceeds | **Met.** Its own test, as the criterion demands. |
| 47 | read-only never blocked, list in one place | **Met.** `CHECKED_TOOLS` in `guard-check.ts` is authoritative; `GUARD_MATCHER` is derived from it and a test asserts the **shipped fragment's** matcher still equals it, so the two cannot drift. Six read-only tools asserted to allow without touching the database. |
| 48 | ~2 s timeout, config, stalled endpoint | **Met.** Both halves. Server side: `GUARD_CHECK_TIMEOUT_MS` set to 1 ms makes the check abandon itself and allow. Script side: a real listener that accepts and never answers — the shape a wedged orchestrator actually has — and the script exits 0 and buffers. |
| 49 | fails open, buffers to disk, asserted with the server stopped | **Met.** Three failure shapes, all real: a dead port (ECONNREFUSED, which is what a stopped server gives you), a listener that never answers, and a 401 — asserted to be a *real* 401 (curl exit 22, one request received) rather than a timeout wearing its clothes. |
| 50 | flushes on the next successful check, cleared only after the ack | **Met.** Two failures then a success: both lines arrive as one array, the spool is gone, and no spool file is left behind. The negative is asserted too — an unacknowledged flush keeps the buffer, and the earlier line is still in it. |
| 51 | retroactive check flags both tasks, end to end | **Met, with the agent stood in for.** `guard-script.test.ts` "the whole outage, end to end" runs the **real script** against a dead port, reads the buffer file it actually wrote off disk, and POSTs it **verbatim** to the real `/guard/flush` on the real app — both tasks come back flagged. The join between the two halves is a file format, which is the part a test can hold; every other flush test builds the buffer by hand, this one does not. What is missing is a live Claude desk issuing the edit. |
| 52 | a twice-arriving flush does not double-flag | **Met.** Second flush: 0 accepted, 1 duplicate, 0 conflicts, nothing newly flagged, and `review_flagged_at` does not move. One row, one finding. |
| 53 | degradation and recovery as events | **Met.** Both sources. Live (`source: "check"`) when the orchestrator is up but its check is failing, debounced to one event per outage rather than one per tool call — asserted with five consecutive failures producing exactly one `GuardDegraded`. Retroactive (`source: "flush"`) for an outage this process never saw, bracketing the buffered window, with `GuardDegraded` asserted to precede `GuardRecovered`. An empty probe flush raises no degradation. |
| 54 | buffer under a path owned by `office`, size-capped, drops oldest-first with a count | **PARTLY MET — left unticked.** Size cap, oldest-first drop and the recorded count are fully tested (5 failures at a cap of 3 leaves the newest 3 and a dropped count of 2, reported to the orchestrator on the next flush and then reset). The **ownership clause is not met as written, deliberately** — see "A deviation" below. The 0600 mode is `UNVERIFIABLE-HERE`. |
| 55 | latency over 100 sequential calls, recorded | **Met.** See below. |
| 56 | heartbeat keeps a lock alive across a long task, short TTL | **Met.** A 2-second TTL, four tool calls a second apart, with the real `expireLocks()` sweeper run after **every** heartbeat — the hostile version. The lock never expires. The paused case is asserted too: a paused lock's deadline is left alone, because a paused task already owns its files unconditionally. |
| 57 | shellcheck, and never interpolates payload text | **Met.** `shellcheck` 0.11.0 reports **nothing at all** at every severity (exit 0), plus `bash -n`. The interpolation property is *proven, not read*: a stub curl records its argv, and the test asserts the file path, the session id and the file content are all absent from it while `--data-binary @-`, `--cacert` and `--max-time` are present. |
| 58 | does not read or log file contents, only paths | **Met, and mutation-verified.** The jq filter names four path fields and emits nothing else. Adding `tool_input` back into that filter turns two tests red. The server half is covered too: the `GuardEditBlocked` event is asserted not to contain the file body. |

**Guard latency, 100 sequential checks** against the real registry with four held patterns in the
project: **min 2.06 ms / p50 3.19 ms / p95 4.56 ms / max 6.04 ms** (a second run of the same test:
2.2 / 3.43 / 5.54 / 7.6). This is the server-side decision only — Windows, Postgres in Docker on
the same box. Add spike 001's transport figures for the real cost at the agent: the http hook pays
sub-millisecond loopback transport and no spawn; the command hook beside it pays ~20 ms, almost
entirely process spawn, concurrently. Nothing here is a measurement from the target VPS.

### A deviation, stated rather than quietly absorbed

**The buffer lives under the agent account's `$HOME/.office/`, not under a path owned by
`office`.** The criterion was written when the design assumed a single `office` user. The decision
recorded in the ticket index since — one shared orchestrator, one Linux user per *teammate*, with
purpose-created `agent1/2/3` accounts — means the script runs as the agent, and an account cannot
write into a directory owned by another user. The directory is created 0700 and the buffer 0600,
private to the account that wrote it. If a shared, agent-unwritable buffer is wanted it needs a
group-writable drop directory provisioned by the host, which is `provision-host.sh`'s file rather
than this ticket's.

### What this guard cannot cover — documented, not claimed

- **`!` bash mode bypasses `PreToolUse` entirely** (spike 001 §8.4). The guard constrains the
  agent, not the session: anyone with the tmux pane can run shell commands no hook ever sees.
- **`Bash` tool calls are not checked.** `tool_input` carries a `command`, not a path, so
  `sed -i`, a redirect or `git checkout` are mutating writes with nothing to compare. `Bash` is
  deliberately absent from `CHECKED_TOOLS` rather than guessed at.
- **A file outside the agent's `cwd` is allowed**, and recorded as `skipped: "outside_cwd"` so the
  decision says what it did not examine. This is the ticket's open question, left open.
- **`MultiEdit` is in the matcher and is not known to exist on 2.1.278.** Naming a tool that does
  not exist costs nothing; missing one that appears later would edit unguarded.

### Two bugs the tests found, which reading the code did not

1. **Every outage was recorded as "curl exit 0".** `last_curl_status=$?` sat after an `if`, and
   `$?` following a compound statement is the *compound's* status — 0 whenever the condition was
   merely false. The reason string is the only place that number is ever read, and the test that
   asserts on it is what caught it. Fixed by capturing the pipeline's status directly.
2. **Two script tests passed for the wrong reason.** They used `spawnSync` against an in-process
   HTTP listener; `spawnSync` blocks node's event loop, so the server could never answer and curl
   always timed out. The "401 is an outage" case was really measuring a timeout and proved nothing
   about a 401. Fixed with an async spawn helper, and the 401 case now asserts curl exit **22** and
   that the listener received exactly one request.

### UNVERIFIABLE-HERE

- **The http hook actually blocking a live agent.** No `claude` session, no tmux and no live login
  on this machine. The blocking *shape* is spike 001 §2b's measurement on 2.1.278 (read off whether
  `PostToolUse` fired and what its `tool_response` held); what this ticket verifies is that the
  server emits exactly that shape on a 2xx. The two together are the claim.
- **The `0600` buffer mode and `0700` directory mode.** MSYS synthesises POSIX modes from Windows
  ACLs — the test prints the mode it saw (`666`) and says it proves nothing, rather than asserting
  its way to a false pass. On a POSIX host the same test asserts no group or other bits.
- **The script's mode 755 and its ownership by an account agents cannot write to.** This repo
  records every `.sh` as `100644` and `core.filemode` is false here, so git cannot carry it. It has
  to be set at install time, and nothing in this ticket's scope does that — see "Still owed".
- **`jq` on the real agent box.** The outage path needs it to extract paths. Verified here against a
  real `jq` 1.7.1 located in the npm cache; `apt-get install jq` is a host prerequisite. The no-jq
  path is tested too, and records the attempt with no path and an `extract_note` saying so.
- **Per-call latency on the target VPS.** Every number above is from this Windows box.

### Still owed, and by whom

- **A human must read `hooks/pretooluse-guard.sh` before it is installed.** The design says so
  because hooks run shell commands on a box holding three people's logins, and this ticket cannot
  self-certify that. Requested explicitly, as the ticket's last open question instructs.
- **Install-time steps nothing in this ticket's scope can do:** `chmod 755` plus ownership by root
  or `office` on the guard script (so an agent cannot rewrite its own guard), and `jq` on each
  agent box. Both belong to `scripts/provision-user.sh` or `deploy/host/provision-host.sh`, which
  are tickets 009's and 007's files.
- **Ticket 017 must settle what `file_locks.session_id` holds** — the orchestrator's `sessions.id`
  or the Claude session id. Nothing in the repo says, the migration's comment implies the former
  and the `SessionEnd` release path only ever has the latter. The guard accepts **both**, because
  the error directions are asymmetric: refusing an agent its own declared scope stops all work,
  while accepting either cannot grant ownership to a third party (the two id spaces do not collide
  — one is minted by Postgres, the other by the CLI). Tested both ways. 017 should pick one, and
  `lockBelongsToCaller` can then lose a branch.

### Out of declared scope, added deliberately

`GET /guard/unguarded-edits` lives in `routes/guard.ts` beside the two endpoints the scope names.
Ticket 029's `UnguardedEdits.tsx` has to list these rows and owns only web files, so without a read
endpoint here that ticket would have to add a server route and break its own scope. One file, one
ticket still holds — it is in this ticket's own file.

### Open questions, updated

- **The blocking mechanism** — answered above, with reasons. Both halves kept, for different jobs.
- **`PostToolUse` as the heartbeat trigger** — answered above. Not registered; `PreToolUse` is the
  source, and the fragment is asserted to contain no `PostToolUse` entry.
- **Auto-pausing a flagged task** — still not implemented, and the reason is now written into
  `0010_unguarded_edits.sql`: the signal is stale by construction, so `review_flagged` is a flag
  *beside* the state machine rather than a state inside it. Nothing in 0005's transition rules has
  to learn about it, and clearing it is one update rather than a transition needing a legal
  predecessor.
- **A tool call mutating a file outside the repo** — still allowed, now visibly: the decision
  records `skipped: "outside_cwd"` instead of silently examining nothing.
- **A human reading the hook script** — requested; see "Still owed".
