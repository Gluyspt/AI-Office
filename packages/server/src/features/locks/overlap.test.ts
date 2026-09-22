// The overlap rule as a table, which is the only way it is reviewable.
//
// The asymmetry under test: a false conflict serialises one task, a false
// clearance causes a git conflict. So every case that cannot be *proved*
// disjoint must come back as a conflict, and must say it was the
// conservative branch rather than a demonstrated collision.
import { describe, expect, it } from "vitest";
import {
  findScopeOverlap,
  hasGlob,
  InvalidPatternError,
  literalPrefix,
  normalisePattern,
  normaliseScope,
  patternsOverlap,
} from "./overlap.ts";

describe("normalisePattern", () => {
  const same: ReadonlyArray<readonly [string, string]> = [
    ["src/a.ts", "src/a.ts"],
    ["./src/a.ts", "src/a.ts"],
    ["src//a.ts", "src/a.ts"],
    ["src\\a.ts", "src/a.ts"],
    ["./src/./a.ts", "src/a.ts"],
    ["src/b/../a.ts", "src/a.ts"],
    ["  src/a.ts  ", "src/a.ts"],
    ["src/", "src/"],
    ["./src/", "src/"],
  ];

  for (const [raw, expected] of same) {
    it(`normalises ${JSON.stringify(raw)} to ${JSON.stringify(expected)}`, () => {
      expect(normalisePattern(raw)).toBe(expected);
    });
  }

  it("reaches the same string for the same file written two ways", () => {
    // The whole registry rests on this: two spellings that compare unequal
    // mean two agents each 'own' one file.
    expect(normalisePattern("./src/a.ts")).toBe(normalisePattern("src\\a.ts"));
  });

  it("rejects an absolute path rather than guessing", () => {
    expect(() => normalisePattern("/etc/passwd")).toThrow(InvalidPatternError);
  });

  it("rejects a path escaping the repository root", () => {
    expect(() => normalisePattern("../secrets.env")).toThrow(InvalidPatternError);
  });

  it("rejects an empty pattern", () => {
    expect(() => normalisePattern("   ")).toThrow(InvalidPatternError);
  });
});

describe("literalPrefix and hasGlob", () => {
  it.each([
    ["src/a.ts", false, "src/a.ts"],
    ["src/a*.ts", true, "src/a"],
    ["src/**/x.ts", true, "src/"],
    ["*.ts", true, ""],
    ["src/{a,b}.ts", true, "src/"],
    ["src/[ab].ts", true, "src/"],
  ])("%s -> glob=%s prefix=%s", (pattern, glob, prefix) => {
    expect(hasGlob(pattern)).toBe(glob);
    expect(literalPrefix(pattern)).toBe(prefix);
  });
});

describe("patternsOverlap — the table the ticket asks for", () => {
  interface Case {
    readonly name: string;
    readonly a: string;
    readonly b: string;
    readonly overlaps: boolean;
    readonly certain: boolean;
  }

  const cases: readonly Case[] = [
    // --- literal versus literal, all decidable -----------------------------
    { name: "identical paths", a: "src/a.ts", b: "src/a.ts", overlaps: true, certain: true },
    {
      name: "the same file reached by two different spellings",
      a: "./src/a.ts",
      b: "src\\a.ts",
      overlaps: true,
      certain: true,
    },
    { name: "sibling files", a: "src/a.ts", b: "src/b.ts", overlaps: false, certain: true },
    {
      name: "one path inside the other's directory",
      a: "src",
      b: "src/a.ts",
      overlaps: true,
      certain: true,
    },
    {
      name: "explicit directory containing a file",
      a: "src/",
      b: "src/nested/a.ts",
      overlaps: true,
      certain: true,
    },
    {
      name: "sibling directories",
      a: "src/api/",
      b: "src/web/",
      overlaps: false,
      certain: true,
    },
    {
      name: "a directory whose name merely prefixes another",
      a: "src",
      b: "srcolder/a.ts",
      overlaps: false,
      certain: true,
    },

    // --- a glob covering a literal -----------------------------------------
    {
      name: "a glob covering a literal in the same directory",
      a: "src/*.ts",
      b: "src/a.ts",
      overlaps: true,
      certain: false,
    },
    {
      name: "a recursive glob covering a nested literal",
      a: "src/**/*.ts",
      b: "src/deep/nested/a.ts",
      overlaps: true,
      certain: false,
    },
    {
      name: "a glob whose literal prefix diverges from the literal",
      a: "src/api/*.ts",
      b: "src/web/a.ts",
      overlaps: false,
      certain: true,
    },

    // --- glob versus glob ---------------------------------------------------
    {
      name: "two overlapping globs in the same directory",
      a: "src/a*.ts",
      b: "src/ab*.ts",
      overlaps: true,
      certain: false,
    },
    {
      name: "two globs whose literal prefixes diverge",
      a: "src/api/*.ts",
      b: "src/web/*.ts",
      overlaps: false,
      certain: true,
    },
    {
      name: "a leading wildcard, which can match anywhere",
      a: "*.ts",
      b: "docs/readme.md",
      overlaps: true,
      certain: false,
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.name}: ${testCase.a} vs ${testCase.b}`, () => {
      const forward = patternsOverlap(
        normalisePattern(testCase.a),
        normalisePattern(testCase.b),
      );
      expect(forward.overlaps).toBe(testCase.overlaps);
      expect(forward.certain).toBe(testCase.certain);

      // Overlap is symmetric; a rule that is not would make the verdict
      // depend on which task happened to ask first.
      const backward = patternsOverlap(
        normalisePattern(testCase.b),
        normalisePattern(testCase.a),
      );
      expect(backward.overlaps).toBe(testCase.overlaps);
      expect(backward.certain).toBe(testCase.certain);
    });
  }

  it("says so when the verdict was conservative rather than demonstrated", () => {
    const verdict = patternsOverlap("src/a*.ts", "src/ab*.ts");
    expect(verdict.overlaps).toBe(true);
    expect(verdict.certain).toBe(false);
    expect(verdict.reason).toMatch(/cannot prove|undecidable|conservativ/i);
  });
});

describe("normaliseScope", () => {
  it("rejects a scope that declares one path twice under two spellings", () => {
    expect(() => normaliseScope(["src/a.ts", "./src/a.ts"])).toThrow(/duplicates/);
  });

  it("rejects an empty scope", () => {
    expect(() => normaliseScope([])).toThrow(InvalidPatternError);
  });

  it("returns normalised patterns", () => {
    expect(normaliseScope(["./src/a.ts", "docs\\b.md"])).toEqual(["src/a.ts", "docs/b.md"]);
  });
});

describe("findScopeOverlap", () => {
  it("finds the colliding pair across two scopes", () => {
    const found = findScopeOverlap(["src/a.ts", "src/b.ts"], ["docs/x.md", "src/b.ts"]);
    expect(found).not.toBeNull();
    expect(found!.left).toBe("src/b.ts");
    expect(found!.right).toBe("src/b.ts");
  });

  it("returns null for disjoint scopes", () => {
    expect(findScopeOverlap(["src/a.ts"], ["docs/x.md"])).toBeNull();
  });
});
