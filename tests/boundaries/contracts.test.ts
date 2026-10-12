// The boundary rules, enforced.
//
// Ticket 033, plus a dated section of 2026-10-13. Four rules live here:
//
//   1. A feature may import another feature only through its contract.
//   2. Platform may import no feature.
//   3. A platform module's internals are private too — `contract.ts` is the
//      entry point, exactly as for a feature. Added 2026-10-13, driven by
//      034: importing `das/das.ts` hands the caller the raw pool and makes a
//      grant advisory rather than enforced. What platform is exempt from is
//      needing permission and a declared dependency, not from having private
//      files.
//   4. A contract's surface carries serialisable values, except the four
//      enumerated crossings.
//
// Every one is checked against the real tree AND against a scratch fixture.
// The fixture half is not padding: a rule that cannot be shown to fail is a
// rule nobody should trust, and three of these have little or nothing to find
// in the real tree yet — only `das` has published a contract. Without the
// fixtures this file would be a few hundred lines of green that proves
// nothing.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BASELINE } from "./baseline.ts";
import { CROSSINGS, NON_SERIALISABLE_TYPES } from "./crossings.ts";
import {
  contractFiles,
  crossFeatureEdges,
  edgeKey,
  extractSpecifiers,
  platformEdges,
  platformInternalEdges,
  stripComments,
} from "./scan.ts";
import { readFileSync } from "node:fs";

// --- fixture helpers ------------------------------------------------------

const scratchDirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "office-boundaries-"));
  scratchDirs.push(dir);
  return dir;
}

/** Writes `features/<feature>/<file>` with the given source. */
function writeFeatureFile(root: string, feature: string, file: string, source: string): void {
  const full = path.join(root, feature, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, source);
}

/**
 * A scratch tree with `features/` and `platform/` as SIBLINGS, the way the
 * real `packages/server/src/` has them.
 *
 * The platform rule can only be tested against a tree shaped like the real
 * one: the import under test is `../../features/alpha/internal.ts`, and a
 * relative specifier like that is meaningless if the two directories are
 * unrelated temp folders.
 */
function scratchServerTree(): { features: string; platform: string } {
  const root = scratch();
  const features = path.join(root, "features");
  const platform = path.join(root, "platform");
  mkdirSync(features, { recursive: true });
  mkdirSync(platform, { recursive: true });
  return { features, platform };
}

function writePlatformFile(platform: string, file: string, source: string): void {
  const full = path.join(platform, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, source);
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  }
});

// --- rule 1: a feature's internals are private ----------------------------

describe("the deep-import rule", () => {
  it("refuses an import of another feature's internal, naming the contract to use", () => {
    const features = scratch();
    writeFeatureFile(features, "alpha", "uses.ts", `import { x } from "../beta/internal.ts";\n`);
    writeFeatureFile(features, "beta", "internal.ts", `export const x = 1;\n`);

    const illegal = crossFeatureEdges({ featuresDir: features }).filter((e) => !e.viaContract);

    expect(illegal).toHaveLength(1);
    expect(illegal[0]!.from).toContain("alpha/uses.ts");
    expect(illegal[0]!.to).toContain("beta/internal.ts");
    // The message a reader gets has to name the fix, not just the fault.
    expect(`features/${illegal[0]!.toFeature}/contract.ts`).toBe("features/beta/contract.ts");
  });

  it("allows an import of another feature's contract", () => {
    const features = scratch();
    writeFeatureFile(features, "alpha", "uses.ts", `import { x } from "../beta/contract.ts";\n`);
    writeFeatureFile(features, "beta", "contract.ts", `export const x = 1;\n`);

    const edges = crossFeatureEdges({ featuresDir: features });

    expect(edges).toHaveLength(1);
    expect(edges[0]!.viaContract).toBe(true);
    expect(edges.filter((e) => !e.viaContract)).toHaveLength(0);
  });

  it("does not count an import inside one feature as crossing anything", () => {
    const features = scratch();
    writeFeatureFile(features, "alpha", "a.ts", `import { x } from "./b.ts";\n`);
    writeFeatureFile(features, "alpha", "b.ts", `export const x = 1;\n`);

    expect(crossFeatureEdges({ featuresDir: features })).toHaveLength(0);
  });

  it("ignores package imports, which cannot cross a feature boundary", () => {
    const features = scratch();
    writeFeatureFile(
      features,
      "alpha",
      "a.ts",
      `import pg from "pg";\nimport type { TaskId } from "@office/shared/ids";\n`,
    );

    expect(crossFeatureEdges({ featuresDir: features })).toHaveLength(0);
  });
});

