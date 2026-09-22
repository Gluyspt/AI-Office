// Does one declared file pattern overlap another?
//
// Pure: no database, no clock, no I/O. Everything the registry decides
// about conflicts is decided here, which is what makes the rule testable as
// a table rather than inferred from acquisition outcomes.
//
// Two ideas, and the second is the one that matters.
//
// NORMALISATION. The design never says what "the same file" means, and the
// same file can be written `./src/a.ts`, `src/a.ts`, `src\a.ts` or
// `src//a.ts`. A registry that compares raw strings is defeated by a
// spelling, silently — two agents each hold "their own" pattern and edit
// one file. So every pattern goes through `normalisePattern` before any
// comparison, and patterns that cannot be normalised (absolute, or escaping
// the repo root) are rejected rather than guessed at.
//
// CONSERVATIVE RESOLUTION. Glob-versus-glob disjointness is undecidable in
// general. The decision recorded in docs/tasks/README.md is to resolve
// conservatively: report a conflict whenever disjointness cannot be
// *proved*. A false conflict serialises one task; a false clearance causes
// the git conflict this registry exists to prevent. The asymmetry is the
// whole argument, and `certain` on the verdict records which branch was
// taken so a refusal can say whether it was demonstrated or assumed.

/** Characters that make a pattern a glob rather than a path. `{`/`}` count
 * because brace expansion is a glob feature in every shell and matcher this
 * would plausibly be fed to. */
const GLOB_CHARS = /[*?[\]{}]/;

export class InvalidPatternError extends Error {
  constructor(readonly pattern: string, reason: string) {
    super(`invalid file-scope pattern ${JSON.stringify(pattern)}: ${reason}`);
    this.name = "InvalidPatternError";
  }
}

/**
 * Repo-relative POSIX form, or a throw.
 *
 * Rejects rather than repairs two cases: an absolute path (it names a file
 * outside the repo, which a task scope cannot own) and a path escaping the
 * root with `..` (it means the same thing, less obviously). Both are
 * mistakes worth surfacing at declaration time, when a human is looking at
 * the draft batch, rather than at acquisition time inside an agent.
 *
 * A trailing slash is preserved as the marker of "this is a directory, and
 * I mean everything under it" — `src/` and `src` are the same set here,
 * because a bare `src` could equally be a directory, and treating it as one
 * is the conservative reading.
 */
export function normalisePattern(raw: string): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new InvalidPatternError(String(raw), "must be a non-empty string");
  }

  let path = raw.trim().replace(/\\/g, "/");
  if (path.startsWith("/")) {
    throw new InvalidPatternError(raw, "must be repo-relative, not absolute");
  }
  path = path.replace(/\/{2,}/g, "/");

  const hadTrailingSlash = path.endsWith("/") && path !== "/";
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) {
        throw new InvalidPatternError(raw, "escapes the repository root");
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  if (segments.length === 0) {
    throw new InvalidPatternError(raw, "resolves to the repository root");
  }

  return segments.join("/") + (hadTrailingSlash ? "/" : "");
}

export function hasGlob(pattern: string): boolean {
  return GLOB_CHARS.test(pattern);
}

/** Everything before the first glob character — the longest literal path
 * any match must start with. `src/a*.ts` -> `src/a`; `**\/x` -> ``. */
export function literalPrefix(pattern: string): string {
  const match = GLOB_CHARS.exec(pattern);
  return match ? pattern.slice(0, match.index) : pattern;
}

/** Does `b` sit at or beneath `a`, on a path-segment boundary? `src` covers
 * `src/a.ts` but not `srcolder/a.ts`, which a plain startsWith would get
 * wrong. */
function coversPath(a: string, b: string): boolean {
  const base = a.endsWith("/") ? a.slice(0, -1) : a;
  const other = b.endsWith("/") ? b.slice(0, -1) : b;
  return other === base || other.startsWith(`${base}/`);
}

