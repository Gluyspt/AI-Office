---
id: "040"
title: "Control service: its own process, its own privilege"
build_step: boundaries
department: dev
estimated_model: opus
blocked_by: ["028", "034", "038", "039"]
---

# 040 — Control service: its own process, its own privilege

**Build step:** boundaries
**Department:** dev
**Estimated model:** opus — the first real process boundary in the system, holding the `sudo` grant, and the ticket where a wrong transport choice is expensive to undo.
**Blocked by:** 028 (its pause/resume split — see "The prerequisite"), 034, 038, 039

## Why

This is the one process split worth paying for, and it pays three ways.

**Least privilege.** `control` holds the scoped `sudo` grant that starts and messages agent sessions
as other Linux users. 007's own measurement found how sharp that is: the shipped sudoers default
named a login in `docker`, giving `office` a two-hop path to root while the provisioner printed
`ok`. Today that privilege is reachable from any code in the server process — a bug in the chat
transcript, the board, or a JSON parser is a bug in a process that can `sudo -u agent1`. Splitting it
means the privileged surface is one small process with one job, and the web app that handles browser
traffic does not hold the grant at all.

**Crash isolation that the design already assumes.** The reliability table says *"Hard crash or OOM →
Supervisor polling tmux → mark `paused`, keep locks, offer Resume"*. That contract is much easier to
honour when the thing that crashed is not also the thing that was supposed to notice. On a 3.2 GB box
with ~290 MB agent sessions, OOM is a real event, not a hypothetical.

**Independent deploy, demonstrated once.** 038 proves services *could* be extracted. Until one
actually is, that proof is a test asserting a property nobody has exercised. This exercises it on the
service where the boundary is most constrained — host-only, privileged, called by `chat` and by the
UI — so the transport and the failure handling are designed against the hard case rather than an easy
one.

And it is the split that gets more expensive every month it waits: every new ticket that calls into
`control` in-process is another edge to unpick.

## The prerequisite — found 2026-10-12, after this ticket was first written

Answering the design's Q2 ("do `tasks` and `locks` stay one deployment unit?") meant counting the
transactions that span two services instead of recalling them. There are four, not one, and **two of
them start here**:

- `pause` (`orchestrator/pause.ts:856`) — `transition(…, client)` and `setLocksPaused(taskId, true,
  client)` in one transaction, so a paused task can never exist with unmarked locks the sweeper will
  expire out from under it.
- `resume` (`orchestrator/resume.ts:482`) — `transition`, `setLocksPaused(false)` and `heartbeat`,
  with the file's own comment saying why all three: *"a paused lock's TTL has almost certainly
  expired while the work was paused, so clearing `paused` without restarting the clock hands the
  sweeper a live-but-expired lock and the task loses the files it was resumed to work on."*

**So `control` as it stands cannot move to another process.** A transaction cannot span two
processes, and a saga here is rejected for the reason in §3.1 of the design: a compensating action
can itself fail, producing the state the transaction made unreachable.

The resolution is not a saga and not a deferral. **Pause and resume are two decisions wearing one
function:** "kill the agent and its tmux pane" is `control`'s, and "move the task and mark its
locks" belongs wholly inside the tasks+locks unit. Splitting them along that line leaves each
transaction inside one deployment unit and leaves `control` holding only what needs the host.

That split is a dated section on **028**, which owns `pause.ts` and `resume.ts`, and it is **the
first work of this ticket, not a follow-up** — hence 028 joining the blocked-by list. It is also why
this ticket's estimate should be treated as the softest of the eight.

## Scope

### Files created

- `packages/control/package.json`, `packages/control/tsconfig.json` — the new workspace package
- `packages/control/src/index.ts` — the process entry: binds its RPC listener, drops nothing it does not need, shuts down gracefully the way `core/server.ts` does
- `packages/control/src/rpc-server.ts` — serves the `control` contract
- `packages/control/src/health.ts` — liveness, plus the "am I still the only one holding the grant" self-check
- `packages/server/src/platform/rpc/contract.ts` — the transport-agnostic call shape, errors, and timeout semantics
- `packages/server/src/platform/rpc/client.ts` — the caller side, with the unreachable-peer behaviour below
- `packages/server/src/platform/rpc/client.test.ts`
- `packages/server/src/platform/rpc/server.ts` — the callee side
- `deploy/host/office-control.service` — the systemd unit: which user it runs as, its restart policy, and its memory accounting
- `docs/runbooks/control-service.md` — what a human does when it is down, how to tell "down" from "wedged", and the first thing to check

### Files modified

Pointing `chat` and the UI's session endpoints at the RPC client instead of a direct import edits
files owned by **010** (`chat/routes/chat.ts`, `chat/conversations.ts`) and **008**
(`orchestrator/routes/sessions.ts`). Dated sections on both, per the reopening rule; their criteria
are blocking below. `deploy/host/provision-host.sh` is unowned and gains the unit installation.

## Decided

