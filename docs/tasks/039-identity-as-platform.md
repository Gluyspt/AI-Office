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
- `packages/server/src/platform/identity/authenticate.test.ts` (moved from `session-auth.test.ts`)

**`token.test.ts` was listed above and does not exist** — GLU-55 never wrote one. The token module's
behaviour (shape checks, `looksUnexpanded`, hashing) is covered through `authenticate.test.ts` and
`mcp/protocol.test.ts`. Listing a test file this ticket was never going to create was an error in
the plan, not a gap in the work; splitting that coverage out is a tidy-up with no finding behind it.

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

## Decided during implementation, 2026-10-13

**A plain move was not possible, and the fix removed an edge nobody set out to fix.**
`session-auth.ts` imported `SESSION_COLUMNS`, `sessionRowToRecord` and `SessionRow` from
`orchestrator/sessions.ts`, so relocating it as-is would have put platform straight back to
importing a feature — the exact rule this ticket exists to satisfy.

Three options, and the third is the one that is actually right:

| | Cost |
| --- | --- |
| Move the mapper into `platform/` too | Makes `control` depend on platform for **its own data shape**. Platform is infrastructure every service calls, not the home of one table's row type |
| Have identity return a narrow desk type instead of a `SessionRecord` | Cleanest boundary, but it changes `ToolContext.session`, which is 017's file and pre-commits **018's** API before 018 exists — and breaks this ticket's own "no behaviour changes" criterion |
| **Move the mapping to `@office/shared/sessions`** | Chosen. It is pure code with no owner, sitting beside the `SessionRecord` it maps to, in the package Q4 settled is for exactly that |

**Three** services read the `sessions` table: `control` writes it, `identity` resolves tokens
against it, and `chat` looks a desk up by its Claude session id. Leaving the mapper in any one of
them forces the other two to import it across a boundary. Moving it to `shared` therefore removed a
**`chat -> orchestrator`** baseline edge as well as both `mcp -> orchestrator` edges — 33 entries
down to 30, where this ticket had predicted one deletion.

**`sessionRowToRecord` casts the two ids rather than calling `asSessionId()` / `asProjectId()`.** Not
a style regression: `packages/shared` emits declarations and has no `allowImportingTsExtensions`, so
it can only *type*-import `./ids.ts` — a value import of those helpers is a `TS5097` there. The
helpers are themselves pure casts (`ids.ts:34-35`), so the move is behaviour-identical, which is what
let it claim nothing changed.

**The baseline test guided its own retrofit.** After the move, the staleness check failed and named
all three now-dead entries with the instruction to delete them. That is 033's mechanism doing the one
job the design claimed for it, on its first real use — and it is why the baseline is asserted in both
directions rather than only against growth.

## Acceptance criteria

- [x] Every test GLU-55 landed passes against the moved module, unchanged except for the import path.
      **Literally four changed lines, all imports** (`git diff` on `authenticate.test.ts`): two for the
      renamed siblings, two for reaching `features/orchestrator/` from its new depth.
- [x] `platform/identity` imports nothing from `features/`, asserted by 033's platform test. Its
      production imports are now `node:crypto`, `@office/shared/sessions`, `core/db/pool.ts` and its
      own `./token.ts`.
- [x] `mcp/protocol.ts` no longer imports from `features/orchestrator/`, and **three** baseline
      entries are deleted rather than left passing. It imports
      `platform/identity/contract.ts` — the contract, not an internal, which 033's
      platform-internals rule enforces.
- [x] A token whose session has ended fails authentication, with validity derived from status and no
      revocation column anywhere — GLU-55's own tests, unchanged.
- [x] A credential still shaped like `${...}` is refused with its own reason naming the launch
      environment — `looksUnexpanded`, preserved exactly, including its message.
- [x] An unknown token, a well-formed token for a deleted session, and a token for a paused session
      each get their own distinguishable outcome — all covered by the moved tests.
- [x] `startSession` still mints, and the token still reaches the pane as `OFFICE_SESSION_TOKEN` —
      008's and 009's existing tests pass unchanged; `sessions.ts` and `provision.ts` now import
      the contract.
- [ ] Authentication cost measured. **Not done** — it is one indexed `sha-256` lookup and the move
      changed no query, so a number taken now would measure the same code at a different import
      path. It belongs with 035, which puts `SET LOCAL ROLE` in the checkout path and is the first
      change that could plausibly move it.
- [x] **008 reopened** (the move, plus the mapping relocation to `@office/shared`) and **017
      reopened** (the `protocol.ts` import). **009 also reopened** — unplanned: `provision.ts`
      imports `SESSION_TOKEN_ENV_VAR` and had to be repointed too.

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