export interface OverlapVerdict {
  readonly overlaps: boolean;
  /**
   * True when the verdict was demonstrated: the paths are equal, one
   * literally contains the other, or their literal prefixes provably
   * diverge. False only on the conservative branch — "these both involve
   * globs and I cannot prove they miss each other".
   */
  readonly certain: boolean;
  readonly reason: string;
}

/**
 * Whether two already-normalised patterns can touch the same file.
 *
 * Exact and literal cases are decided outright. Once a glob is involved the
 * only sound cheap test is on literal prefixes: if the two prefixes diverge
 * at some path segment, no expansion of either glob can reach the other's
 * subtree, so they are *provably* disjoint. If one prefix sits inside the
 * other, the globs might meet — and per the decision, might-meet is a
 * conflict.
 */
export function patternsOverlap(a: string, b: string): OverlapVerdict {
  if (a === b) {
    return { overlaps: true, certain: true, reason: "identical patterns" };
  }

  const globA = hasGlob(a);
  const globB = hasGlob(b);

  if (!globA && !globB) {
    if (coversPath(a, b) || coversPath(b, a)) {
      return {
        overlaps: true,
        certain: true,
        reason: "one path contains the other",
      };
    }
    return { overlaps: false, certain: true, reason: "distinct literal paths" };
  }

  const prefixA = literalPrefix(a);
  const prefixB = literalPrefix(b);

  // A pattern beginning with a glob constrains nothing — `*.ts` can match
  // at any depth, so it must be treated as touching everything.
  if (prefixA === "" || prefixB === "") {
    return {
      overlaps: true,
      certain: false,
      reason: "a pattern starts with a wildcard, so it can match anywhere",
    };
  }

  // STRING prefix here, not path prefix — and the distinction is the bug
  // this comment exists to prevent recurring. `src/a*.ts` and `src/ab*.ts`
  // have literal prefixes `src/a` and `src/ab`, which are not in a
  // path-segment relationship, yet both patterns match `src/ab.ts`: a `*`
  // continues *within* a segment. Comparing on segment boundaries here
  // declares that pair disjoint, which is the false-clearance direction —
  // the one that costs a git conflict.
  //
  // String prefixing is strictly more conservative than path prefixing, so
  // it can only ever produce extra refusals, never extra clearances. That
  // is the correct side of the asymmetry to err on.
  if (prefixA.startsWith(prefixB) || prefixB.startsWith(prefixA)) {
    return {
      overlaps: true,
      certain: false,
      reason:
        `cannot prove ${JSON.stringify(a)} and ${JSON.stringify(b)} are disjoint — ` +
        "their literal prefixes overlap and glob disjointness is undecidable in general, " +
        "so this is refused conservatively",
    };
  }

  return {
    overlaps: false,
    certain: true,
    reason: "literal prefixes diverge, so no expansion of either can reach the other",
  };
}

/** Normalises a whole declared scope, rejecting duplicates after
 * normalisation — two spellings of one path in one scope is a mistake worth
 * reporting, not a thing to silently dedupe. */
export function normaliseScope(patterns: readonly string[]): string[] {
  if (patterns.length === 0) {
    throw new InvalidPatternError("", "a file scope must declare at least one pattern");
  }
  const seen = new Map<string, string>();
  for (const raw of patterns) {
    const normalised = normalisePattern(raw);
    const previous = seen.get(normalised);
    if (previous !== undefined) {
      throw new InvalidPatternError(
        raw,
        `duplicates ${JSON.stringify(previous)} — both normalise to ${JSON.stringify(normalised)}`,
      );
    }
    seen.set(normalised, raw);
  }
  return [...seen.keys()];
}

/** The first overlap between any pattern of `a` and any of `b`, or null.
 * Used to check a proposed scope against one already-held pattern set. */
export function findScopeOverlap(
  a: readonly string[],
  b: readonly string[],
): { readonly left: string; readonly right: string; readonly verdict: OverlapVerdict } | null {
  for (const left of a) {
    for (const right of b) {
      const verdict = patternsOverlap(left, right);
      if (verdict.overlaps) return { left, right, verdict };
    }
  }
  return null;
}
