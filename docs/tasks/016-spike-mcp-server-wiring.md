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

- [ ] The doc states how an MCP server is attached per role — through the agent definition, through user settings, or through a CLI flag — with a working example config recorded verbatim.
- [ ] The doc states whether stdio or HTTP transport is right here, with the reasoning. One server process per agent (stdio) versus one shared process per project (HTTP) is a materially different operational story; the recommendation names which and why.
- [ ] The doc answers: **how does a tool call identify the calling session?** Options to test: an env var injected at launch, a per-session token in the server config, the transport connection identity. The recommendation must be one an agent cannot forge by calling the tool with different arguments.
- [ ] The doc records what an agent sees when a tool returns an error, and whether the error text reaches the model usefully — `claim_task` refusals are a teaching signal, not just a failure.
- [ ] The doc states whether tools appear in the agent's context without extra prompting, and the approximate token cost of the tool definitions per turn.
- [ ] The doc states how a per-role MCP server is provisioned alongside ticket 009's hook config, and whether that changes `provision.ts`.
- [ ] Findings that contradict the design are listed under "Design changes required" with the affected ticket ids.

## Open questions

- [ ] These are the questions — the deliverable is the answers.
- [ ] Related design gap: the design says permission prompts stay local to each session, but never says whether MCP tool calls need pre-approval in the role allowlist. If they do, ticket 009's empty allowlist blocks every task tool. Check this here.
