---
id: "016"
title: "Spike: per-role MCP server wiring"
build_step: 2
department: research
estimated_model: opus
blocked_by: ["009"]
---

# 016 — Spike: per-role MCP server wiring

**Build step:** 2 — Coordination
**Department:** research
**Estimated model:** opus — the answer determines the process model and the auth model for every MCP tool in the system.
**Blocked by:** 009

## Why

The design promises "per-role MCP servers and system prompts via `--agent`" and lists three MCP servers
(session tools, task tools, graph tools), but never says how they are attached, how many processes
exist, or how a tool call knows which session made it.

That last point is not cosmetic: `claim_task` "checks owner match", which means the task server must
know *which agent is calling* and be unable to be lied to. Tickets 017 and 018 cannot be written until
this is settled.

## Scope

### Files created

- `docs/spikes/003-mcp-wiring.md` — findings and the recommended wiring
- `spikes/mcp/probe-server.mjs` — a minimal MCP server exposing one tool that reports everything it can observe about its caller and environment

### Files modified

None.

## Acceptance criteria

- [x] The doc states how an MCP server is attached per role — through the agent definition, through user settings, or through a CLI flag — with a working example config recorded verbatim.
- [x] The doc states whether stdio or HTTP transport is right here, with the reasoning. One server process per agent (stdio) versus one shared process per project (HTTP) is a materially different operational story; the recommendation names which and why.
- [x] The doc answers: **how does a tool call identify the calling session?** Options to test: an env var injected at launch, a per-session token in the server config, the transport connection identity. The recommendation must be one an agent cannot forge by calling the tool with different arguments.
- [ ] The doc records what an agent sees when a tool returns an error, and whether the error text reaches the model usefully — `claim_task` refusals are a teaching signal, not just a failure. **— the two failure shapes and the recommendation are in §4; whether the error TEXT reaches the model is UNVERIFIED and needs the live run in §8.3.**
- [ ] The doc states whether tools appear in the agent's context without extra prompting, and the approximate token cost of the tool definitions per turn. **— appearance and the `mcp__server__tool` naming are answered in §5; definition size is MEASURED at ~110 tokens/tool, but I declined to convert that into a PER-TURN figure without observing the client. UNVERIFIED.**
- [x] The doc states how a per-role MCP server is provisioned alongside ticket 009's hook config, and whether that changes `provision.ts`.
- [x] Findings that contradict the design are listed under "Design changes required" with the affected ticket ids.

## Open questions

- [ ] These are the questions — the deliverable is the answers.
- [x] Related design gap: the design says permission prompts stay local to each session, but never says whether MCP tool calls need pre-approval in the role allowlist. If they do, ticket 009's empty allowlist blocks every task tool. Check this here.

## Landed 2026-10-10

`docs/spikes/003-mcp-wiring.md` and `spikes/mcp/probe-server.mjs`. **5 of 7 criteria answered, 2
left open with the exact run that clears them.** The spike's own open question about MCP tool
pre-approval is answered, and the answer is a blocker for 017 — see below.

**The critical path is unblocked.** 017, 018, 019→025 and 032 have the wiring decision they were
waiting on: attach per role through the **role file's own `mcpServers:` frontmatter** (a native
field that connects at startup under `--agent`, and 009 already installs those files), over **HTTP
to the orchestrator's existing https listener** rather than a stdio process per agent.

### The one design change this forces

**The office has no per-session secret, and needs one.** Verified against the live schema:
`sessions` has no token column, and the only secret the office mints is 009's **per-account**
`HOOK_INGEST_TOKEN`. One Linux account hosts several desks by design, so an account-scoped token
cannot tell them apart — and `claim_task` "checks owner match", which would silently degrade to
"same teammate". **008 must mint a per-session token** (it owns the session machine and the schema),
009's `agentLaunchSpec` must carry it, and 017/018 must verify it. Full table of seven design
changes with ticket ids in §7 of the spike.

