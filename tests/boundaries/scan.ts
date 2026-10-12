// The import scanner the boundary tests are built on.
//
// Ticket 033. This file exists because three tests need the same answer to
// one question — "which file imports which, and does it cross a boundary" —
// and a regex copied into each would drift between them.
//
// WHY SYNTACTIC AND NOT THE TYPESCRIPT COMPILER API. 033's open question
// records the choice: a syntactic scan is cheap, needs no program
// construction, and catches every case that exists in this tree today. The
// compiler API would be exact about re-exports and type-only aliasing, and
// is a bigger change than this ticket. If a false pass ever costs a retrofit,
// that is the trigger to switch — not before.
//
// COMMENTS ARE STRIPPED BEFORE MATCHING, and that is not a nicety. This
// codebase writes long explanatory headers, and several of them contain the
// words `from "..."` while quoting a path (claim.ts and app.ts both do). A
// scanner that matched those would invent edges that no import creates, and
// the baseline would then be a list of phantoms nobody could ever delete.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repo root, from tests/boundaries/. */
export const repoRoot = path.resolve(here, "..", "..");

export const serverSrc = path.join(repoRoot, "packages", "server", "src");
export const featuresRoot = path.join(serverSrc, "features");
export const platformRoot = path.join(serverSrc, "platform");

/** The one public file of a feature. A file, not a directory and not an
 *  index — see 033's "Decided". */
export const CONTRACT_FILE = "contract.ts";

export interface Edge {
  /** Repo-relative, POSIX separators, so a failure message is copy-pasteable
   *  and a baseline entry is identical on Windows and Linux. */
  readonly from: string;
  readonly to: string;
  readonly fromFeature: string;
  readonly toFeature: string;
  /** True when `to` is the target feature's contract — the legal form. */
  readonly viaContract: boolean;
}

export interface PlatformEdge {
  readonly from: string;
  readonly to: string;
  readonly toFeature: string;
}

function isSourceFile(name: string): boolean {
  if (!name.endsWith(".ts") && !name.endsWith(".tsx")) return false;
  if (name.endsWith(".d.ts")) return false;
  if (name.endsWith(".test.ts") || name.endsWith(".test.tsx")) return false;
  return true;
}

/** Every non-test source file under `dir`, recursively, in sorted order so
 *  findings are deterministic across machines. */
export function listSourceFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    // A missing directory is not a failure: `platform/` does not exist until
    // this ticket creates it, and `features/planning/` not until 019.
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...listSourceFiles(full));
    } else if (isSourceFile(entry)) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Removes line and block comments, leaving string literals intact.
 *
 * Deliberately simple: it tracks whether it is inside a single-quoted,
 * double-quoted or template string, and otherwise treats `//` and the block
 * form as comment starts. It does not understand regex literals containing a
 * slash-slash, which this codebase does not have and which would at worst
 * drop a few characters of source rather than invent an import.
 */
export function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;

  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];

    if (quote !== null) {
      out += ch;
      if (ch === "\\") {
        // Keep the escaped character so a \" does not end the string.
        if (i + 1 < source.length) out += source[i + 1]!;
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

const FROM_SPEC = /\bfrom\s*["']([^"']+)["']/g;
const BARE_IMPORT = /\bimport\s*["']([^"']+)["']/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

/** Every module specifier a file imports, as written. */
export function extractSpecifiers(source: string): string[] {
  const clean = stripComments(source);
  const specs: string[] = [];
  for (const re of [FROM_SPEC, BARE_IMPORT, DYNAMIC_IMPORT]) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(clean)) !== null) specs.push(match[1]!);
  }
  return specs;
}

function toPosixRelative(absolute: string): string {
  return path.relative(repoRoot, absolute).split(path.sep).join("/");
}

/** The feature a path belongs to, or null if it is outside `features/`. */
export function featureOf(absolute: string): string | null {
  const rel = path.relative(featuresRoot, absolute);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const [feature] = rel.split(path.sep);
  return feature ?? null;
}

/** Resolves a specifier to an absolute path, or null when it is not a
 *  relative import (a package, or `@office/shared`, neither of which can
 *  cross a feature boundary). */
export function resolveSpecifier(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  return path.resolve(path.dirname(fromFile), spec);
}

export interface ScanOptions {
  /** Override the tree to scan. Mirrors `buildApp({ featuresDir })` and
   *  `loadHandlers(dir)`, which exist so a test can point at a scratch tree
   *  instead of the real one. */
  readonly featuresDir?: string;
  readonly platformDir?: string;
}

