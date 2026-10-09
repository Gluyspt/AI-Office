# Spike 003 — per-role MCP server wiring

**Ticket:** 016 · **Build step:** 2 — Coordination · **Department:** research
**Run:** 2026-10-10, on the Windows development host. `claude 2.1.268`.
**Gates:** 017 (task tools), 018 (session server), 019 → 025 (planning), 032.

> **How to read the confidence labels.** Every claim below is tagged. This matters more than usual
> here, because the question this spike exists to answer is a *security* question — whether an agent
> can lie about which desk it is — and a documented mechanism that turns out not to hold would be
> discovered by an agent claiming another desk's task.
>
> - **MEASURED HERE** — observed on this host, this run, with the command recorded.
> - **DOCUMENTED** — stated by the official Claude Code reference, quoted, not independently tested.
> - **UNVERIFIED** — needs a live agent session with the probe attached. Staged, not run.
>
> **The build is 2.1.268 on this host; the VPS runs 2.1.283.** Ticket 009's permission-mode
> measurements were taken on 2.1.283. Nothing below is version-sensitive in a way I could detect,
> but the attachment surface is the kind of thing that moves, and two things already moved under
> this build in a single day of measuring (auto mode became the default; `default` left the
> `--permission-mode` vocabulary). Re-check §1 against the VPS build before 017 commits to it.

---

## The answer in one page

1. **Attach per role through the role file's own `mcpServers:` frontmatter.** It is a native field,
   it connects at startup under `--agent`, and **ticket 009 already installs those files** — so the
   office gets per-role MCP wiring with no new launch flag and no change to `agentLaunchSpec`'s
   argv. (§1)
2. **Use HTTP transport against the orchestrator's existing https server, not stdio.** On a 3.2 GB
   VPS where a bare agent is ~290 MB and the measured ceiling is ~6 agents, a stdio process per
   server per agent spends the cap on process overhead and multiplies Postgres connections for no
   benefit. The office's task and session tools are thin wrappers over a database the orchestrator
   already serves over https with token auth. (§2)
3. **Identity comes from `${VAR}` expansion into the server config from the launch environment** —
   the same channel that already carries `NODE_EXTRA_CA_CERTS`. The model never sees it and cannot
   change it by calling a tool differently. (§3)
4. **But the office has no per-session secret to put there, and needs one.** `sessions` has no token
   column; the only secret today is 009's per-**account** `HOOK_INGEST_TOKEN`. One account hosts
   several desks, so an account token identifies the teammate, not the desk — and `claim_task`
   "checks owner match". **This is the one real design change this spike forces.** (§3.2, §7)
5. **MCP tool calls require permission approval, and 009 ships an empty allowlist.** Unaddressed,
   every `claim_task` raises a PermissionRequest and blocks the desk waiting for a human. The
   allowlist must name the office's own servers, and the rule syntax has a trap that makes the
   obvious blanket rule silently do nothing. (§6)

---

## 1. How an MCP server is attached per role

**DOCUMENTED, with the config recorded verbatim.** An agent definition file's YAML frontmatter
supports an `mcpServers` field, and the reference is explicit about the main-session case the office
uses:

> When the main session agent runs with `--agent` or the `agent` setting, inline server definitions
> in the agent file connect at startup alongside servers from `.mcp.json`.

The complete frontmatter field list for an agent definition is `name`, `description`, `tools`,
`disallowedTools`, `model`, `permissionMode`, `maxTurns`, `skills`, **`mcpServers`**, `hooks`,
`memory`, `background`, `omitClaudeMd`, `effort`, `isolation`, `color`, `initialPrompt`,
`experimental`.

`mcpServers` takes two kinds of entry: an **inline definition** (full config, scoped to this agent
only, connected when the agent starts and disconnected when it finishes, supporting `stdio`, `http`,
`sse` and `ws`), or a **string reference** to an already-configured server by name.

### The recommended shape, for ticket 017 to copy

This is what `agents/dev-lead.md`'s frontmatter should become. The office's existing role files
already carry `name`, `description` and `permissionMode`; only `mcpServers` is new.

