# Service boundaries — turning the office into services

**Status:** design, awaiting review. No code changes yet.
**Asked:** 2026-10-12, "make everything microservices".
**Answers the four questions that request turned on:**

| Question | Answer |
| --- | --- |
| Why | Independent deploy/scale, agent-parallel ownership, fault isolation |
| What a service *is* | A module in one process, behind a published contract, enforced by a CI test |
| The data boundary | A **DAS** — database access service |
| Sequencing | This document and its tickets first; code after review |

This is a companion to [the system design](ai-agent-office-design.md), not a replacement. It changes
no behaviour the design describes. It changes who is allowed to call whom.

## 1. The constraint that picks the shape

The deploy target is one shared VPS: 4 threads of an i3-7100T, **3.2 GB RAM**
([`deploy/README.md`](../deploy/README.md), measured 2026-10-07). The design's first architectural
decision says every agent is its own `claude` process and to *"budget several hundred MB each"*;
the measurement is **~290 MB idle per agent**, giving a ceiling around six concurrent desks.

**Agent sessions are the RAM budget.** Every megabyte spent on orchestrator plumbing is a megabyte
not spent on a desk, and the desks are the product. That single fact decides the shape:

| Shape | RAM cost | Guard latency | `claim_task` | Verdict |
| --- | --- | --- | --- | --- |
| Contracted modules, one process | +0 | +0 | one transaction | **chosen** |
| 3 services, split on privilege | ~+160 MB | +0 (guard stays local) | one transaction | partly, in 040 |
| Process per feature (~8) | ~+650 MB, about two fewer desks | +1 hop per agent tool call | saga | rejected |
| Container per feature | the above, and the orchestrator cannot be containerised at all (host tmux + sudo) | | | rejected |

Two latency facts make the "+1 hop" column load-bearing rather than theoretical:

- **The PreToolUse guard blocks a live agent's tool call.** `features/locks/routes/guard.ts` is
  called synchronously by a hook while the agent waits, and the decisions table gives it a ~2 s
  fail-open budget. A network hop lands inside an agent's critical path.
- **`events/ingest` asserts a p95 under 50 ms** and the real VPS already produced one run at
  **26.76 ms** under ordinary contention. Half the budget is already spent on a bad day.

And one correctness fact: **`claim_task` is a single transaction spanning two features.** 017's
`claimTask` opens `withTransaction` and hands the same `PoolClient` to `locks`' `acquireScope`,
`tasks`' `isClaimable` and `transition`
([`claim.ts`](../packages/server/src/features/tasks/claim.ts)). Its header comment records why:
without one transaction, a claim that fails at lock acquisition leaves a task `in_progress` that no
agent is working on, invisible to every "what can I claim" query. A database per service turns that
into a saga and re-opens the two races commit `1dffe19` closed.

## 2. The honest gap

One process delivers exactly one of the three drivers today.

| Driver | One process gives you | What it actually needs | Where |
| --- | --- | --- | --- |
| Agent-parallel ownership | **all of it** — a contract is a stable edit surface, so two agents in two features never collide, and the boundary test fails the change rather than a human noticing | nothing more | 033 |
| Fault isolation | **partly** — blast-radius isolation (a slow handler, a pool hog, a thrown error) is in-process work; crash and OOM isolation is not | a process split for the component whose crash matters | 036, 037, 040 |
| Independent deploy / scale | **none** — one process is one deploy | a process split, plus a transport | 038, 040 |

So this plan is not "contracts instead of services". It is:

1. **Contracts now** — cheap, reversible, and the whole of the ownership driver (033–035).
2. **In-process fault isolation now**, for the two failure modes that are not crashes (036, 037).
3. **One real process split**, where it pays for itself: the sudo/tmux control service (039, 040).
4. **A standing test that keeps the rest extractable** (038), so the second split is a day's work
   rather than a rewrite — the point at which "independent deploy" stops being blocked by the
   architecture and becomes a scheduling decision.

## 3. What is a service, and what is platform

Measured, not guessed — 33 cross-feature import edges in `packages/server/src/features/`
(non-test, 2026-10-12):

