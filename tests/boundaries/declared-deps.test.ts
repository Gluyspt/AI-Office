// A service declares what it depends on, in its own contract.
//
// Ticket 033. Two halves, and the second is the one people forget:
//
//   - every cross-service import target is DECLARED by the importer, and
//   - every declaration is actually USED.
//
// An undeclared dependency is the obvious failure. An unused one is the
// quieter and more corrosive: it is a boundary the graph still shows, so
// ticket 038's extractability verdict and `docs/service-graph.md` both go on
// reporting a coupling that no longer exists — and the first person to act on
// that reads a map of a system that is not there.
//
// WHY THE DECLARATION LIVES IN THE CONTRACT and not a central registry: a
// registry is a file every ticket edits, which is exactly what the autoload
// conventions in docs/tasks/README.md exist to avoid. One file per service,
// owned by that service's ticket.
//
// NOTHING IS DECLARED YET, because no contract exists — this ticket creates
// the rule, and the retrofit publishes the contracts. So every test here that
// could only pass against real contracts is written against a fixture
// instead, and the real-tree test asserts the honest thing: zero contracts,
// zero findings, and it starts doing work the moment the first one lands.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contractFiles, crossFeatureEdges, featureOf, stripComments } from "./scan.ts";

const scratchDirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "office-declared-deps-"));
  scratchDirs.push(dir);
  return dir;
}

function writeFeatureFile(root: string, feature: string, file: string, source: string): void {
  const full = path.join(root, feature, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, source);
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  }
});

/**
 * Reads the `dependencies` array a contract exports.
 *
 * Syntactic, matching 033's decision and the scanner's: the contract is read
 * as text rather than imported. Importing it would execute module-level code
 * — a contract that touches config or the pool at import time would make this
 * test fail for a reason that has nothing to do with boundaries.
 */
export function declaredDependencies(contractFile: string): string[] {
  const source = stripComments(readFileSync(contractFile, "utf8"));
  const match = /export\s+const\s+dependencies[^=]*=\s*\[([^\]]*)\]/.exec(source);
  if (match === null) return [];
  return [...match[1]!.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]!);
}

/** What a feature actually imports from other features. */
function actualDependencies(featuresDir: string, feature: string): string[] {
  const used = new Set<string>();
  for (const edge of crossFeatureEdges({ featuresDir })) {
    if (edge.fromFeature === feature) used.add(edge.toFeature);
  }
  return [...used].sort();
}

describe("reading a declaration", () => {
  it("finds a dependencies array", () => {
    const features = scratch();
    writeFeatureFile(
      features,
      "alpha",
      "contract.ts",
      `export const dependencies = ["beta", "gamma"] as const;\n`,
    );
    const [contract] = contractFiles({ featuresDir: features });
    expect(declaredDependencies(contract!)).toEqual(["beta", "gamma"]);
  });

  it("reads an empty declaration as no dependencies, which is different from no declaration", () => {
    const features = scratch();
    writeFeatureFile(features, "alpha", "contract.ts", `export const dependencies = [];\n`);
    const [contract] = contractFiles({ featuresDir: features });
    expect(declaredDependencies(contract!)).toEqual([]);
  });

  it("is not fooled by a dependencies array inside a comment", () => {
    const features = scratch();
    writeFeatureFile(
      features,
      "alpha",
      "contract.ts",
      `// export const dependencies = ["ghost"];\nexport const dependencies = ["beta"];\n`,
    );
    const [contract] = contractFiles({ featuresDir: features });
    expect(declaredDependencies(contract!)).toEqual(["beta"]);
  });
});

describe("undeclared dependencies", () => {
  it("refuses an import of a feature the importer never declared", () => {
    const features = scratch();
    writeFeatureFile(features, "alpha", "contract.ts", `export const dependencies = [];\n`);
    writeFeatureFile(features, "alpha", "uses.ts", `import { x } from "../beta/contract.ts";\n`);
    writeFeatureFile(features, "beta", "contract.ts", `export const x = 1;\n`);

    const declared = declaredDependencies(path.join(features, "alpha", "contract.ts"));
    const actual = actualDependencies(features, "alpha");

    expect(actual).toEqual(["beta"]);
    expect(actual.filter((dep) => !declared.includes(dep))).toEqual(["beta"]);
  });

  it("passes when the import is declared", () => {
    const features = scratch();
    writeFeatureFile(features, "alpha", "contract.ts", `export const dependencies = ["beta"];\n`);
    writeFeatureFile(features, "alpha", "uses.ts", `import { x } from "../beta/contract.ts";\n`);
    writeFeatureFile(features, "beta", "contract.ts", `export const x = 1;\n`);

    const declared = declaredDependencies(path.join(features, "alpha", "contract.ts"));
    expect(actualDependencies(features, "alpha").filter((d) => !declared.includes(d))).toEqual([]);
  });
});

describe("unused declarations", () => {
  it("refuses a declared dependency nothing imports", () => {
    // The quiet failure: 038's service graph would keep reporting a coupling
    // that no longer exists, and someone would plan around it.
    const features = scratch();
    writeFeatureFile(
      features,
      "alpha",
      "contract.ts",
      `export const dependencies = ["beta", "gamma"];\n`,
    );
    writeFeatureFile(features, "alpha", "uses.ts", `import { x } from "../beta/contract.ts";\n`);
    writeFeatureFile(features, "beta", "contract.ts", `export const x = 1;\n`);
    writeFeatureFile(features, "gamma", "contract.ts", `export const y = 2;\n`);

    const declared = declaredDependencies(path.join(features, "alpha", "contract.ts"));
    const actual = actualDependencies(features, "alpha");

    expect(declared.filter((dep) => !actual.includes(dep))).toEqual(["gamma"]);
  });
});

describe("the real tree", () => {
  it("has no contract whose declaration disagrees with its imports", () => {
    const problems: string[] = [];

    for (const contract of contractFiles()) {
      const feature = featureOf(contract);
      if (feature === null) continue;
      const declared = declaredDependencies(contract);
      const actual = actualDependencies(path.dirname(path.dirname(contract)), feature);

      for (const dep of actual) {
        if (!declared.includes(dep)) {
          problems.push(
            `${feature} imports ${dep} but does not declare it — add it to features/${feature}/contract.ts's dependencies.`,
          );
        }
      }
      for (const dep of declared) {
        if (!actual.includes(dep)) {
          problems.push(
            `${feature} declares ${dep} but imports nothing from it — remove it, or 038's service graph will keep reporting a coupling that is gone.`,
          );
        }
      }
    }

    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("finds no contracts yet, and says so rather than passing silently", () => {
    // The honest state on the day 033 lands. When this starts failing,
    // the retrofit has begun and that is the intended signal — update the
    // expectation, do not weaken the test above.
    expect(contractFiles()).toEqual([]);
  });
});