```yaml
---
name: dev-lead
description: A Dev department lead in the AI Agent Office. Plans, splits and assigns its department's work, starts agents through start_session, and owns merges and technical decisions for the department.
permissionMode: manual
mcpServers:
  - office-tasks:
      type: http
      url: ${OFFICE_EVENT_SERVER_ORIGIN}/mcp/tasks
      headers:
        Authorization: Bearer ${OFFICE_SESSION_TOKEN}
  - office-session:
      type: http
      url: ${OFFICE_EVENT_SERVER_ORIGIN}/mcp/session
      headers:
        Authorization: Bearer ${OFFICE_SESSION_TOKEN}
---
```

**Why this is the attachment point and not the alternatives**, each of which was considered:

| Mechanism | Verdict |
| --- | --- |
| **Role file `mcpServers:` frontmatter** | **Chosen.** Per-role by construction — the file *is* the role. 009 already installs it to `~/.claude/agents/<role>.md`, so provisioning changes by zero files. Inline definitions are scoped to the agent, so a dev-lead cannot see Management's tools. |
| `--mcp-config <file>` + `--strict-mcp-config` | Works, and `--strict-mcp-config` ("Only use MCP servers from `--mcp-config`, ignoring all other MCP configurations") is genuinely attractive for isolation. But it is **per launch, not per role**: the orchestrator would have to map role → config path at spawn time, duplicating knowledge the role file already holds. Keep it in reserve as a hardening flag (§7). |
| `.mcp.json` in the project | Rejected. Project-scoped, not role-scoped — every desk in the repo would get the same servers. Also **"Claude Code prompts for approval in interactive sessions before using project-scoped servers"**, which is another dialog that parks a fresh desk (the office already catalogued three ways a session is alive and useless). |
| `claude mcp add --scope user` | Rejected. Writes `~/.claude.json`, which is the account's own file holding its credentials and trust decisions. The office already decided not to clobber the account owner's config — that is exactly why 009 writes `office.settings.json` and passes `--settings` instead. |
| A settings key | Does not exist. The MCP-related settings keys are `enableAllProjectMcpServers`, `enabledMcpjsonServers`, `disabledMcpjsonServers`, `allowedMcpServers`, `deniedMcpServers`, `managedMcpServers` — all of which *approve, allowlist or block* servers. **None attaches one.** |

**One restriction worth recording before someone meets it:** for inline servers in an agent file
under a project's `.claude/agents/`, the workspace trust dialog must be accepted first. The office
is not affected — 009 installs role files to the account's own `~/.claude/agents/`, not the
project — and 009 already pre-trusts project paths in `.claude.json`. Do not move the role files
into the repo without re-reading this.

---

## 2. stdio or HTTP

**Recommendation: HTTP, served by the orchestrator process that already exists.** The reasoning is
arithmetic rather than taste, and it rests on numbers already measured on the target.

**The server config shapes**, DOCUMENTED:

```json
{ "mcpServers": { "name": { "command": "path/to/exe", "args": ["a"], "env": { "K": "v" } } } }
{ "mcpServers": { "name": { "type": "http", "url": "https://host/mcp", "headers": { "Authorization": "Bearer t" } } } }
```
`sse` and `ws` exist too and are not relevant here.

### Why not stdio

The design's phrase is "one graph server per project", and three servers are named (session tools,
task tools, graph tools). Under stdio, "per project" is not available: a stdio server is a child of
the agent process, so the count is **servers × agents**, not servers × projects.

Against the VPS numbers already in hand — `MemTotal` 3.2 GB, `MemAvailable` 2.2 GB with one agent
running, idle agent RSS ~290 MB median with peaks to 343 MB, **≈6 bare agents** — adding two or
three Node processes per desk is not a rounding error. It also multiplies Postgres connections by
the same factor, against a pool that defaults to ten.

And the thing stdio would buy — private, per-process credential injection — **is not needed, because
`${VAR}` expansion works in `headers` as well as `env`** (§3). The usual reason to prefer stdio for
a trusted local tool does not apply.

### Why HTTP is nearly free here