### The trap that would have been found the expensive way

`${VAR}` expansion works in an MCP server's `command`, `args`, `env`, `url` **and** `headers` —
which is what makes unforgeable identity possible at all, since the model never sees the launch
environment. But **an unset variable does not fail the server**: the config loads with the literal
`${OFFICE_SESSION_TOKEN}` text, the warning goes only to `claude mcp list` output that nobody reads
during an unattended spawn, and every desk then presents *the same* literal string as its identity.
Same shape as a desk with no `NODE_EXTRA_CA_CERTS`: works perfectly, silently wrong. 017 and 018
must refuse a credential that still looks like `${...}`. The probe implements the check and
demonstrates it.

### Why two criteria are still open

Both need a live Claude Code session with the probe attached, and **a login is single-session on
this account** — starting one costs the human their current session. That is a cost to a person, not
a technical blocker, so the four remaining measurements are batched into one VPS run rather than
spent piecemeal. Same reasoning that staged `~/run-007a.sh` on the VPS instead of running it. §8
lists them in the order that fails cheapest first, because the first one — **does Claude Code's MCP
client honour `NODE_EXTRA_CA_CERTS`?** — would invalidate the HTTP recommendation if the answer is
no. The probe needs no install: one dependency-free `.mjs`, and `agent1` is already logged in with a
trusted project directory.

- **Criterion 4 (error text)** — both failure shapes are documented and the recommendation is made
  (`isError: true` with the reason written as an instruction, not a status code). Whether the text
  reaches the model usefully is the measurement. `fail_soft` and `fail_hard` carry sentinel strings
  for exactly this.
- **Criterion 5 (token cost)** — appearance and the `mcp__server__tool` naming are answered.
  Definition size is measured: **1,323 bytes for three tools, ≈110 tokens each**, dominated by
  description prose. I deliberately did **not** convert that into a per-turn figure; caching and
  system-prompt overhead are client-side facts this spike did not observe, and an invented number
  there would propagate into 018's memory budget.

### The answer to this ticket's own open question, and it blocks 017

**MCP tool calls require permission approval, and 009 ships an empty allowlist** — so an unlisted
`claim_task` prompts, and in `manual` mode (which the office chose deliberately, as the only mode
where `PermissionRequest` can mark a desk blocked) the desk parks waiting for a human. 009's base
settings must allow `mcp__office_tasks__*` and `mcp__office_session__*`.

With a trap attached: **`"mcp__*"` as an *allow* rule silently approves nothing** — an unanchored
allow glob is skipped with a warning, while looking permissive. The server segment must be
glob-free. (`mcp__*` *is* valid in a deny rule; the asymmetry is the trap.) And a `mcp__` rule
containing parentheses is dropped entirely when a settings file loads, so there is no parameter
matching in MCP allow rules.

### Deviation from this ticket's scope, stated

The scope says the probe exposes "one tool". It exposes three. The ticket's own criterion about
error text cannot be answered with one tool: `fail_soft` (an `isError` result) and `fail_hard` (a
JSON-RPC error) are the two failure shapes, and they *are* the measurement.

### Build skew worth carrying

This ran on **2.1.268** (the Windows dev host); the VPS runs **2.1.283**, which is where 009's
permission-mode figures were measured. Nothing here is detectably version-sensitive, but the
attachment surface is exactly the kind of thing that moves — two things moved under this build in a
single day of measuring. Re-check §1 against the VPS build before 017 commits to it.

**Also corroborated, as a side effect:** agent frontmatter `permissionMode` accepts both `default`
and `manual` (the full list being `default, acceptEdits, auto, dontAsk, bypassPermissions, plan,
manual`), where the `--permission-mode` *flag* rejects `default`. That supports 009's unverified
claim about the two vocabularies differing — but it is the agent-file field, not the settings key
`permissions.defaultMode` that 009's criterion names, so **009's open item stays open**.
