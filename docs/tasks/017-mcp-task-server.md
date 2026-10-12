---
id: "017"
title: "MCP task server: claim_task and complete_task"
build_step: 2
department: dev
estimated_model: opus
blocked_by: ["013", "014", "015", "016"]
---

# 017 — MCP task server: claim_task and complete_task

**Build step:** 2 — Coordination
**Department:** dev
**Estimated model:** opus — this is the contract between agents and the coordination layer, and every refusal it returns is a prompt the model has to act on.
**Blocked by:** 013, 014, 015, 016

## Why

This is how an agent actually takes work. The design specifies both tools precisely:

- `claim_task(task_id)` — checks owner match, dependency state, and file-scope overlap, then locks
- `complete_task(task_id, summary, learning)` — requires a learning entry, a rebase, then pushes and opens a PR

The git half of `complete_task` belongs to step 4, so this ticket builds the coordination half and
leaves a named seam for it.

## Scope

### Files created

- `packages/mcp-tasks/package.json`
- `packages/mcp-tasks/tsconfig.json`
- `packages/mcp-tasks/src/index.ts` — server entry, transport per ticket 016's recommendation
- `packages/mcp-tasks/src/office-client.ts` — typed HTTP client to the orchestrator, carrying the session identity ticket 016 settled on
- `packages/mcp-tasks/src/tools/claim-task.ts`
- `packages/mcp-tasks/src/tools/complete-task.ts`
- `db/migrations/0014_task_learning.sql` — adds `tasks.learning` (see "Where the learning entry
  goes" below). **Allocated 2026-09-23**: this ticket had no migration in its file scope and the
  column it is told to write to does not exist, which is the kind of gap that becomes an
  improvised schema change at 1am. Numbered 0014 because 0008–0012 are claimed by unwritten
  tickets and 0013 was used by a maintenance fix
- `packages/server/src/features/tasks/claim.ts` — the transactional claim: owner check, dependency check, lock acquisition, state transition
- `packages/server/src/features/tasks/complete.ts` — summary and learning required, locks released, transition to ready for QA
- `packages/server/src/features/tasks/routes/actions.ts` — `POST /tasks/:id/claim`, `POST /tasks/:id/complete`

### Files modified

None.

## Where the `learning` entry goes (settled 2026-09-23)

`complete_task(task_id, summary, learning)` **requires** a learning entry — the design is explicit
that a completion without one is refused. But **the knowledge graph, where that entry eventually
belongs, is build step 5**, and this ticket is step 2. This ticket's own open question said "stored
on the task row for now".

Two things about that were unfinished, and both are settled here rather than discovered mid-build:

1. **`tasks` has no `learning` column.** Nothing in 0005 or any later migration adds one, so the
   instruction to "store it on the task row" pointed at a column that does not exist.
2. **This ticket had no migration in its file scope**, so adding the column had nowhere legitimate
   to live under one-file-one-ticket.

`db/migrations/0014_task_learning.sql` is now allocated to this ticket. Keep it minimal — a
nullable `text` column plus a comment naming step 5 as its destination. Deliberately *not*
structured, indexed or normalised: the graph is where this data acquires shape, relations and a
source, and building a second half-shaped store here would mean migrating out of two places at
step 5 instead of one.

**The step-5 migration path is: read every non-null `tasks.learning`, write it into the graph as a
fact sourced to the task, then drop the column.** Stated now so it is a known one-way door rather
than an archaeology problem later.

## Inherited requirement (added 2026-09-23)

- **`claim_task` and `complete_task` must call `announceTransition(result)` after their
  transaction commits.** Both pass their own client to `transition()`, and on that path
  `transition()` deliberately does not emit: `recordSystemEvent` writes through the shared pool
  rather than the caller's client, so an event emitted inside a transaction survives a `ROLLBACK`
  and announces a change that never happened. The caller owns the commit, so the caller owns the
  announcement. Without it the board will not move a card when an agent claims or completes work.

## Acceptance criteria

- [ ] `claim_task` succeeds only when all three checks pass; each failure returns a distinct, actionable message naming what blocked it and who owns the conflict.
- [ ] A claim by a session whose user is not the task owner is refused — asserted against a forged `owner` argument, proving the identity comes from the transport and not from the call.
- [ ] Claim is atomic: owner check, dependency check, lock acquisition and state transition happen in one transaction; a failure at lock acquisition leaves the task `pending` and no locks held.
- [ ] Two agents claiming the same task concurrently: exactly one wins, the loser gets a refusal naming the winner.
- [ ] `complete_task` rejects a call with an empty or whitespace-only `learning` and says why — the design makes the learning entry mandatory.
- [ ] `complete_task` moves the task to `ready for QA`, never `done`, and releases the task's file locks.
- [ ] The rebase and PR requirements are present as an explicit, named seam that currently returns "not implemented in step 2" rather than silently passing. A test asserts the seam is reachable, so step 4 cannot forget it.
- [ ] Tool errors reach the agent as readable text, verified with a real session calling both tools.
- [ ] Every claim and completion emits an event so the board updates live.

## Open questions

- [ ] `complete_task` in the design "requires rebase onto current `main-dev`, pushes the branch, opens the PR, triggers CI" — none of which exists before step 4. This ticket deliberately ships the tool without the git half. Confirm that a step-2 agent completing a task without pushing is acceptable for the interim, or whether step 2 should wait for step 4.
- [ ] The design does not say what happens to a claimed task whose agent dies before completing. Ticket 015's TTL releases the locks; nothing returns the task from `in progress` to `pending`. Assumed a human resumes it via ticket 028's pause/resume machinery. Confirm.
- [ ] Where the `learning` entry is stored is unspecified — the knowledge graph is step 5. Stored on the task row for now, with a note that step 5 migrates it.
- [ ] `approve_task`, `reject_task` and `deliver_task` are out of scope here; they belong to the QA gate in step 6. Listing them so the omission is visible.

## Landed 2026-10-12

Suite 828 passed / 1 skipped / 41 files; typecheck clean on all three packages.

### Scope revised: no `packages/mcp-tasks` package

The ticket's file scope was written **before** spike 003 ran, and said "server entry, transport per
ticket 016's recommendation" — deferring the shape to the spike. The spike's answer (§2, §7 change 7)
is that the office's MCP servers are **routes on the orchestrator's existing https listener**, not
processes: under stdio the count is servers × *agents*, which against a measured ~290 MB bare agent
and a ~6-agent ceiling on 3.2 GB spends the cap on process overhead and multiplies Postgres
connections — for tools that are thin wrappers over a database this process already serves. It also
puts `claim`/`complete` in the same process as `transition()`, which they must be, because an event
emitted inside a caller's transaction survives its ROLLBACK.

So four files in the original scope do not exist and will not: `packages/mcp-tasks/package.json`,
`tsconfig.json`, `src/index.ts`, `src/office-client.ts`. There is no HTTP client to the orchestrator
because there is no second process to need one. In their place:

- `packages/server/src/features/mcp/protocol.ts` — the JSON-RPC / streamable-HTTP plumbing, **shared
  with 018**, which mounts its own tools and adds no protocol code
- `packages/server/src/features/tasks/routes/mcp-tasks.ts` — the `office_tasks` server itself

The rest of the scope is unchanged: `0014_task_learning.sql`, `claim.ts`, `complete.ts`,
`routes/actions.ts`, plus three test files (`protocol.test.ts`, `claim.test.ts`, `complete.test.ts`
— 55 tests).

### Acceptance criteria

- [x] `claim_task` succeeds only when all three checks pass; each failure names what blocked it and
      who owns the conflict. Six distinct refusal kinds, each written as an instruction: an agent
      told *"src/app.ts is held by task 7b3…"* can act, one told *"claim failed"* retries until a
      human notices.
- [x] A claim by a session whose user is not the task owner is refused — asserted against a forged
      `owner` argument (and `session_id`, `actor`, `as`), proving the identity comes from the
      transport. `ClaimInput` has no field an agent could set.
- [x] Claim is atomic: owner, dependency, lock acquisition and transition in one transaction; a
      failure at lock acquisition leaves the task `pending` and no locks held.
- [x] Two agents claiming the same task concurrently: exactly one wins, the loser gets a refusal.
      **Tested twice, because the same-scope and different-scope races take different paths** — see
      "Two races, not one".
- [x] `complete_task` rejects an empty or whitespace-only `learning` and says why the entry is
      required rather than enforcing it silently.
- [x] `complete_task` moves the task to `ready for QA`, never `done`, and releases the task's file
      locks.
- [x] The rebase and PR requirements are an explicit named seam (`gitDelivery()`) returning "not
      implemented in step 2", whose message is repeated to the agent verbatim on every completion. A
      test asserts it is reachable AND that it tells the agent not to report the work as delivered —
      a lead reporting "merged" upward on the strength of a tool returning success is the failure
      this prevents.
- [x] Every claim and completion emits an event, through `announceTransition(result)` **after** the
      commit.
- [ ] **"Tool errors reach the agent as readable text, verified with a real session calling both
      tools."** The shape is built and asserted (`isError: true` with the reason in the text
      content, never a JSON-RPC error — spike 003 §4), but *verified with a real session* cannot be
      done from this host: it needs a live Claude Code MCP client, which is the batched run spike
      003 §8 is waiting on because a Claude login is single-session. **Open for a stated reason, not
      for want of looking.**