The orchestrator already runs an https listener with query-token authentication (ticket 005's
ingest), already binds loopback, and already holds the database pool and the task state machine that
`claim_task` and `complete_task` must go through. An MCP endpoint is **a route on a server that is
already running**, under the autoloaded-routes convention that lets a ticket add an endpoint without
a registry edit.

So: **zero new processes, one database pool, and the MCP tools sit in the same process as
`transition()`** — which matters, because 017's `claim`/`complete` must call
`announceTransition(result)` after committing, and an event emitted inside a caller's transaction
survives that caller's ROLLBACK.

### The cost of choosing HTTP, stated

- **TLS on loopback is already the office's decision**, so the server must present the same
  certificate the hooks trust, and the agent's `NODE_EXTRA_CA_CERTS` must cover it. It already
  does — same cert, same provisioning step. **UNVERIFIED:** that Claude Code's *MCP* client honours
  `NODE_EXTRA_CA_CERTS` the way its *hook* client does. Spike 001 §12 measured the hook client
  rejecting a self-signed cert outright (`tlsv1 alert unknown ca`) and the variable fixing it. The
  MCP client is a different client in the same process and very probably behaves identically, but
  "very probably" is how the hook failure got shipped once already. **Test this first in §8.**
- A dropped HTTP server is reconnected automatically, where a stdio server is not — DOCUMENTED, and
  in HTTP's favour for a long-lived desk.

---

## 3. How a tool call identifies the calling session

This is the criterion the ticket calls "not cosmetic", and the requirement is that the answer be one
**an agent cannot forge by calling the tool with different arguments**.

### 3.1 The mechanism

**DOCUMENTED, and the decisive fact:** Claude Code expands environment variables inside an MCP
server configuration, in **five** fields:

> * `command`: the server executable path
> * `args`: command-line arguments
> * `env`: environment variables passed to the server
> * `url`: for HTTP server types
> * `headers`: for HTTP server authentication

with the syntax `${VAR}` and `${VAR:-default}`.

So the identity channel is: **008 mints a per-session token at spawn → 009's `agentLaunchSpec` puts
it in the pane environment → the role file's `headers` block expands it → the orchestrator reads it
off the request.** The model never sees the token, it is not a tool argument, and there is no tool
call shape that changes it. This is the same channel that already carries `NODE_EXTRA_CA_CERTS`,
`OFFICE_EVENT_SERVER_ORIGIN` and `OFFICE_HOOK_INGEST_TOKEN`, so the office has already built and
tested it.

The probe makes the distinction concrete rather than asserted. `whoami` reports
`launchEnvironment` and `modelSuppliedArguments` as **separate** keys, and its
`claimed_session_id` argument exists purely so a trial can show an agent asserting one identity
while the environment reports another. **MEASURED HERE** (`node spikes/mcp/probe-server.mjs` driven
from a file of JSON-RPC frames): an argument of `{"claimed_session_id":"i-am-lying"}` comes back
under `modelSuppliedArguments` and changes nothing under `launchEnvironment`.

### 3.2 The office does not have the secret this needs — and this is the design change

**MEASURED HERE** against the live schema: `sessions` has columns `id, project_id, tmux_name, role,
dept, owner, backend, model, model_reason, status, claude_session_id, failure_reason, started_at,
ended_at, handoff_ref, end_reason`. **There is no token, secret or nonce.**

The only secret the office mints today is 009's `HOOK_INGEST_TOKEN`, which is **per Linux account**.
That is the wrong granularity, and not by a little:

- The settled design is **one Linux user per *teammate*, not per agent** (confirmed with a human
  2026-10-07). One account therefore hosts **several desks at once**.
- `claim_task` "checks owner match". With an account-scoped token, every desk belonging to one
  teammate presents the *same* identity, so the task server cannot tell a dev-lead from a worker on
  the same account — and "owner match" silently degrades to "same teammate", which is not the check
  the design asks for.

**Required: a per-session secret, minted by 008.** 008 is already the only writer of the session
status machine and the only thing that knows a desk has been created, so it is the right owner. The
token must be unguessable, stored on the session row (or a child table), and invalidated when the
session ends — otherwise a killed desk's token still claims tasks. See §7 for the ticket split.

