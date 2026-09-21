---
id: "002"
title: "Spike: Claude Code hook payloads and blocking semantics"
build_step: 1
department: research
estimated_model: opus
blocked_by: []
---

# 002 — Spike: Claude Code hook payloads and blocking semantics

**Build step:** 1 — Spine
**Department:** research
**Estimated model:** opus — this spike decides whether the messaging-out half of the spine is buildable as designed.
**Blocked by:** none

## Why

The design states two things about hooks that are in tension, and nothing downstream is safe to build
until they are resolved:

1. Hook config uses `"type": "http"` entries POSTing to the event server ("Messaging out").
2. "Hooks block by exiting with code 2, which returns feedback to the agent" ("Conflict prevention").

Exit codes belong to `command` hooks. Whether an `http` hook can block a tool call at all — and what
its response body must look like if it can — decides the shape of ticket 020's PreToolUse guard and of
ticket 009's hook config template.

The design also depends on `last_assistant_message` being present on the Stop payload, and on some
stable identifier tying a hook payload back to the session the orchestrator started. Neither has been
verified against a real install.

## Scope

### Files created

- `docs/spikes/001-hook-payloads.md` — findings, with a recorded payload sample per event
- `spikes/hooks/echo-server.mjs` — throwaway Node HTTP server that logs every hook POST verbatim
- `spikes/hooks/settings.spike.json` — settings file registering every hook event named in the design against the echo server

### Files modified

None.

## Acceptance criteria

- [ ] `docs/spikes/001-hook-payloads.md` records a captured, redacted JSON payload for each of: SessionStart, Stop, StopFailure, PreToolUse, PermissionRequest, SessionEnd, PreCompact, PostModelSwitch.
- [ ] The doc states, with evidence, whether Stop carries `last_assistant_message`, and what it holds for a turn that ended with a tool call versus one that ended in plain text.
- [ ] The doc answers: **can an http hook block a PreToolUse?** If yes, the exact blocking response shape is recorded. If no, the doc records the command-hook fallback (script exits 2 and reaches the event server over HTTP) and measures the added per-tool-call latency over at least 20 calls.
- [ ] The doc names the field that correlates a hook payload to an orchestrator-started session, and states whether it is present on the *first* SessionStart or only afterwards. If no such field exists, it records which alternative works: an env var injected at launch and forwarded by the hook, or `cwd` plus tmux session name.
- [ ] The doc states whether hook delivery is retried on a non-2xx response, and what the agent sees when the event server is down.
- [ ] Every finding cites the Claude Code version it was observed on.
- [ ] Findings that contradict the design doc appear in a "Design changes required" section naming the affected tickets.

## Open questions

- [ ] These are the questions — the deliverable is the answers, not an implementation.
- [ ] Carried from the design's own open questions: does `CLAUDE_CONFIG_DIR` keep two logins authenticated at once? Test it here while a real install is in hand; ticket 009 depends on the answer.
- [ ] If http hooks cannot block, is a `command` hook acceptable on the hot path of every tool call, or does the guard move entirely into the MCP layer? Record the latency measurement and hand the decision to ticket 020 rather than settling it here.
