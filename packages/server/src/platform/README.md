# platform/

Infrastructure every service calls. **Platform may be imported by anyone, and may import nothing
from `features/`.**

Ticket 033 established the rule; [the boundaries design](../../../../docs/service-boundaries-design.md)
§3 has the reasoning. `tests/boundaries/contracts.test.ts` enforces it.

## Why platform is not a service

The import census that started this found 33 cross-feature edges, and **14 of them pointed at
`events`** — from six of the eight features. That is not peer coupling; it is a star, and a star is
infrastructure.

Nothing is decoupled by making a feature ask permission to publish an event. So platform is exempt
from one half of the contract rule — a caller needs no permission and declares no dependency to use
it — and in exchange it is bound by a stricter one: it may depend on nothing above it.

**Corrected 2026-10-13, while building 034.** This section first said "anyone may import
`platform/das` directly, no `contract.ts` required". That is wrong, and 034 is where it showed:
importing `das/das.ts` hands the caller the raw pool, which makes a grant advisory rather than
enforced. The exemption is narrower than it looked:

| | Feature | Platform |
| --- | --- | --- |
| Reachable only via `contract.ts` | yes | **yes** |
| Caller must declare the dependency | yes | no |
| May import a feature | via its contract | **never** |

A platform module that has not published a `contract.ts` yet is not policed — several arrive before
their contract does, and refusing those imports would block the retrofit at the one point it has to
move incrementally.

That one-way rule is what makes platform extractable by construction, and it is a single line of
test rather than a convention anyone has to remember.

## What lives here

| Module | Owns | Ticket |
| --- | --- | --- |
| `das/` | The connection pool, transaction scope, per-service grants, lanes and statement timeouts | 034, 035, 036 |
| `events/` | Hook ingest, the bus, handler dispatch and per-handler deadlines | 037, then 005's retrofit |
| `identity/` | Minting and resolving a desk's per-session token | 039 — **landed 2026-10-13** |
| `mcp/` | JSON-RPC mounting for the MCP servers | 017's retrofit |
| `rpc/` | The loopback transport, once one service runs in its own process | 040 |

`das/` and `identity/` exist. Each remaining module arrives with its ticket, and the ones that move
here from `features/` do so as dated sections on the tickets that own those files — not as a sweep.

## The violation that motivated this — fixed 2026-10-13

`features/mcp/protocol.ts` imported `features/orchestrator/session-auth.ts`: the RPC framework
reaching into the service that holds the `sudo` grant, to answer a question every service asks —
which desk is calling.

Ticket 039 moved identity here, and the import now goes through
`platform/identity/contract.ts`. The cost of having left it would have been specific: once 040
moves `control` to its own process, every MCP tool call — every `claim_task`, every
`complete_task` — would have needed a network round trip into the privileged process before it
could learn who was asking, to answer one indexed `sha-256` lookup.

**The move needed more than a move.** `session-auth.ts` imported `SESSION_COLUMNS`,
`sessionRowToRecord` and `SessionRow` from `orchestrator/sessions.ts`, so relocating it as-is would
have put platform straight back to importing a feature. Those three (plus the `failure_reason`
codec) are pure mapping code between one table's columns and a record type already declared in
`@office/shared/sessions`, and **three** services read that table — `control` writes it, `identity`
resolves tokens against it, `chat` looks a desk up by its Claude session id. Leaving the mapper in
any one of them makes the other two import it across a boundary; putting it *here* would make
`control` depend on platform for its own data shape. It moved to the shared package, beside the type
it maps to. That also removed a `chat -> orchestrator` edge nobody had set out to fix.

## Adding a module here

1. It must be callable by every service and depend on no service. If it needs to know about tasks or
   locks, it is a service, not platform.
2. It publishes a `contract.ts` on the same terms as a service — not because callers are forced
   through it, but because 038's extractability check reads it.
3. It gets a row in the table above, in the ticket that adds it.