| From → to | edges |
| --- | :-: |
| → `events` (`ingest`, `bus`, `handler-loader`) | **14**, from 6 of 8 features |
| `orchestrator` → `tasks` / `locks` | 5 |
| `tasks` → `locks` | 3 |
| `chat` → `orchestrator` | 2 |
| `mcp` → `orchestrator` (`session-auth`, `session-token`) | 2 |
| `locks` → `chat` | 1 |
| `tasks` → `mcp` | 1 |

The graph is nearly a star on `events`, and a star is not peer coupling — it is infrastructure.
Which gives the first and most useful distinction:

**Platform is not a service.** `events` is the message bus, `mcp/protocol` is the RPC framework,
and `das` will be the data layer. Nothing is decoupled by making a feature ask permission to
publish an event. Platform may be called by everyone; platform may call **nobody**.

That rule immediately finds a real defect. `mcp/protocol.ts` — platform — imports
`orchestrator/session-auth.ts` and `session-token.ts`, which live inside the most privileged
service in the system. Platform depending on the sudo-holding service is backwards, and it is
precisely what would make the 040 split expensive: every MCP tool call would need a network round
trip into the privileged process just to learn who was calling. **Identity is platform** (039).

| | Service | Owns | Latency class | Off-host capable |
| --- | --- | --- | --- | :-: |
| P | `platform/events` | ingest, bus, handler dispatch | **hot** (50 ms p95) | — |
| P | `platform/das` | pool, grants, transaction scope, lanes | hot | — |
| P | `platform/mcp` | JSON-RPC mounting | hot | — |
| P | `platform/identity` | session token mint and resolve | hot | — |
| S | `tasks` | board, state machine, dependencies, claim/complete | warm | yes¹ |
| S | `locks` | ownership registry, PreToolUse guard | **hot** (blocks an agent) | yes¹ |
| S | `chat` | conversations, transcript, reply correlation | warm | yes |
| S | `control` | tmux, sudo, sessions, provisioning, pause/resume | warm | **no — host only** |
| S | `realtime` | WebSocket fan-out | warm | yes |
| S | `planning` | draft batches, promotion (019, not built) | cold | yes |
| S | `permissions` | permission-request handling (027, not built) | cold | yes |

¹ **`tasks` and `locks` are one deployment unit — permanently.** Asked directly on 2026-10-12 and
answered by counting, which found four transactions across the pair rather than the one `claim_task`
this document first credited. See §3.1.

`tasks/scope-ordering.ts → locks/overlap.ts` is the one edge that is not coupling at all —
`overlap` is a pure function over two patterns. It moves to `@office/shared`, which **Q4** settled
as the home for pure code and ids only.

### 3.1 The transactional crossings — four, not one

"Do `tasks` and `locks` stay one deployment unit?" was asked on 2026-10-12. Counting the
transactions rather than recalling them produced a firmer answer than the question expected, and a
correction to §4 of this document: **`claim_task` is not the only transaction spanning two
services. There are four, and two of them start in `control`.**

| # | Transaction | Spans | What its atomicity prevents |
| :-: | --- | --- | --- |
| 1 | `claim_task` (`tasks/claim.ts`) | tasks + locks | A task `in_progress` that no agent is working on — invisible to every "what can I claim" query, so the work silently stops being available |
| 2 | `complete_task` (`tasks/complete.ts:144`) | tasks + locks | A completed task still holding its file scope, blocking the next claim for a full TTL for a reason no log explains |
| 3 | `pause` (`orchestrator/pause.ts:856`) | **control** + tasks + locks | A paused task whose locks were never marked `paused` — the sweeper then expires them and the files are taken while the work waits |
| 4 | `resume` (`orchestrator/resume.ts:482`) | **control** + tasks + locks | `resume.ts`'s own comment: *"a paused lock's TTL has almost certainly expired while the work was paused, so clearing `paused` without restarting the clock hands the sweeper a live-but-expired lock and the task loses the files it was resumed to work on"* |

Every one of those failure modes is a task and its file scope disagreeing about who owns what, which
is the single thing the ownership registry exists to prevent. A saga would need a compensating
action for each, and **a compensating action can itself fail** — producing precisely the states
these four transactions make unreachable. So the saga option is **rejected, not deferred**: there is
no scaling case for it (one box, ~6 desks, claims at human frequency), and the cost of being wrong
is the failure the product is built to avoid.