// --- the baseline ---------------------------------------------------------

describe("the baseline", () => {
  const illegal = crossFeatureEdges().filter((e) => !e.viaContract).map(edgeKey);

  it("covers every violation in the tree — nothing new has been added", () => {
    const unlisted = illegal.filter((edge) => !BASELINE.includes(edge));
    // The failure message is the whole value of this test: it has to tell an
    // agent what it just did and what to do instead.
    expect(
      unlisted,
      unlisted.length === 0
        ? ""
        : `New cross-feature imports that bypass a contract:\n${unlisted
            .map((e) => `  ${e}`)
            .join("\n")}\n\nImport the target feature's contract.ts instead, or publish what you need on it. `
          + `Do NOT add an entry to tests/boundaries/baseline.ts — that list only shrinks.`,
    ).toEqual([]);
  });

  it("is not stale: every entry still describes a real violation", () => {
    const fixed = BASELINE.filter((edge) => !illegal.includes(edge));
    expect(
      fixed,
      fixed.length === 0
        ? ""
        : `These baseline entries no longer match the tree — the import is gone or now goes through a contract:\n${fixed
            .map((e) => `  ${e}`)
            .join("\n")}\n\nDelete them from tests/boundaries/baseline.ts. That is the point of the list.`,
    ).toEqual([]);
  });

  it("only ever shrinks from the 33 entries it landed with", () => {
    // Not redundant with the two tests above. Those prove the baseline and
    // the tree agree with each other; this one pins the direction of travel,
    // so a change that grows the list fails here even if someone updated the
    // tree and the baseline together in one commit.
    expect(BASELINE.length).toBeLessThanOrEqual(33);
    expect(new Set(BASELINE).size, "the baseline has a duplicate entry").toBe(BASELINE.length);
  });
});

// --- rule 2: platform calls nobody ---------------------------------------