**`control` keeps the whole of the session lifecycle, including the message queue.** The decision of
2026-10-07 — *"the orchestrator owns the mid-turn message queue, and the queue must survive a
restart"* — is what makes this split safe rather than risky: the queue is already specified to be
durable across a restart, so a process that can be restarted independently is what that decision was
for.

**One consequence must be stated plainly: a restart of `control` is now independent of the web app,
and the queue is the only thing that makes that non-destructive.** If the durable queue is not
actually durable, this split turns a web-app deploy into lost agent messages. The queue's
restart-survival test is therefore a blocking criterion here, not an assumed property.

**Transport: loopback HTTPS, not a Unix socket.** The decision that every endpoint in this system is
`https` including on loopback already exists and already has TLS material provisioned
(`scripts/dev-cert.mjs`, `provision-host.sh`). A Unix socket would be faster and would need its own
permission model, its own dev-environment story on Windows, and an exception to a settled decision.
`control` is a warm path — starting and messaging sessions — so the handshake cost is not on anyone's
critical path. **Loopback only, 127.0.0.1, as `core/server.ts` already binds.**

**The caller fails loudly, never silently.** An unreachable `control` means sessions cannot be
started or messaged, and the honest response is a refusal that names the control service and a
degraded state in the UI — the same shape 020's guard already established for an unreachable
orchestrator, including the existing banner. What it must *not* do is retry quietly: a queued message
that silently waits on a dead process is indistinguishable, from the user's side, from a message
delivered to an agent that ignored it.

**No supervisor change.** Polling tmux stays where it is, inside `control`, because it is the thing
closest to tmux. What changes is that `control` crashing is now visible as a process that systemd
restarts, with the web app still up to show it.

## Acceptance criteria

- [ ] `control` runs as its own process and the server process starts and serves the board, chat
      transcript and task API with `control` **stopped**.
- [ ] With `control` stopped, starting or messaging a session refuses with a message naming the
      control service, and the UI shows the degraded state. No silent queueing.
- [ ] With `control` restarted, a message queued before the restart is delivered — the durable-queue
      criterion, asserted across a real process restart rather than a mocked one.
- [ ] The server process does **not** hold the `sudo` grant: asserted by running it as an account
      with no sudoers entry and confirming everything but session control works.
- [ ] `control` holds no browser-facing route.
- [ ] Session start, message, interrupt, pause and resume behave identically across the boundary —
      008's and 028's existing tests pass against the RPC client.
- [ ] **Pause and resume each still commit in ONE transaction, and it sits wholly inside the
      tasks+locks unit** — no leg of it crosses the RPC boundary. Asserted by killing `control`
      mid-pause: no task is left `paused` with unmarked locks, and no lock is left `paused` on a
      task that never moved. This is the criterion the prerequisite exists for; if it cannot be met,
      the split does not land.
- [ ] A resumed task's lock TTL is restarted in the same commit as its transition, across the new
      boundary — `resume.ts`'s stated reason, re-verified rather than assumed to survive the move.
- [ ] A message at the tmux size limit still works across RPC: `maxMessageBytesFor(name)` is computed
      where tmux is, in `control`, not by the caller. (007's finding — the session name eats the
      payload — means a caller that computes this is computing it against the wrong name.)
- [ ] The dialog-state gate still holds: a message delivered while a permission dialog is up
      approves the pending call (confirmed 20/20 on the target), so the gate must be enforced inside
      `control`, after the RPC hop, not before it.
- [ ] RSS of both processes measured on the real VPS, with the agent ceiling recomputed. The design
      budget is ~290 MB per desk on 3.2 GB; this ticket spends about 80 MB and must say what that
      costs in desks.
- [ ] systemd unit: restarts on failure, has a memory limit, does not restart in a tight loop, and
      logs where the runbook says it does.
- [ ] 038's graph shows `control` as extracted, and its host-only verdict is now a fact rather than a
      declaration.
- [ ] **010 and 008 reopened** with dated sections for the call-site changes; both checked before
      this closes.

## Open questions

- [ ] **Serialisation format** — 038's open question, which this ticket forces. `tasks` and session
      records carry `Date`s (`acquired_at`, `receivedAt`, `started_at`); over HTTPS+JSON those become
      strings and every call site that does date arithmetic is a silent bug. Needs deciding before
      the client is written: explicit codecs per contract type, or a shared serialiser with a test
      that round-trips every contract type. Leaning the latter.
- [ ] Does `control` get its own database connection and its own `LOGIN` role now (035's
      `control_svc` becoming a real login), or does it keep calling through the shared config?
      Its own is the point of 035 and is more work here. Leaning its own, because a process that
      holds `sudo` should not share a database credential with the process serving browsers.
- [ ] How does the web app discover `control`? A port in config is enough for one host and is what is
      assumed. It is also the first thing that breaks if the office ever spans two boxes — which step
      12 contemplates. Not solving discovery for one process; noting where it would go.
- [ ] Whether `realtime` should also move, so a web-app restart does not drop every open WebSocket.
      Plausible, cheap, and out of scope — but if it is wanted, doing it alongside this ticket costs
      far less than doing it afterwards.