**The consequence for 040 is a real one and this document missed it.** Rows 3 and 4 mean `control`
is inside the transactional set, so extracting `control` to its own process as written would break
pause and resume. The fix is not a saga either: it is that **pause and resume are two decisions, not
one** — "kill the agent and its tmux pane" belongs to `control`, "move the task and mark its locks"
belongs to the tasks+locks unit. 040 therefore splits `pause.ts` / `resume.ts` along that line and
calls the second half through a contract, which leaves one transaction wholly inside one deployment
unit. Written up as a scope addition on 040 and a dated section on 028.

**What the latency isolation people reach for a split to get comes from elsewhere.** The guard —
the one genuinely hot path in `locks` — holds **no transaction at all**: `guard-check.ts` uses
`query`, not `withTransaction`. So the extractable seam inside `locks` is not locks-versus-tasks, it
is the guard's read path versus the registry's write path, which is also what 036's open question
noticed from the other direction (the guard is hot; the sweeper and `listActive` are not). If the
guard ever needs its own process, it can have one without any of this being renegotiated.

## 4. The contract convention

> `features/<name>/contract.ts` is the only file another service may import from.
> Everything else in `features/<name>/` is private.

A file, not a directory, and not an `index.ts`: a barrel that re-exports everything makes the
boundary a formality, and the ownership map needs one path per rule. Platform modules publish a
`contract.ts` on the same terms.

**What may cross a boundary.** Serialisable values only — ids, records, refusals — with exactly one
kind of exception: **the DAS transaction handle**. Exceptions are enumerated in the boundary test,
not implied, and the list is only allowed to shrink. It has **four** entries, inventoried in §3.1:
`claim_task` and `complete_task` (tasks → locks), and `pause` and `resume` (control → tasks, locks).
The list is the formal statement of which services ship together — and the last two are why 040
has to split pause and resume before it can move `control` at all.

**What this buys the office.** A contract is a stable edit surface. Two agents working in `tasks`
and `locks` at the same time collide only if they both edit a contract — which the ownership
registry already serialises, because a contract is one file with one owner. The convention is
therefore not documentation; it is the thing that makes `claim_task`'s file-scope refusals rare and
informative instead of constant.

**Enforced, not asked for.** `tests/boundaries/` fails the suite on a deep import, on an undeclared
dependency, and on a non-serialisable value crossing a boundary without being on the exception
list. This repo has the precedent: conventions here are verifiable or they rot.

## 5. The DAS

### 5.1 What it owns, and what it must not

The DAS owns **access**: the pool, connection checkout, transaction scope, per-service grants,
statement timeouts, lanes, retries and metrics. Today `core/db/pool.ts` exports `pool`, `query` and
`withTransaction`, and **17 feature files import it directly**.

The DAS does **not** own queries. Each feature keeps its own SQL, in its own repo module
(`tasks/repo.ts`, `locks/registry.ts`, `chat/conversations.ts` — they already exist).

This is the central decision in the document, and it is a decision about the *office*, not about
databases. A DAS that owned every feature's SQL would be a single file touched by every ticket and
every agent — the one global edit surface in a system whose entire coordination model is "declare
your file scope, and overlapping work is refused". It would make the ownership registry refuse
constantly and serialise the office. **The data boundary must be a boundary, not a bottleneck:**
DAS owns access, features own queries.

### 5.2 Grants, and why Postgres should enforce them

A feature obtains a handle by naming what it touches:

```ts
// features/tasks/data.ts — owned by tasks
const data = das.grant("tasks", ["tasks", "task_dependencies", "task_state_events"]);
```

Two ways to make that mean something:

- **A CI check.** The boundary test parses each feature's SQL and compares table names against its
  declared grant. Free at runtime, catches the honest mistake, and is defeated by any dynamic SQL.
- **Postgres roles.** One role per service, real `GRANT`s in a migration, and the DAS issuing
  `SET LOCAL ROLE tasks_svc` on checkout. Then the *database* refuses a cross-boundary read, not a
  lint — unforgeable, and it survives dynamic SQL, a stray `psql` session, and a future extracted
  process that connects on its own.

**Recommend both** (035): the role is the enforcement, the CI check is the error message. Cost is
one extra statement per checkout on a loopback socket — sub-millisecond, inside the guard's budget.
The real cost is operational: migrations need a role that can `CREATE`, which the service roles must
not have. See **Q1**.

The payoff for driver #3 is direct: a service that already has its own database role and its own
grant needs no data work at all on the day it moves to its own process.

