// Turning a presented credential back into the desk that presented it.
//
// GLU-55, ticket 008. The value half is ./session-token.ts; this is the half
// that touches the database. 017's `/mcp/tasks` and 018's `/mcp/session` both
// call `authenticateSessionToken` and neither reimplements it — one identity
// check, one set of refusals, one place to fix.
//
// WHAT IS DELIBERATELY NOT HERE: authorisation. This answers "which desk is
// this?" and nothing else. Whether that desk may claim a particular task is
// 017's check against the task's owner. Keeping the two apart is what lets
// 017's refusals name the conflict and its owner instead of saying "denied" —
// a refusal an agent can act on, which spike 003 §4 found is the difference
// between a teaching signal and a retry loop.
import { timingSafeEqual } from "node:crypto";
import type { SessionRecord } from "@office/shared/sessions";
import { query } from "../../core/db/pool.ts";
import { SESSION_COLUMNS, sessionRowToRecord, type SessionRow } from "@office/shared/sessions";
import {
  SESSION_TOKEN_ENV_VAR,
  describeSessionTokenShape,
  isSessionTokenShape,
  looksUnexpanded,
  sessionTokenHash,
} from "./token.ts";

export type SessionAuthFailureKind =
  /** No `Authorization: Bearer …` at all. */
  | "missing"
  /** The credential is still a literal `${VAR}`. See `looksUnexpanded`. */
  | "unexpanded"
  /** Not shaped like an office session token — wrong prefix, length or alphabet. */
  | "malformed"
  /** Well-formed, but no session row holds this hash. */
  | "unknown"
  /** The desk exists and is not live, so its token identifies nothing reachable. */
  | "session_not_live";

export interface SessionAuthFailure {
  readonly ok: false;
  readonly kind: SessionAuthFailureKind;
  /**
   * Written for whoever reads it, who is either a human debugging a desk that
   * cannot claim work or a model deciding what to do next — so it says what
   * to change, not which branch failed. Safe to return over HTTP: it never
   * echoes the presented credential.
   */
  readonly message: string;
}

export interface SessionAuthSuccess {
  readonly ok: true;
  readonly session: SessionRecord;
}

export type SessionAuthResult = SessionAuthSuccess | SessionAuthFailure;

/**
 * The same definition of "live" the two partial unique indexes in
 * 0003_sessions.sql use.
 *
 * `starting` counts deliberately. An agent's MCP servers connect at startup,
 * before the hook gate has promoted the row to `running`, so refusing those
 * calls would park a desk for a reason it cannot act on — and the hook gate
 * already kills a desk that never reports, so a `starting` row is never
 * indefinitely claimable.
 */
const LIVE_STATUSES: readonly string[] = ["starting", "running"];

function fail(kind: SessionAuthFailureKind, message: string): SessionAuthFailure {
  return { ok: false, kind, message };
}

/**
 * Which desk is this?
 *
 * The order of the checks is the point: placeholder before shape, shape
 * before lookup, lookup before liveness. Each refusal names a different
 * repair, and collapsing any two into "unauthorized" sends someone to the
 * wrong one — the office has already paid for that twice (008's hook
 * diagnosis blaming TLS for an unprovisioned desk, and the three probes that
 * reported a correct config as broken).
 */
export async function authenticateSessionToken(
  presented: string | null,
): Promise<SessionAuthResult> {
  if (presented === null || presented.trim() === "") {
    return fail(
      "missing",
      `no credential: this endpoint identifies the calling desk from an \`Authorization: Bearer\` header carrying ${SESSION_TOKEN_ENV_VAR}. A desk reaching it without one was launched outside the orchestrator, or its role file has no \`mcpServers\` headers block.`,
    );
  }

  if (looksUnexpanded(presented)) {
    return fail(
      "unexpanded",
      `the credential is still a literal \${…} placeholder, so ${SESSION_TOKEN_ENV_VAR} was not set in this desk's launch environment. Claude Code loads an MCP config whose variables are unset and sends the placeholder text as-is, so every desk in that state presents the same string — it is refused rather than treated as an identity. The repair is in the pane environment the orchestrator sets at spawn, not in the MCP server and not in the role file.`,
    );
  }

  if (!isSessionTokenShape(presented)) {
    return fail(
      "malformed",
      `that is not an office session token: expected ${describeSessionTokenShape()}. A hook ingest token, a bearer token from another service, or a hand-edited header all land here.`,
    );
  }

  const hash = sessionTokenHash(presented);
  // SESSION_COLUMNS deliberately does not carry `token_hash` — it is the
  // read list behind every API response, and a secret-derived column has no
  // business travelling with them. The one query that needs it asks.
  const { rows } = await query<SessionRow & { token_hash: string | null }>(
    `select ${SESSION_COLUMNS}, token_hash from sessions where token_hash = $1`,
    [hash],
  );
  const row = rows[0];
  if (!row || !equalHex(row.token_hash ?? "", hash)) {
    return fail(
      "unknown",
      "that session token is not one this office issued. It belongs to a desk whose row has been deleted (its project was removed), or to a different office installation.",
    );
  }

  const session = sessionRowToRecord(row);
  if (!LIVE_STATUSES.includes(session.status)) {
    return fail(
      "session_not_live",
      `desk ${session.tmuxName} (${session.role}/${session.dept}, owner ${session.owner}) is ${session.status}, so its session token no longer identifies a live desk. A token stops working the moment its session ends — there is nothing to revoke and nothing to retry. Ask for a new session.`,
    );
  }

  return { ok: true, session };
}

/**
 * Constant-time compare of two hex digests.
 *
 * Belt and braces over the SQL, which already matched by an indexed equality
 * the database evaluates however it likes. It cannot realistically fail — a
 * unique index on a 256-bit digest — which is why it is cheap to keep, and it
 * is here so that nothing in the office's credential path compares a secret
 * with `===`.
 */
function equalHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
