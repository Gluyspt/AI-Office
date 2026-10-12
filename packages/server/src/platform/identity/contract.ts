// Desk identity — the only entry point.
//
// Ticket 039. Answers one question: **which desk is calling?** Not what it is
// allowed to do — that is the caller's check, and keeping the two apart is
// what lets 017's refusals name the conflict and its owner instead of saying
// "denied".
//
// WHY THIS IS PLATFORM AND NOT PART OF CONTROL. GLU-55 built the per-session
// secret where the session lifecycle lived, which was right at the time:
// `startSession` mints it, so it went next to `startSession`. But every layer
// needs to resolve a token, and `features/mcp/protocol.ts` — the RPC
// framework every MCP server is built on — was importing it out of the
// service that holds the `sudo` grant. Platform depending on the
// sudo-holding service is backwards in principle, and expensive in practice:
// once 040 moves `control` into its own process, every MCP tool call —
// every `claim_task`, every `complete_task` — would need a network round trip
// into the privileged process before it could learn who was asking, to answer
// one indexed sha-256 lookup.
//
// WHAT IT READS AND DOES NOT OWN. `control` owns the session lifecycle and
// writes the `sessions` table. Identity reads `id`, `owner`, `status` and
// `token_hash` from it. That is a genuinely awkward shape — a read grant on
// columns another service writes — and it was taken deliberately over the
// alternative, which is a separate `session_tokens` table: a migration, a
// join on the hot path, and a second place a session's existence is recorded.
// See 035's open question about splitting `platform_svc`.
export {
  authenticateSessionToken,
  type SessionAuthFailure,
  type SessionAuthFailureKind,
  type SessionAuthResult,
  type SessionAuthSuccess,
} from "./authenticate.ts";

export {
  SESSION_TOKEN_ENV_VAR,
  bearerCredential,
  describeSessionTokenShape,
  isSessionTokenShape,
  looksUnexpanded,
  mintSessionToken,
  sessionTokenHash,
  type MintedSessionToken,
} from "./token.ts";

/** Platform depends on platform. See `packages/server/src/platform/README.md`. */
export const dependencies: readonly string[] = [];