/** Every import that leaves its own feature, legal or not. */
export function crossFeatureEdges(options: ScanOptions = {}): Edge[] {
  const root = options.featuresDir ?? featuresRoot;
  const edges: Edge[] = [];

  for (const file of listSourceFiles(root)) {
    const rel = path.relative(root, file);
    const fromFeature = rel.split(path.sep)[0];
    if (fromFeature === undefined) continue;

    for (const spec of extractSpecifiers(readFileSync(file, "utf8"))) {
      const resolved = resolveSpecifier(file, spec);
      if (resolved === null) continue;

      const targetRel = path.relative(root, resolved);
      if (targetRel.startsWith("..") || path.isAbsolute(targetRel)) continue;
      const toFeature = targetRel.split(path.sep)[0];
      if (toFeature === undefined || toFeature === fromFeature) continue;

      edges.push({
        from: toPosixRelative(file),
        to: toPosixRelative(resolved),
        fromFeature,
        toFeature,
        viaContract: path.basename(resolved) === CONTRACT_FILE
          && path.dirname(resolved) === path.join(root, toFeature),
      });
    }
  }

  return edges.sort((a, b) => (a.from + a.to).localeCompare(b.from + b.to));
}

/** Platform files importing out of `features/` — the one-way rule. */
export function platformEdges(options: ScanOptions = {}): PlatformEdge[] {
  const platform = options.platformDir ?? platformRoot;
  const features = options.featuresDir ?? featuresRoot;
  const edges: PlatformEdge[] = [];

  for (const file of listSourceFiles(platform)) {
    for (const spec of extractSpecifiers(readFileSync(file, "utf8"))) {
      const resolved = resolveSpecifier(file, spec);
      if (resolved === null) continue;
      const rel = path.relative(features, resolved);
      if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
      const toFeature = rel.split(path.sep)[0];
      if (toFeature === undefined) continue;
      edges.push({ from: toPosixRelative(file), to: toPosixRelative(resolved), toFeature });
    }
  }

  return edges.sort((a, b) => (a.from + a.to).localeCompare(b.from + b.to));
}

/**
 * Imports that reach INTO a platform module from outside it.
 *
 * Added 2026-10-13 (033's dated section, driven by 034). The platform
 * exemption was written loosely enough to read as "platform has no private
 * files", and `platform/README.md` said exactly that. That cannot be right
 * for the DAS: a caller importing `das/das.ts` gets the raw pool, and a grant
 * becomes advisory. So the exemption is narrower than it first looked —
 *
 *   - platform needs no *permission* to be depended on (no declared
 *     dependency, no contract on the caller's side), and
 *   - platform may import nothing from `features/`, but
 *   - a platform module's internals are still private. `contract.ts` is the
 *     entry point, exactly as for a feature.
 *
 * A module with no `contract.ts` is not yet subject to this — `platform/das/`
 * has one, a future `platform/x/README.md` does not.
 */
export function platformInternalEdges(options: ScanOptions = {}): PlatformEdge[] {
  const platform = options.platformDir ?? platformRoot;
  const features = options.featuresDir ?? featuresRoot;
  const edges: PlatformEdge[] = [];

  // Every file that is NOT inside the platform module it imports from.
  const outsiders = [...listSourceFiles(features), ...listSourceFiles(platform)];

  for (const file of outsiders) {
    for (const spec of extractSpecifiers(readFileSync(file, "utf8"))) {
      const resolved = resolveSpecifier(file, spec);
      if (resolved === null) continue;

      const rel = path.relative(platform, resolved);
      if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
      const module = rel.split(path.sep)[0];
      if (module === undefined) continue;

      // Inside the same platform module: private is private to outsiders.
      const fromRel = path.relative(platform, file);
      const fromModule =
        fromRel.startsWith("..") || path.isAbsolute(fromRel) ? null : fromRel.split(path.sep)[0];
      if (fromModule === module) continue;

      // A module that publishes no contract yet cannot be reached "wrongly".
      const moduleContract = path.join(platform, module, CONTRACT_FILE);
      try {
        if (!statSync(moduleContract).isFile()) continue;
      } catch {
        continue;
      }

      if (resolved !== moduleContract) {
        edges.push({
          from: toPosixRelative(file),
          to: toPosixRelative(resolved),
          toFeature: module,
        });
      }
    }
  }

  return edges.sort((a, b) => (a.from + a.to).localeCompare(b.from + b.to));
}

/** `features/<name>/contract.ts` for every feature that has published one. */
export function contractFiles(options: ScanOptions = {}): string[] {
  const root = options.featuresDir ?? featuresRoot;
  let features: string[];
  try {
    features = readdirSync(root).sort();
  } catch {
    return [];
  }
  return features
    .map((feature) => path.join(root, feature, CONTRACT_FILE))
    .filter((file) => {
      try {
        return statSync(file).isFile();
      } catch {
        return false;
      }
    });
}

/** An edge written the way the baseline and the crossings list write it. */
export function edgeKey(edge: { from: string; to: string }): string {
  return `${edge.from} -> ${edge.to}`;
}
