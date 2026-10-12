// The per-session credential, as a value: minting it, hashing it, and
// recognising the two shapes that are not one.
//
// GLU-55, forced by spike 003 §3.2. Ticket 008 owns this because 008 is the
// only writer of the session machine and the only thing that knows a desk has
// been created; 017 and 018 are readers and must not reimplement any of it.
//
// THE PROBLEM THIS SOLVES, stated once so no caller re-derives it: the
// design's `claim_task` "checks owner match", and until this file the only
// secret in the office was per Linux *account*. One account hosts several
// desks (one Linux user per teammate, not per agent — settled 2026-10-07), so
// an account token identifies the teammate and "owner match" quietly becomes
// "same teammate". A desk claiming another desk's task would look identical
// to the real thing.
//
// THE CHANNEL: mint at spawn -> `OFFICE_SESSION_TOKEN` in the pane
// environment -> Claude Code expands it into the role file's
// `mcpServers.headers.Authorization` at startup -> the orchestrator reads it
// off the request. The model never sees the value and no tool-call shape
// changes it, which is the property spike 003's criterion asked for: an
// identity the agent cannot forge by calling the tool differently.
//
// WHY THIS IS SPLIT FROM ./session-auth.ts: everything here is pure, so
// `sessions.ts` can mint without importing the module that looks desks up —
// which imports `sessions.ts` in turn. The split exists to keep that cycle
// out of the session machine, and it also keeps the database pool out of
// `provision.ts`, which needs only the variable's name.
import { createHash, randomBytes } from "node:crypto";

/**
 * The environment variable the token travels in.
 *
 * Exported because three places must agree on the spelling and a typo in any
 * one of them is silent: `startSession` which sets it, ticket 009's role-file
 * validation which checks the role file only references variables the launch
 * environment provides, and the role files themselves. The office's other
 * launch variables are named in `agentLaunchSpec`; this one is not, because
 * its value is per session while that function runs once per role at
 * provisioning time, before any session exists.
 */
export const SESSION_TOKEN_ENV_VAR = "OFFICE_SESSION_TOKEN";

/**
 * `ost_` plus 32 random bytes, base64url.
 *
 * The prefix is not decoration. It lets a refusal distinguish "that is not an
 * office session token at all" — a stale hook ingest token, a bearer token
 * copied from somewhere else, a hand-edited header — from "that is a token I
 * do not recognise", and those two send a reader to different places. It also
 * gives a secret scanner something to match.
 */
const TOKEN_PREFIX = "ost_";
const TOKEN_BYTES = 32;

/** 32 bytes of base64url is 43 characters, unpadded. */
const TOKEN_RE = /^ost_[A-Za-z0-9_-]{43}$/;

export interface MintedSessionToken {
  /** Handed to exactly one process, once. Never logged, never stored. */
  readonly token: string;
  /** What goes in `sessions.token_hash`. */
  readonly hash: string;
}

export function mintSessionToken(): MintedSessionToken {
  const token = `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString("base64url")}`;
  return { token, hash: sessionTokenHash(token) };
}

export function sessionTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function isSessionTokenShape(value: string): boolean {
  return TOKEN_RE.test(value);
}

export function describeSessionTokenShape(): string {
  return `"${TOKEN_PREFIX}" followed by 43 base64url characters`;
}

/**
 * Does this string look like an environment variable that was never expanded?
 *
 * THE MOST IMPORTANT FUNCTION IN THIS FILE, and the least obvious.
 * Spike 003 §3.3, quoting the reference: if a variable referenced in an MCP
 * server config is unset and has no default, **the config still loads** and
 * Claude Code "uses the unexpanded `${VAR}` text as-is". The warning appears
 * in `claude mcp list` output, which nobody is reading during an unattended
 * spawn.
 *
 * So the failure mode of a missing `OFFICE_SESSION_TOKEN` is not a desk that
 * refuses to start. It is every desk on the box presenting the literal string
 * `${OFFICE_SESSION_TOKEN}` as its credential — the *same* string for all of
 * them. A server that treated that as an identity would hand every agent one
 * shared desk, which is the bug this file exists to prevent, arrived at from
 * the other direction.
 *
 * Hence it is checked before the token's own shape and gets its own refusal
 * naming the launch environment, because that is where the repair is — not in
 * the token, not in the database, not in the MCP server.
 */
export function looksUnexpanded(value: string): boolean {
  return /\$\{[A-Za-z_][A-Za-z0-9_]*(:-[^}]*)?\}/.test(value);
}

/**
 * Pull the credential out of an `Authorization` header value.
 *
 * Tolerant about the scheme's case and the surrounding whitespace, strict
 * about everything else. Returns null when there is no bearer credential at
 * all, which callers report differently from a credential they reject.
 */
export function bearerCredential(headerValue: string | undefined): string | null {
  if (typeof headerValue !== "string") return null;
  const match = /^\s*bearer\s+(\S.*?)\s*$/i.exec(headerValue);
  return match ? (match[1] as string) : null;
}