describe("the platform rule", () => {
  it("refuses a platform file importing a feature, naming both sides", () => {
    const { features, platform } = scratchServerTree();
    writeFeatureFile(features, "alpha", "internal.ts", `export const x = 1;\n`);
    writePlatformFile(platform, "das/das.ts", `import { x } from "../../features/alpha/internal.ts";\n`);

    const edges = platformEdges({ featuresDir: features, platformDir: platform });

    expect(edges).toHaveLength(1);
    expect(edges[0]!.from).toContain("platform/das/das.ts");
    expect(edges[0]!.to).toContain("features/alpha/internal.ts");
    expect(edges[0]!.toFeature).toBe("alpha");
  });

  it("allows a platform file importing another platform module", () => {
    const { features, platform } = scratchServerTree();
    writePlatformFile(platform, "das/das.ts", `import { x } from "../identity/token.ts";\n`);
    writePlatformFile(platform, "identity/token.ts", `export const x = 1;\n`);

    expect(platformEdges({ featuresDir: features, platformDir: platform })).toEqual([]);
  });

  it("holds in the real tree: no platform file imports a feature", () => {
    const edges = platformEdges();
    expect(
      edges,
      edges.length === 0
        ? ""
        : `Platform may be called by everyone and may call nobody. These break that:\n${edges
            .map((e) => `  ${edgeKey(e)}`)
            .join("\n")}`,
    ).toEqual([]);
  });

  // --- added 2026-10-13, 033's dated section, driven by 034 ------------------
  //
  // The exemption was written loosely enough to read as "platform has no
  // private files", and platform/README.md said so outright. That is wrong
  // for the DAS: importing `das/das.ts` hands the caller the raw pool and
  // makes a grant advisory. Platform needs no permission to be depended on;
  // its internals are still private.

  it("refuses a file outside a platform module importing that module's internals", () => {
    const { features, platform } = scratchServerTree();
    writePlatformFile(platform, "das/contract.ts", `export const x = 1;\n`);
    writePlatformFile(platform, "das/das.ts", `export const pool = {};\n`);
    writeFeatureFile(features, "alpha", "uses.ts", `import { pool } from "../../platform/das/das.ts";\n`);

    const edges = platformInternalEdges({ featuresDir: features, platformDir: platform });

    expect(edges).toHaveLength(1);
    expect(edges[0]!.from).toContain("alpha/uses.ts");
    expect(edges[0]!.to).toContain("das/das.ts");
  });

  it("allows a feature importing a platform module's contract", () => {
    const { features, platform } = scratchServerTree();
    writePlatformFile(platform, "das/contract.ts", `export const x = 1;\n`);
    writeFeatureFile(features, "alpha", "uses.ts", `import { x } from "../../platform/das/contract.ts";\n`);

    expect(platformInternalEdges({ featuresDir: features, platformDir: platform })).toEqual([]);
  });

  it("allows a platform module importing its own internals", () => {
    const { features, platform } = scratchServerTree();
    writePlatformFile(platform, "das/contract.ts", `export const x = 1;\n`);
    writePlatformFile(platform, "das/das.ts", `import { x } from "./contract.ts";\nimport "./grant.ts";\n`);
    writePlatformFile(platform, "das/grant.ts", `export const y = 2;\n`);

    expect(platformInternalEdges({ featuresDir: features, platformDir: platform })).toEqual([]);
  });

  it("does not police a platform module that publishes no contract yet", () => {
    const { features, platform } = scratchServerTree();
    writePlatformFile(platform, "events/bus.ts", `export const x = 1;\n`);
    writeFeatureFile(features, "alpha", "uses.ts", `import { x } from "../../platform/events/bus.ts";\n`);

    // Several modules arrive before their contract does; refusing an import
    // of a module that has published nothing would block the retrofit at the
    // one moment it needs to move incrementally.
    expect(platformInternalEdges({ featuresDir: features, platformDir: platform })).toEqual([]);
  });

  it("holds in the real tree: nothing reaches into a platform module's internals", () => {
    const edges = platformInternalEdges();
    expect(
      edges,
      edges.length === 0
        ? ""
        : `A platform module's internals are private; import its contract.ts:\n${edges
            .map((e) => `  ${edgeKey(e)}`)
            .join("\n")}`,
    ).toEqual([]);
  });

  it("records that `mcp` is NOT a platform violation yet, because it still lives under features/", () => {
    // 033's ticket first claimed this rule "fails today exactly once, on
    // mcp/protocol.ts". It does not, and the distinction matters: mcp is
    // still `features/mcp/`, so its import of orchestrator is an ordinary
    // baselined cross-feature edge. It becomes a PLATFORM violation only
    // once 039 moves identity and mcp to platform/, which is exactly when
    // the test above starts doing work.
    const mcpEdges = BASELINE.filter((e) => e.includes("/features/mcp/"));
    expect(mcpEdges.length).toBeGreaterThan(0);
    expect(platformEdges()).toEqual([]);
  });
});

// --- rule 3: what may cross ----------------------------------------------

/** Exported signatures in a contract that name a non-serialisable type. */
function nonSerialisableSignatures(file: string): string[] {
  const source = stripComments(readFileSync(file, "utf8"));
  const found: string[] = [];
  for (const type of NON_SERIALISABLE_TYPES) {
    if (new RegExp(`\\b${type}\\b`).test(source)) found.push(type);
  }
  return found;
}