### 5.3 Lanes — the fault isolation nobody has today

`pool.ts` is one pool with one `max` and one `statement_timeout` for the whole server. So:

> A board query storm, or one long-running transaction in `planning`, can hold every connection in
> the pool while the **PreToolUse guard** waits for one — and the guard is a live agent, mid-tool-call,
> on a 2 s fail-open budget. Nothing in the system prevents this today.

That is a genuine fault-isolation defect, it is on the hottest path in the product, and it is fixed
in-process for zero RAM. The DAS partitions the pool into lanes with their own ceilings and their
own statement timeouts — a reserved lane for the guard and ingest, a general lane for everything
else — so no feature can starve the hot path (036).

### 5.4 Not a defect: thrown handlers

Worth recording, because it was checked before a ticket was written for it. A bus subscriber that
throws is already isolated (`bus.ts:68-75` — *"a throw here would fail a hook POST over a WebSocket
problem"*), a handler module that fails to load is logged and skipped (`handler-loader.ts`), and a
handler whose `handle()` throws is caught per-handler (`ingest.ts:209-212`). **No ticket is needed
for any of that.**

What is *not* covered is a handler that **hangs** rather than throws. Dispatch is a sequential
`for … await`, so one handler that never settles stalls the ingest POST behind it — and ingest is
what a blocking hook is waiting on. A `try/catch` cannot see that. Hence 037: a per-handler
deadline, isolated the same way a throw already is.

## 6. The two process splits worth making

**`control`, now (040).** It is the only service that *must* run on the host (tmux, scoped sudo), it
is the only one holding privilege worth isolating, and it is the one whose crash the design already
treats as expected — *"Hard crash or OOM → Supervisor polling tmux → mark `paused`, keep locks,
offer Resume"*. Splitting it buys least privilege and real crash isolation for the component that
deserves both, at about +80 MB, and it is the split that cannot be deferred cheaply: every month of
new code that calls into `control` in-process is another edge to unpick.

It has a prerequisite this document did not see on the first pass, found by answering Q2: **pause
and resume each hold one transaction spanning `control`, `tasks` and `locks`** (§3.1, rows 3 and 4),
so `control` cannot move until that pair is split along the line between "kill the agent" and "move
the task and mark its locks". That is a scope addition on 040, not a reason to defer it — but it is
the part to do first, and it is why 040 is the one boundaries ticket whose estimate should be
treated as soft.

**`edge` (hook ingest + guard), not yet.** The case for a tiny always-up process owning the two hot
endpoints is the 50 ms p95 and the guard's blocking budget. The case against is that it buys nothing
the lanes in 036 do not, and costs a hop on the path it is meant to protect. Revisit if the p95
margin degrades on the real box; 038 keeps it a day's work.

Everything else stays in one process until a measurement says otherwise.

## 7. Sequencing, and how the retrofit stays legal

**New tickets own only new files.** 033–040 create `platform/`, the boundary tests, the DAS, the
role migration and the control package. None of them edits a file another ticket owns.

**Forward-only from 018.** The critical path is open and 018 is startable; every ticket from there
is written in the new shape, so the retrofit shrinks while it waits.

**Retrofits are reopenings, not new tickets.** `docs/tasks/README.md` already settled this —
*"Reopening a closed ticket beats inventing an owner for its files"* (first done 2026-10-12 for
GLU-55, across four tickets). Moving `session-auth.ts` to `platform/identity/`, or pointing
`tasks/repo.ts` at the DAS, edits files 008 and 013 own permanently. Each therefore gets a dated
section carrying its own scope and criteria:

| Reopened | Change | Risk | After |
| --- | --- | --- | :-: |
| 008 | `session-token.ts`, `session-auth.ts` → `platform/identity/` | low — a move plus import updates; GLU-55's tests follow it | 039 |
| 005 | `events/` → `platform/events/`, publish a contract | low — 14 import sites, no logic change | 034 |
| 013 | `tasks/repo.ts` onto a DAS grant | medium — 17 pool call sites across all features; one feature at a time | 035 |
| 015 | `locks/registry.ts` onto its grant; publish `acquireScope` as the contract | **high** — the `claim_task` transaction crosses here | 035 |
| 017 | `claim.ts` / `complete.ts` call `locks` via contract, tx handle on the exception list | **high** — the two races of `1dffe19` | 035 |
| 020 | guard onto the reserved lane | medium — it is the budgeted path | 036 |
| 010 | `chat` → `control` contract | medium | 038 |
| 028 | **split `pause.ts` / `resume.ts`** — the tmux half stays in `control`, the task-and-locks half moves behind a contract, so each transaction sits wholly inside one deployment unit | **high** — §3.1 rows 3 and 4 | **before** 040 |
| 004 | delete `core/db/pool.ts` once nothing imports it | low — last, by definition | after 035 |

Order is deliberate: the two high-risk rows (015, 017) land together, behind the 021 coordination
tests, and nothing else is retrofitted until they are green twice.

## 8. Open questions

Not resolved by invention, per the repo's own rule.

- ~~**Q1 — Who runs migrations once service roles exist?**~~ **Answered 2026-10-12: an
  `office_migrator` role**, holding `CREATE`, used only by `pnpm migrate` and never by the running
  server. The principle that decided it: *the layer that enforces grants must not also be able to
  grant.* Two consequences for 035 to carry — the credential must never reach the server's
  environment, and `provision-host.sh` (unowned, run by `rtd`) gains the role's creation, so this
  crosses a host boundary as well as a code one. 035 is unblocked.
- ~~**Q2 — Do `tasks` and `locks` stay one deployment unit?**~~ **Answered 2026-10-12: yes,
  permanently.** Counting the transactions rather than recalling them found four across the pair,
  two of them starting in `control`, and the saga alternative is now rejected rather than deferred.
  Full reasoning and the inventory in §3.1 — including the consequence for 040, which this document
  had missed.
- ~~**Q3 — Does `packages/web` get the same treatment?**~~ **Answered 2026-10-12: yes, as its own
  ticket after 033** — now [041](tasks/041-web-contract-boundaries.md). Not folded into 033 because
  033's tests need a second traversal root and a different notion of "service", and 033 is the
  ticket currently blocking everything else.
- ~~**Q4 — What is `@office/shared` for, once contracts exist?**~~ **Answered 2026-10-12: pure code
  and ids only.** `ids.ts` stays and `locks/overlap.ts` moves in — a pure function over two patterns
  that belongs to nobody. Every *record* type moves to its owning service's contract: `TaskRecord`
  to `tasks`, `FileLockRecord` to `locks`, `ChatMessage` to `chat`. The rule exists because without
  one, `shared` becomes the new god-module by accident — the single package every ticket edits,
  which is exactly the failure the contract convention was adopted to prevent. The nine files there
  today are re-homed as part of the retrofit, not in one sweep.

## 9. Tickets

| id | title | blocked by |
| --- | --- | --- |
| [033](tasks/033-service-contracts-and-boundary-tests.md) | Service contracts and the boundary test | — |
| [034](tasks/034-das-data-access-service.md) | DAS: the data access service | 033 |
| [035](tasks/035-per-service-postgres-roles.md) | Per-service Postgres roles and grants | 034 |
| [036](tasks/036-das-lanes-and-the-hot-path.md) | DAS lanes: reserved connections for the hot path | 034 |
| [037](tasks/037-handler-deadlines.md) | Handler deadlines: a hung handler must not stall ingest | 033 |
| [038](tasks/038-extraction-readiness.md) | Extraction readiness: the service graph and its test | 033, 034 |
| [039](tasks/039-identity-as-platform.md) | Identity as platform | 033 |
| [040](tasks/040-control-service-split.md) | Control service: its own process, its own privilege | **028**, 034, 038, 039 |
| [041](tasks/041-web-contract-boundaries.md) | Contract boundaries in the web app | 033 |

**Critical path** (4 deep): 033 → 034 → 038 → 040.
**Startable immediately:** 033. **Then in parallel:** 034, 037, 039.

**Sequencing decided 2026-10-12: 033 before 018**, rather than the two in parallel. 033 is the only
ticket here whose value decays — every ticket landing before it adds cross-feature code in the old
shape, growing both the retrofit table in §7 and the baseline 033 ships with. One idle ticket on the
step-2 critical path buys every later ticket being written in the new shape. The live-session batch
(016's last four measurements plus 017's final criterion) also runs **before 018 starts**, because a
"no" on the `NODE_EXTRA_CA_CERTS` check overturns the HTTP transport recommendation 018 is built on.