### Two races, not one

The concurrency criterion looked like one test and is two, which is worth recording because the
second found a real bug.

- **Same scope.** Both claims collide on the advisory lock inside `acquireScope`; the loser gets
  `scope_conflict`. This is the case the criterion imagines.
- **Different scopes.** They never collide in the lock registry at all, so both reach the
  transition. `expectedFrom: "pending"` makes the loser lose — but it lost by *throwing*
  `ConcurrentTransitionError`, which reaches a model as "the tool failed internally", i.e. as a
  reason to retry. Now a `wrong_state` refusal.

**And the bug underneath it: a refusal returned from inside `withTransaction` COMMITS.** The helper
commits what its callback returns and rolls back only what it throws, so the loser's refusal
committed the file locks it had already acquired — leaving a `pending` task holding a scope nobody
owned, blocking the next claim for a full TTL with nothing in any log to explain it. Both tools now
refuse by throwing a private `ClaimRefused` / `CompleteRefused` caught outside the transaction, so
"a failed claim leaves no locks held" is true by construction rather than by remembering to undo
each write.

The same hazard on the completion side is worse than it first looks: `complete_task` writes the
learning entry and releases the locks *before* its transition, so a completion refused because a
human paused the task mid-flight would have committed the release — and a paused task still owns its
files, by 028's explicit rule.