describe("the crossings list", () => {
  it("has exactly four entries, each citing its ticket", () => {
    expect(CROSSINGS).toHaveLength(4);
    for (const crossing of CROSSINGS) {
      expect(crossing.ticket, `${crossing.site} needs an owning ticket`).toMatch(/^\d{3}$/);
      expect(crossing.because.length, `${crossing.site} must say what breaks`).toBeGreaterThan(40);
    }
  });

  it("names both control crossings — the pair that blocks 040", () => {
    const fromControl = CROSSINGS.filter((c) => c.from === "control");
    expect(fromControl).toHaveLength(2);
    for (const crossing of fromControl) {
      expect(crossing.to).toContain("tasks");
      expect(crossing.to).toContain("locks");
      expect(crossing.ticket).toBe("028");
    }
  });

  it("refuses a contract whose surface carries a non-serialisable type", () => {
    const features = scratch();
    writeFeatureFile(
      features,
      "alpha",
      "contract.ts",
      `import type { PoolClient } from "pg";\nexport function doIt(client: PoolClient): void {}\n`,
    );

    const [contract] = contractFiles({ featuresDir: features });
    expect(contract).toBeDefined();
    expect(nonSerialisableSignatures(contract!)).toContain("PoolClient");
  });

  it("passes a contract whose surface is serialisable", () => {
    const features = scratch();
    writeFeatureFile(
      features,
      "alpha",
      "contract.ts",
      `export interface Thing { readonly id: string }\nexport function get(id: string): Thing { return { id }; }\n`,
    );

    const [contract] = contractFiles({ featuresDir: features });
    expect(nonSerialisableSignatures(contract!)).toEqual([]);
  });

  it("holds in the real tree: every contract's surface is serialisable, or its crossing is listed", () => {
    const offenders = contractFiles()
      .map((file) => ({ file, types: nonSerialisableSignatures(file) }))
      .filter(({ types }) => types.length > 0)
      .filter(({ file }) => !CROSSINGS.some((c) => file.includes(c.from)));

    expect(
      offenders.map(({ file, types }) => `${file}: ${types.join(", ")}`),
      "A contract may only carry a non-serialisable type if tests/boundaries/crossings.ts says so, with a ticket.",
    ).toEqual([]);
  });
});

// --- the scanner itself ---------------------------------------------------

describe("the scanner", () => {
  // These exist because the scanner is the thing every rule above trusts,
  // and one of its behaviours is load-bearing and non-obvious.
  it("does not invent an import from a comment that quotes a path", () => {
    // Real hazard, not hypothetical: claim.ts and app.ts both contain the
    // words `from "..."` inside explanatory comments. A scanner matching
    // those would fill the baseline with phantoms nobody could delete.
    const source = [
      `// This module is imported from "../../core/db/pool.ts" historically.`,
      `/* see also: import { x } from "../beta/internal.ts" */`,
      `import { real } from "./real.ts";`,
    ].join("\n");

    expect(extractSpecifiers(source)).toEqual(["./real.ts"]);
  });

  it("keeps string literals that look like comments", () => {
    expect(stripComments(`const s = "a // b";`)).toBe(`const s = "a // b";`);
  });

  it("finds type-only, side-effect, re-export and dynamic imports", () => {
    const source = [
      `import type { A } from "./a.ts";`,
      `import "./side-effect.ts";`,
      `export { B } from "./b.ts";`,
      `const m = await import("./dynamic.ts");`,
    ].join("\n");

    const specs = extractSpecifiers(source);
    expect(specs).toContain("./a.ts");
    expect(specs).toContain("./side-effect.ts");
    expect(specs).toContain("./b.ts");
    expect(specs).toContain("./dynamic.ts");
  });
});