### 3.3 The trap that makes this dangerous if done carelessly

**DOCUMENTED, and it is the most important sentence in the reference for our purposes:**

> If a referenced environment variable isn't set and has no default value, the config still loads:
> Claude Code reports a missing-variable warning for that server in `claude mcp list` output and
> uses the unexpanded `${VAR}` text as-is.

**An unset variable does not fail the desk. It sends the literal string `${OFFICE_SESSION_TOKEN}`
as the credential.** That is the same shape as the failure 008's hook gate exists to catch: a desk
that works perfectly and is silently wrong — except worse, because the literal placeholder is *the
same string for every agent*, so a naive server would treat it as a single shared identity that
every desk presents.

The warning appears in `claude mcp list` output, which no human is reading during an unattended
spawn.

**So the office's MCP endpoints MUST reject a credential that still looks like `${...}`, with a
message naming the launch environment**, rather than treating it as an identity. The probe
implements exactly this check (`looksUnexpanded`) and **MEASURED HERE**: launched with
`OFFICE_SESSION_TOKEN='${OFFICE_SESSION_TOKEN}'`, `whoami` returns
`"unexpandedVariables": ["OFFICE_SESSION_TOKEN"]` and a warning naming it. Written into §7 as a
requirement on 017 and 018.

### 3.4 A lead worth chasing, NOT yet a finding

**MEASURED HERE, but on the wrong spawn path — do not build on this yet.** Running the probe as a
child of a Claude Code session, its environment contained:

```
CLAUDE_CODE_SESSION_ID=d1013dc6-8b79-49ed-ad44-a7c178ac755b
CLAUDE_CODE_ENTRYPOINT=cli
CLAUDE_PID=4804
CLAUDE_CODE_MESSAGING_SOCKET / CLAUDE_CODE_MESSAGING_TOKEN / CLAUDE_CODE_SSE_PORT
```

If Claude Code injects `CLAUDE_CODE_SESSION_ID` into the environment of the **MCP servers** it
spawns, the office gets client-supplied, model-invisible session identity for free, and would not
need to mint its own token for *identification* (it would still want one for *authentication*).

**Why this is not a finding:** that probe ran as a child of a `Bash` tool call, which inherits the
session's environment. An MCP server is a different spawn path, and the reference documents only
`CLAUDE_PROJECT_DIR` as automatically set:

> Claude Code sets `CLAUDE_PROJECT_DIR` in the spawned server's environment to the project root

`CLAUDE_CODE_SESSION_ID` is **not** documented for MCP servers. Treating an undocumented variable
observed on a different spawn path as an identity channel is precisely the "invented a payload
schema" failure this repo has a rule against. §8 tests it in one step; until then the office mints
its own token.

---

## 4. What an agent sees when a tool returns an error

**Partly DOCUMENTED, model-visibility UNVERIFIED.** MCP has two distinct failure shapes and they may
not reach the model alike:

- a **tool result** carrying `isError: true` with text content — the application-level failure, and
  the shape a `claim_task` refusal should use;
- a **JSON-RPC error** object — the protocol-level failure.

The ticket's framing is right that this matters: *"`claim_task` refusals are a teaching signal, not
just a failure."* An agent that learns "task t-123 is owned by agent2" can pick a different task. An
agent that learns only "a tool failed" retries, and 017's refusal becomes a loop.

The probe ships both: `fail_soft` returns `isError: true` with a sentinel string
(`OFFICE_PROBE_SOFT_ERROR: task t-123 is owned by agent2, not agent1`), and `fail_hard` returns a
JSON-RPC error with `OFFICE_PROBE_HARD_ERROR`. **MEASURED HERE** that both frames are emitted
correctly on the wire. What remains is whether the sentinel text appears in the agent's transcript
and whether the agent acts on it — which needs a live session (§8).

**Recommendation to 017 pending that measurement:** use `isError: true` with the reason in the text
content, and write the reason as an instruction to the agent rather than a status line — "task
t-123 is owned by agent2; claim an unowned task or ask your lead to reassign it", not
"ERR_OWNER_MISMATCH".