### Decided

**`claim_task` requires a `file_scope` until 019 — stated, not quietly chosen.** The design's
signature is `claim_task(task_id)` and says a task *has* a declared file scope, but nothing stores
one: 014 deferred `tasks.file_scope` to 019 and reads *acquired* scope from `file_locks` instead. At
claim time there is therefore no declared scope to read, and the only caller who knows is the agent.
The argument is optional in the signature and **refused when absent**, with a message saying what to
pass, because the alternatives are worse: a claim with no locks makes 020's guard inert for that
task (it only refuses edits to files *another* task holds), so two agents would edit one file with
the registry reporting no conflict — the exact failure the registry exists to prevent. Inventing a
default scope serialises the office. **When 019 stores a declared scope, `claim_task` reads it and
this argument becomes a narrowing; the refusal is a seam to delete, not a shape to build on.**

**Hand-written MCP protocol rather than `@modelcontextprotocol/sdk`.** The SDK was installed, read
and removed: v1.32.1 declares `express`, `hono`, `@hono/node-server`, `jose`, `ajv`, `cors`,
`pkce-challenge` and `cross-spawn` as hard dependencies, and its streamable-HTTP transport runs a
**hono** request listener — a second HTTP framework in a Fastify app's request path, for two tools,
on a box counting megabytes per agent. What it *was* used for is the part that mattered: its
`webStandardStreamableHttp.js` is the reference implementation, and every status code, header rule
and error code in `protocol.ts` was read off it rather than recalled (406 on a missing
`text/event-stream` in Accept, 415 on content-type, -32700 vs -32600, **202 with an empty body for a
batch containing no requests**, protocol-version validation, 405 on GET). `protocol.test.ts` is what
keeps the copy honest to it.

**Stateless: no `Mcp-Session-Id`.** The SDK makes the header conditional on a session-id generator,
and the office does not want one — it already has a session identity (the desk's own
`OFFICE_SESSION_TOKEN`), and a second transport-level "session id" would be a near-homonym for a
different thing in every log line and every refusal.

**`initialize` and `tools/list` are unauthenticated; `tools/call` is not.** An observability
decision, not a security one — the tools do nothing without a credential and the tool names are not
secret. If `initialize` refused a desk whose token never expanded, the only evidence would be an MCP
connection error in the agent's own TUI, which nobody reads during an unattended spawn: the exact
blind spot that made the §3.3 trap worth a design change. Letting the handshake succeed means the
refusal arrives as the result of the desk's first `claim_task` — text in the transcript, which 010
and 026 pipe into the chat panel humans watch, and which the model can report in its own words.

**Server name `office_tasks`, asserted in a test against all three places it must match** (the role
files' `mcpServers:` key, the `mcp__office_tasks__*` allow rule, and `MCP_SERVER_NAME`). Spike 003
wrote it two different ways in two sections; a mismatch allowlists a server that does not exist, so
every `claim_task` prompts and parks the desk while the settings file reads as if it should not.

**`POST /tasks/:id/claim` and `/complete` take `owner` from the body and do not verify it**, exactly
as 008's control API and 012's `actor` do — permissions are step 9. The asymmetry with the MCP path
is deliberate and safe in the direction that matters: an *agent* reaches the coordination layer only
through MCP, where identity is a header it never sees. The note is in the file so nobody mistakes
this endpoint for something to expose publicly.

### Open questions — answered or still open

- [x] *"Confirm a step-2 agent completing a task without pushing is acceptable."* Proceeding on yes,
      with the seam made loud rather than silent: every completion returns `gitDelivery()`'s message
      saying nothing was rebased, pushed or opened, and telling the agent not to report the work as
      delivered. If the answer is no, step 2 waits for step 4 and this file does not change.
- [ ] *"A claimed task whose agent dies before completing."* Unchanged: 015's TTL releases the
      locks, nothing returns the task from `in_progress` to `pending`. Still assumed to be a human
      through 028's resume machinery. Worth noting that the TTL and the task state now disagree for
      a while by design — the locks go first.
- [x] *Where the `learning` entry is stored.* `tasks.learning` via `0014_task_learning.sql`,
      unstructured and unindexed on purpose; step 5 reads every non-null value into the graph as a
      fact sourced to the task and **drops the column**. Written into the migration because it is a
      one-way door.
- [ ] `approve_task`, `reject_task`, `deliver_task` remain out of scope — the QA gate is step 6.
