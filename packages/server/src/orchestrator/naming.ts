// Deterministic tmux session names for agent desks.
//
// The name is not a label, it is the address. Every tmux command this
// adapter runs identifies a session by name, so the naming rule is a
// safety property rather than a cosmetic one. Three things follow from
// that, and each is enforced here rather than left to callers:
//
//  1. **Deterministic.** The same (project, department, role, owner) must
//     produce the same name across orchestrator restarts, or a restart
//     loses the ability to address sessions that are still running. The
//     name is derived, never stored-and-hoped-for.
//
//  2. **Total.** The inputs are human-typed (a project is named in a
//     browser). A project called `"; rm -rf ~"` or `"你好"` has to yield a
//     usable tmux name, not an error and not a name that means something
//     to tmux. Everything outside [a-z0-9-] is replaced before it reaches
//     the label, and identity is carried by a hash of the *raw* fields, so
//     two projects that slugify to the same label still get different
//     names.
//
//  3. **Collision-free by construction.** The trailing hash covers all
//     four fields at full fidelity; the readable prefix is decoration. A
//     genuine collision therefore means "the same desk", which is the
//     correct answer — the same desk should resolve to the same session.
//     A second *concurrent* session for one desk is an explicit decision
//     by the caller (ticket 008's registry), expressed as a `generation`,
//     not something this module invents behind its back.
//
// tmux name constraints: a session name may not contain `.` or `:` (tmux
// parses those as window/pane addressing) and may not be empty. The
// charset below is a strict subset, so a generated name is always legal.
//
// **Measured, on tmux 3.4 (WSL, 2026-09-22, this ticket):** tmux resolves
// an unknown target by *prefix* before giving up. With only
// `t007-cat-long` alive, `tmux send-keys -t "t007-cat:" -l -- PREFIX`
// exited 0 and delivered the text to `t007-cat-long`. The same command
// with the exact-match prefix — `-t "=t007-cat:"` — exited 1 with
// `can't find session: t007-cat`. So a message meant for a desk that has
// since died can be typed into a *different live agent* unless every
// target is exact-matched. `sessionTarget` / `paneTarget` in
// shell-quote.ts are the only supported way to build a target, and the
// suffixed generation names below are exactly the prefix relationship
// that makes this reachable.

import { createHash } from "node:crypto";

/**
 * Every session this orchestrator creates starts with this. `listSessions`
 * filters on it so the adapter can never report — or act on — a tmux
 * session a human started by hand on the same box.
 */
export const SESSION_NAME_PREFIX = "office";

/** Legal generated name: lowercase, digits and hyphens only. No `.`, no `:`. */
const SESSION_NAME_RE = /^[a-z0-9][a-z0-9-]{0,126}[a-z0-9]$/;

/** Readable-label budgets. The hash, not these, carries identity. */
const PROJECT_LABEL_MAX = 16;
const DEPARTMENT_LABEL_MAX = 8;
const ROLE_LABEL_MAX = 16;

/** Hex characters of SHA-256 kept. 10 hex = 40 bits over four fields. */
const HASH_LENGTH = 10;

export interface SessionIdentity {
  /** Project the desk belongs to — id or name; whatever the registry keys on. */
  readonly project: string;
  /** Department: `dev`, `research`, `qa`, … */
  readonly department: string;
  /** Role slot within the department: `dev-lead`, `management-lead`, … */
  readonly role: string;
  /**
   * The account the desk belongs to. Folded into the hash but deliberately
   * *not* into the readable label: the label is already long, and the Linux
   * user a session runs as is visible from `ps`. Two owners with the same
   * project/department/role still get different names.
   */
  readonly owner: string;
}

/**
 * Lowercase, hyphenate, trim. Non-ASCII and punctuation collapse to a
 * single hyphen. Returns `"x"` for input that reduces to nothing (an
 * all-CJK project name, say) — the label is decoration, the hash is
 * identity, so an uninformative label is acceptable where an empty or
 * illegal one is not.
 */
export function slugify(value: string, maxLength: number): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return slug === "" ? "x" : slug;
}

/**
 * Length-prefixed join. `["ab", "c"]` and `["a", "bc"]` must not hash to
 * the same value, which a plain separator cannot guarantee once a field is
 * allowed to contain that separator.
 */
function canonical(identity: SessionIdentity): string {
  return [identity.project, identity.department, identity.role, identity.owner]
    .map((field) => `${Buffer.byteLength(field, "utf8")}:${field}`)
    .join("");
}

export function identityHash(identity: SessionIdentity): string {
  return createHash("sha256").update(canonical(identity), "utf8").digest("hex").slice(0, HASH_LENGTH);
}

/**
 * The name for a desk. `generation` is for the one case a deterministic
 * name cannot express: a caller that knowingly wants a *second* live
 * session for the same desk (a restart overlapping the session it
 * replaces). Generation 0 — the default — has no suffix, so the common
 * name never changes shape.
 *
 * Note that `<base>` is a strict prefix of `<base>-g2`. That is safe only
 * because every target is exact-matched; see the header comment.
 */
export function sessionName(identity: SessionIdentity, generation = 0): string {
  if (!Number.isInteger(generation) || generation < 0) {
    throw new RangeError(`generation must be a non-negative integer, got ${String(generation)}`);
  }
  const parts = [
    SESSION_NAME_PREFIX,
    slugify(identity.project, PROJECT_LABEL_MAX),
    slugify(identity.department, DEPARTMENT_LABEL_MAX),
    slugify(identity.role, ROLE_LABEL_MAX),
    identityHash(identity),
  ];
  const base = parts.join("-");
  return generation === 0 ? base : `${base}-g${generation}`;
}

export function isValidSessionName(name: string): boolean {
  return SESSION_NAME_RE.test(name);
}

/**
 * The full shape `sessionName()` produces: the prefix, at least one label
 * segment, the ten-hex identity hash, and an optional `-g<N>` generation.
 *
 * Matching the whole shape rather than just the prefix is a safety
 * requirement, not tidiness. On a shared VPS the `office` account can see
 * every tmux session it is allowed to reach, and `listSessions` decides
 * which of those the orchestrator may act on — including kill. A prefix test
 * would claim anything a human happened to name `office-<something>`. That
 * is not hypothetical: `office-capture`, a hook-listener session on the dev
 * box, passes a prefix test and fails this one.
 */
const OFFICE_SESSION_NAME_RE = new RegExp(
  `^${SESSION_NAME_PREFIX}-[a-z0-9][a-z0-9-]*-[0-9a-f]{${HASH_LENGTH}}(?:-g[1-9][0-9]*)?$`,
);

/** True only for names this orchestrator could actually have generated.
 * Used to keep `listSessions` — and therefore anything that kills — from
 * ever reaching a human's own tmux session. */
export function isOfficeSessionName(name: string): boolean {
  return isValidSessionName(name) && OFFICE_SESSION_NAME_RE.test(name);
}