---

## 5. Do tools appear without prompting, and what do they cost

**Appearance: DOCUMENTED.** Tools from a configured server are exposed to the model automatically,
named `mcp__<server>__<tool>`, with any character outside `A-Z a-z 0-9 _ -` replaced by `_`. Plugin
servers use `mcp__plugin_<plugin>_<server>__<tool>`. No prompting is needed to make them visible.
One behaviour worth knowing for 018: *"If your request needs tools from a server that is still
connecting in the background, Claude waits for that server before continuing."*

**Cost: MEASURED HERE as definition size; per-turn token cost UNVERIFIED.** The probe's three tools
serialise to **1,323 bytes** in the `tools` array of its `tools/list` response (1,525 bytes for the
whole frame). At the usual ~4 bytes/token rule of thumb for English-plus-JSON that is **roughly 330
tokens for three tools, ~110 per tool**, dominated by the description and schema prose rather than
the names.

**I am not converting that into a per-turn figure, and the ticket should not either.** How the client
renders tool definitions into the request, whether they are cached across turns, and what the
system-prompt overhead per server is, are all client-side facts this spike did not observe. The
honest number is the one above: **a tool costs on the order of a hundred tokens of definition, so a
dozen office tools is on the order of a thousand** — enough to care about on a long conversation,
not enough to shape the design. Measure properly when 017's real tool set exists.

Design consequence either way: keep descriptions tight, and **do not expose the graph server's full
tool surface to every role**. The `tools:` frontmatter field accepts `mcp__<server>` and
`mcp__<server>__*` patterns, and `disallowedTools` accepts `mcp__*`, so a role can be given one
server's tools and no others.

---

## 6. Provisioning, and the permission allowlist

### Does this change `provision.ts`?

**Mostly no, and that is the point of choosing the role file in §1.** 009 already:

- renders and installs `~/.claude/agents/<role>.md` from the repo's `agents/<role>.md`, so an
  `mcpServers:` block ships with the role at no cost;
- builds the launch environment in one place (`agentLaunchSpec`), which is where the new
  `OFFICE_SESSION_TOKEN` must go;
- validates and refuses unsafe configuration rather than passing it through.

**Two changes are needed, and both belong to 009's file** (`provision.ts` is 009's permanently, so
017/018 must not edit it — this is a 009 follow-up, not a scope grab):

1. **`agentLaunchSpec` must carry the per-session token.** It currently takes `role`, `homeDir`,
   `caCertPath`, `eventServerOrigin`, `hookToken`, `permissionMode` and returns
   `{ flags, env }` with `NODE_EXTRA_CA_CERTS`, `OFFICE_EVENT_SERVER_ORIGIN` and
   `OFFICE_HOOK_INGEST_TOKEN`. It needs `OFFICE_SESSION_TOKEN` (per session, from 008) alongside
   them. The signature change is small; the ownership question is the real one.
2. **Provisioning should refuse a role file whose `mcpServers` block references a variable
   `agentLaunchSpec` does not set.** This is the §3.3 trap, caught at provisioning time instead of
   silently at spawn time — exactly parallel to 009's existing refusal of an unsubstituted
   `${PLACEHOLDER}` in a hook URL, and to its cross-check of the account's token against
   `HOOK_INGEST_TOKENS`.

### The allowlist — the ticket's carried-open question, answered

The ticket asks: *"the design says permission prompts stay local to each session, but never says
whether MCP tool calls need pre-approval in the role allowlist. If they do, ticket 009's empty
allowlist blocks every task tool."*

**They do. DOCUMENTED:** MCP tool calls require permission approval and are pre-approved through
allow rules naming the full tool name, and the reference is explicit that the full name is what you
use *"in permission rules, a skill's `allowed-tools` list, a subagent's `tools` field, or a hook
matcher"*.

