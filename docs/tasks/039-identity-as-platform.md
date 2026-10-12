---
id: "039"
title: Identity as platform
build_step: boundaries
department: dev
estimated_model: opus
blocked_by: ["033"]
---

# 039 — Identity as platform

**Build step:** boundaries
**Department:** dev
**Estimated model:** opus — it moves the code that answers "which desk is calling", and GLU-55 established that getting that answer wrong degrades `claim_task`'s owner check silently.
**Blocked by:** 033

## Why

033's platform rule — *platform may be called by everyone and calls nobody* — fails exactly once
against the tree as it stands, and the failure is not cosmetic.

`features/mcp/protocol.ts` is platform: it is the JSON-RPC mounting that 017 and 018 build their
servers on. It imports `orchestrator/session-auth.ts` and `orchestrator/session-token.ts` — which
live inside `control`, the service that holds the `sudo` grant and drives tmux. So the RPC framework
depends on the most privileged service in the system, in order to do something every service needs:
resolve a bearer token to a desk.

That is backwards in principle, and expensive in practice. 040 moves `control` into its own process.
If identity stays inside it, **every MCP tool call** — every `claim_task`, every `complete_task` —
needs a network round trip into the privileged process before it can even learn who is asking. On a
4-thread box, on the path an agent waits on, to answer a question that is one indexed `sha-256`
lookup.

GLU-55 (2026-10-12) built the per-session secret and put it where the session lifecycle lived, which
was the right call at the time: `startSession` mints it, so it went next to `startSession`. The
boundary rule is what makes it the wrong place now.

## Scope

### Files created

- `packages/server/src/platform/identity/contract.ts` — `authenticateSessionToken`, `mintSessionToken`, `looksUnexpanded`, the `AuthenticatedDesk` type, and the `dependencies` export (empty — platform depends on platform)
- `packages/server/src/platform/identity/token.ts` — minting, hashing, and the unexpanded-placeholder refusal
- `packages/server/src/platform/identity/authenticate.ts` — token to desk, with validity derived from session status
- `packages/server/src/platform/identity/token.test.ts`
- `packages/server/src/platform/identity/authenticate.test.ts`

### Files modified

The move itself edits files **008 owns permanently** (`session-token.ts`, `session-auth.ts`, and
`sessions.ts`'s call to the mint), and removes the baselined violation from `mcp/protocol.ts`, which
**017 owns**. Both are dated sections on those tickets, per the reopening rule — this is the third
time 008 has been reopened and the rule exists for exactly this. This ticket's own scope is the new
platform module and its tests; the two dated sections are blocking criteria below.

## Decided

**Identity is platform, not a service.** It has no business logic, every layer needs it, and it must
be callable without crossing a process boundary. Its own dependency list is empty.

**Validity stays derived from session status.** GLU-55 decided this and the reasoning is unchanged
and worth restating, because moving the code is exactly when someone would "improve" it: there is no
`revoked_at` column, because a revocation flag is a second source of truth that four call sites must
remember to write, and forgetting one leaves a dead desk able to claim work. Ending a session
invalidates its token by construction. The move must not introduce a cache that breaks that — see
the open question.

**Identity reads the `sessions` table; it does not own it.** `control` owns session *lifecycle* —
start, end, pause, the tmux pane. Identity reads `id`, `owner`, `status` and `token_hash`. Under
035's grants that is a read grant on specific columns of a table another service writes, which is a
genuinely awkward shape and the one thing about this ticket that is not clean. The alternative — a
separate `session_tokens` table owned by identity — is a migration, a join on the hot path, and a
second place a session's existence is recorded. Taking the awkward grant. Flagged in Q2 of 035,
which may split `platform_svc` for exactly this reason.

**The hash stays sha-256 and the token stays carried as `OFFICE_SESSION_TOKEN`.** No behaviour
changes. This ticket is a move plus a boundary, and anything else it changed would make the test
that proves nothing broke much harder to trust.

## Acceptance criteria

- [ ] Every test GLU-55 landed passes against the moved module, unchanged except for the import path.
      If a test needs editing beyond its import, the move changed behaviour and that is a blocker.
- [ ] `platform/identity` imports nothing from `features/`, asserted by 033's platform test.
- [ ] `mcp/protocol.ts` no longer imports from `features/orchestrator/`, and 033's baseline entry for
      it is **deleted** rather than left passing.
- [ ] A token whose session has ended fails authentication, with validity derived from status and no
      revocation column anywhere.
- [ ] A credential still shaped like `${...}` is refused with its own reason naming the launch
      environment — `looksUnexpanded`, preserved exactly, including its message.
- [ ] An unknown token, a well-formed token for a deleted session, and a token for a paused session
      each get their own distinguishable outcome. (A paused desk is a live desk; this is the case most
      likely to be got wrong by a move.)
- [ ] `startSession` still mints, and the token still reaches the pane as `OFFICE_SESSION_TOKEN` —
      asserted by 008's existing provisioning test, not a new one.
- [ ] Authentication cost measured: it is on every MCP tool call, so the number belongs in the ticket.
- [ ] **008 reopened** with a dated section for the move, and **017 reopened** for the
      `mcp/protocol.ts` import. Both sections' criteria checked before this closes.

## Open questions

- [ ] **Does identity cache?** Every MCP tool call does one indexed lookup by `token_hash`, which is
      cheap, and a cache would reintroduce the problem GLU-55's no-`revoked_at` decision was designed
      to avoid: a cached desk that is still valid after its session ended. Leaning: no cache until a
      measurement asks for one, and if one is ever added it is invalidated by session status change,
      not by TTL.
- [ ] Should `mintSessionToken` be in identity at all, or stay with `startSession`? Minting is part
      of the session lifecycle; resolving is platform. Splitting them puts the hash function in two
      places or makes `control` import it from platform — which is allowed and fine. Taking the
      whole of it into identity so the hash exists once; noting that it gives platform a write where
      it otherwise only reads.
- [ ] The design's account-level identity (the Lobby, per-office roles, invite tokens — step 9) is a
      different thing to desk identity and is not in this module. Whether they eventually share one
      `platform/identity` or stay separate is a step-9 question; naming this module `identity` rather
      than `desk-identity` quietly presumes the former. Worth a minute now rather than a rename
      later.
