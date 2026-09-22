// Session names are addresses, so these tests are about safety as much as
// tidiness: a name that is unstable across restarts loses a running agent,
// and a name two different desks can share sends one desk's messages to the
// other.
import { describe, expect, it } from "vitest";
import {
  SESSION_NAME_PREFIX,
  identityHash,
  isOfficeSessionName,
  isValidSessionName,
  sessionName,
  slugify,
  type SessionIdentity,
} from "./naming.ts";

const base: SessionIdentity = {
  project: "ScheDool",
  department: "dev",
  role: "dev-lead",
  owner: "gluy",
};

describe("sessionName — stability and separation", () => {
  // The two properties the ticket names, as one table. Each row states an
  // identity, and whether it must produce the same name as `base`.
  const rows: ReadonlyArray<{
    readonly what: string;
    readonly identity: SessionIdentity;
    readonly sameAsBase: boolean;
  }> = [
    { what: "identical inputs", identity: { ...base }, sameAsBase: true },
    {
      what: "identical inputs built in a different property order",
      identity: { owner: "gluy", role: "dev-lead", department: "dev", project: "ScheDool" },
      sameAsBase: true,
    },
    { what: "a different project, same role and owner", identity: { ...base, project: "PseudoFlow" }, sameAsBase: false },
    { what: "a different role", identity: { ...base, role: "dev-ic" }, sameAsBase: false },
    { what: "a different department", identity: { ...base, department: "qa" }, sameAsBase: false },
    { what: "a different owner", identity: { ...base, owner: "user2" }, sameAsBase: false },
    {
      what: "fields that concatenate to the same string but split differently",
      identity: { project: "Sche", department: "Dooldev", role: "dev-lead", owner: "gluy" },
      sameAsBase: false,
    },
    {
      what: "two projects that slugify to the same label",
      identity: { ...base, project: "sche dool" },
      sameAsBase: false,
    },
  ];

  const baseName = sessionName(base);

  for (const row of rows) {
    it(`${row.sameAsBase ? "matches" : "differs from"} the base name for ${row.what}`, () => {
      const name = sessionName(row.identity);
      if (row.sameAsBase) {
        expect(name).toBe(baseName);
      } else {
        expect(name).not.toBe(baseName);
      }
    });
  }

  it("is stable across restarts — the same inputs give the same name every call", () => {
    // Determinism is the whole contract: nothing random, nothing
    // time-dependent, nothing read from process state.
    const names = new Set(Array.from({ length: 50 }, () => sessionName(base)));
    expect(names.size).toBe(1);
  });

  it("separates the four fields pairwise — 16 distinct desks, 16 distinct names", () => {
    const names = new Set<string>();
    for (const project of ["alpha", "beta"]) {
      for (const department of ["dev", "qa"]) {
        for (const role of ["lead", "ic"]) {
          for (const owner of ["gluy", "user2"]) {
            names.add(sessionName({ project, department, role, owner }));
          }
        }
      }
    }
    expect(names.size).toBe(16);
  });
});

describe("sessionName — always a legal tmux name", () => {
  // The inputs are human-typed in a browser. Every one of these has to
  // produce a name tmux can address, not an error and not something tmux
  // parses as window/pane addressing.
  const hostile: ReadonlyArray<{ readonly what: string; readonly project: string }> = [
    { what: "a shell injection attempt", project: "; rm -rf ~" },
    { what: "tmux target punctuation", project: "a.b:c" },
    { what: "a leading and trailing hyphen", project: "---edge---" },
    { what: "CJK only", project: "你好世界" },
    { what: "an emoji", project: "ship it ✅" },
    { what: "a path", project: "/srv/office/projects/x" },
    { what: "quotes and backticks", project: "she said \"hi\" `id`" },
    { what: "a very long name", project: "x".repeat(400) },
    { what: "whitespace only", project: "   " },
    { what: "an empty string", project: "" },
  ];

  for (const row of hostile) {
    it(`produces a legal, colon-free, dot-free name for ${row.what}`, () => {
      const name = sessionName({ ...base, project: row.project });
      expect(isValidSessionName(name)).toBe(true);
      expect(name).not.toContain(":");
      expect(name).not.toContain(".");
      expect(name).not.toContain(" ");
      expect(name.startsWith(`${SESSION_NAME_PREFIX}-`)).toBe(true);
      expect(name.length).toBeLessThanOrEqual(80);
    });
  }

  it("keeps two hostile projects apart even when both slugify to nothing", () => {
    const first = sessionName({ ...base, project: "你好" });
    const second = sessionName({ ...base, project: "✅" });
    expect(first).not.toBe(second);
  });
});

describe("generations", () => {
  it("leaves generation 0 unsuffixed so the common name never changes shape", () => {
    expect(sessionName(base, 0)).toBe(sessionName(base));
  });

  it("produces a distinct, still-legal name for a second concurrent session", () => {
    const second = sessionName(base, 2);
    expect(second).toBe(`${sessionName(base)}-g2`);
    expect(isValidSessionName(second)).toBe(true);
    // The base IS a prefix of the generation name. That is safe only
    // because every tmux target is exact-matched (`=name` / `=name:`); see
    // shell-quote.test.ts, which asserts the targeting.
    expect(second.startsWith(sessionName(base))).toBe(true);
  });

  it("rejects a nonsense generation", () => {
    expect(() => sessionName(base, -1)).toThrow(RangeError);
    expect(() => sessionName(base, 1.5)).toThrow(RangeError);
  });
});

describe("slugify", () => {
  it("lowercases, hyphenates and trims", () => {
    expect(slugify("ScheDool Web App", 40)).toBe("schedool-web-app");
  });

  it("never returns an empty or hyphen-terminated slug", () => {
    expect(slugify("你好", 40)).toBe("x");
    expect(slugify("", 40)).toBe("x");
    expect(slugify("abcdefg-hijk", 8)).toBe("abcdefg");
  });
});

describe("isOfficeSessionName", () => {
  it("accepts a generated name and rejects a human's own session", () => {
    expect(isOfficeSessionName(sessionName(base))).toBe(true);
    // The guard that keeps `listSessions` from ever reporting — or a
    // caller from ever killing — someone else's tmux session on a shared
    // VPS. `office-capture`, a real hook-listener session on the dev box,
    // is exactly the kind of thing that must not be mistaken for ours.
    expect(isOfficeSessionName("office-capture")).toBe(false);
    expect(isOfficeSessionName("0")).toBe(false);
    expect(isOfficeSessionName("my-work")).toBe(false);
    expect(isOfficeSessionName("spike003-chars-43890")).toBe(false);
  });
});

describe("identityHash", () => {
  it("is 10 hex characters and changes with every field", () => {
    expect(identityHash(base)).toMatch(/^[0-9a-f]{10}$/);
    const fields: ReadonlyArray<keyof SessionIdentity> = ["project", "department", "role", "owner"];
    for (const field of fields) {
      expect(identityHash({ ...base, [field]: "changed" })).not.toBe(identityHash(base));
    }
  });
});