**So 009's empty allowlist is a real blocker for 017.** With `permissionMode: manual` — which the
office chose deliberately, because it is the only mode that still raises prompts and therefore the
only one where the `PermissionRequest` hook can mark a desk blocked — an unlisted `claim_task` will
prompt. A desk that must wait for a human to approve claiming each task is not an office.

**The rule syntax, with a trap.** DOCUMENTED:

- `mcp__office_tasks` matches any tool from that server
- `mcp__office_tasks__*` matches all its tools
- `mcp__office_tasks__claim_task` matches the one tool

and then the trap, quoted because the obvious rule is the broken one:

> Allow rules accept tool-name globs only after a literal `mcp__<server>__` prefix. The server
> segment must be glob-free so the rule names a specific server you configured. … An unanchored
> allow glob such as `"*"`, `"B*"`, or `"mcp__*"` is skipped with a warning and doesn't
> auto-approve anything.

**`"mcp__*"` in `permissions.allow` silently approves nothing.** It is skipped with a warning, and
the symptom is every tool prompting while the config looks permissive — the expensive direction,
because it sends someone to debug the MCP server when the allowlist is the problem. (`mcp__*` *is*
valid in a **deny** rule, where globs in the tool-name position are allowed. The asymmetry is the
whole trap.)

A second one: **a `mcp__` rule containing parentheses is skipped entirely** when a settings file
loads, listed in the invalid-settings dialog and in `claude doctor`. So there is no parameter
matching in MCP allow rules — `mcp__office_tasks__claim_task(task_id:*)` is not a rule, it is a
silently-dropped line. Parameter-level denial needs `--disallowedTools`.

**Recommendation:** 009's base settings should allow the office's own servers by name —
`mcp__office_tasks__*` and `mcp__office_session__*` — and nothing else. This stays consistent with
the design's "pre-approve per role in each role's settings allowlist" while keeping the allowlist
closed to everything the office did not configure. It does **not** weaken the
`PermissionRequest`-marks-the-agent-blocked model, which exists for file writes and shell commands,
not for the office's own coordination calls.

---

## 7. Design changes required

| # | Change | Why | Tickets |
| --- | --- | --- | --- |
| 1 | **A per-session secret, minted at spawn and invalidated at session end.** `sessions` has no token column; the only secret is 009's per-account one. | One Linux account hosts several desks, so an account token cannot distinguish them — and `claim_task` "checks owner match". Without this, owner match degrades to "same teammate". | **008** (mint, store, invalidate — it owns the session machine and the schema), **009** (carry it in `agentLaunchSpec`), 017 + 018 (verify it) |
| 2 | **Reject a credential that still looks like `${...}`.** | An unset variable does not fail the server: the config loads with the literal placeholder, identical for every desk. Silent, and the warning only appears in `claude mcp list`. | **017**, **018** |
| 3 | **`permissions.allow` must name the office's MCP servers.** 009 ships an empty allowlist. | MCP tool calls require approval. In `manual` mode every `claim_task` prompts and parks the desk. | **009** (the base template), 017 |
| 4 | **Do not write `"mcp__*"` as an allow rule.** Use `mcp__<server>__*`. | An unanchored allow glob is skipped with a warning and approves nothing, while looking permissive. | **009**, 020 (same settings file) |
| 5 | **The design's "one graph server per project" is only achievable over HTTP.** | Under stdio the count is servers × agents, not servers × projects. On a 3.2 GB box measured at ~6 bare agents, that is the difference between a cap of ~6 and ~4. | 018, and build step 5 |
| 6 | **Role files gain an `mcpServers:` block; `provision.ts` should refuse one referencing an unset variable.** | Catches change 2 at provisioning time rather than at spawn time. | **009** |
| 7 | **The design's three MCP servers need not be three processes.** Session and task tools are routes on the orchestrator's existing https listener. | Zero new processes, one database pool, and 017's `claim`/`complete` run in the same process as `transition()` — which they must, because an event emitted inside a caller's transaction survives its ROLLBACK. | 017, 018 |

**Not a design change, but a correction to this ticket's own framing:** 016's scope says the probe
should be "a minimal MCP server exposing one tool". It exposes three. The second and third exist
because the ticket's own criterion about error text cannot be answered with one tool — `fail_soft`
and `fail_hard` are the two failure shapes, and they are the measurement.

---

## 8. What is still UNVERIFIED, and the one run that clears it

Four things need a live agent session with the probe attached. They are listed in the order that
fails cheapest first, because the first one would invalidate §2's recommendation.

1. **Does Claude Code's MCP client honour `NODE_EXTRA_CA_CERTS`?** If not, HTTP transport over the
   office's self-signed loopback cert does not work and §2 must be revisited. Spike 001 §12 proved
   the *hook* client rejects a self-signed cert without it. Cheapest possible test: point the probe
   at an https URL on the office cert and see whether the server connects.
2. **Is `CLAUDE_CODE_SESSION_ID` set in an MCP server's environment?** (§3.4.) If yes, the office has
   free model-invisible session identity. `whoami` reports it if present.
3. **Does `isError` text reach the model usefully?** Call `fail_soft`, then read the transcript for
   `OFFICE_PROBE_SOFT_ERROR` and see whether the agent acts on the reason. Then `fail_hard` for
   `OFFICE_PROBE_HARD_ERROR`.
4. **Do the office's tools prompt under `permissionMode: manual` with an empty allowlist** (§6), and
   does `mcp__office_tasks__*` silence it while `mcp__*` does not?

**Why it was not run here.** Measuring these needs a live Claude Code session with the probe
attached, and **a Claude login is single-session on this account** — starting one costs the human
their current session. That is a real cost to a person, not a technical blocker, so it is batched
rather than spent piecemeal. This is the same reason ticket 007 staged `~/run-007a.sh` on the VPS
and gated it on `~/.claude.json` instead of running it.

**Run them together, on the VPS, as `agent1`** (which is already logged in, with
`/srv/office/projects/throwaway` already trusted). The probe needs no install — it is one
dependency-free `.mjs` file and Node 22 is on the box. Attach it by adding an `mcpServers:` block to
a scratch role file, start a session with `--agent`, call `whoami`, `fail_soft` and `fail_hard`, and
read `$MCP_PROBE_LOG` plus the agent's own transcript at `~/.claude/projects/<slug>/*.jsonl`.

**Read the log, not the pane.** The pane renders markdown and has already made backticks look
mangled once; and spike 002's harness reported all 36 trials as failures because it resolved the
*caller's* `$HOME` while the agent wrote to `/home/agent1/`. The probe writes its own log precisely
so there is a ground truth that does not depend on the TUI.

---

## 9. Loose ends, recorded rather than resolved

- **`requiresUserInteraction`.** The permissions reference mentions MCP tools "marked
  `requiresUserInteraction`" being denied in `dontAsk` mode even when allowed. The MCP reference page
  does not document the option. If it is a server-side per-tool declaration, 017 should know about
  it before marking anything that way — a tool the office marks this way can never be used
  unattended. Unresolved; not needed for 017 to start.
- **Agent frontmatter `permissionMode` accepts both `default` and `manual`** — DOCUMENTED, the full
  list being `default`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`, `plan`, `manual`.
  This **corroborates** 009's unverified claim that the settings vocabulary differs from the
  `--permission-mode` flag vocabulary (where `default` is *not* valid). It is corroboration, not the
  measurement 009 asked for: 009's open item is about the settings key `permissions.defaultMode`
  specifically, and this is the agent-file field. The office's role files already use
  `permissionMode: manual`, which this confirms is valid. Leave 009's criterion open until the
  one-line check is run.
- **`--strict-mcp-config`** is not used by the recommendation, and is worth revisiting as hardening:
  it would stop a project's `.mcp.json` from adding tools to a desk the office did not configure.
  The reason it is not in the recommendation is that it is a launch flag, so it would need the
  orchestrator to set it for every spawn — a change to 009's `agentLaunchSpec` whose benefit is only
  realised if someone commits a `.mcp.json` to a project repo. Cheap to add later; noted so the
  decision is deliberate.
- **Build skew.** This host is 2.1.268, the VPS 2.1.283. §1's attachment surface is the part most
  worth re-checking there.
