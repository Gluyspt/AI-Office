// The same boundary rules, for the web app.
//
// Ticket 041. Decided 2026-10-12 answering Q3 of the boundaries design: the
// UI gets the contract rule too, because it is the half that is mostly
// unbuilt — four step-3 tickets are still open and every later step adds
// pages (Office, Knowledge, Usage, Progress) — so it is where several agents
// will be working at once.
//
// THE WEB APP IS ALREADY COMPLIANT, and that is the finding that makes this
// ticket worth landing rather than deferring. `board` and `chat` import only
// from `lib/`, and `lib/` imports no feature: **zero cross-feature edges**.
// So the baseline here is EMPTY, and this file is purely preventive — it
// locks in a property that currently holds by luck, before there are six
// features instead of two.
//
// NO CHANGES TO scan.ts. 033 built `crossFeatureEdges({ featuresDir })` and
// `platformEdges({ featuresDir, platformDir })` with overrides so its own
// tests could point at a scratch tree; those same overrides turn out to
// express the web rule exactly, with `lib/` in the platform position. A
// convention that was added for testability paid for itself as reuse.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { crossFeatureEdges, edgeKey, platformEdges, repoRoot } from "./scan.ts";

const webFeatures = path.join(repoRoot, "packages", "web", "src", "features");
const webLib = path.join(repoRoot, "packages", "web", "src", "lib");

/**
 * Empty, and expected to stay that way.
 *
 * 033's server baseline exists because 33 violations already did; there is no
 * equivalent debt here. An entry appearing in this list is a regression, not
 * a record — so unlike the server baseline, which shrinks, this one should
 * never gain a first entry.
 */
const WEB_BASELINE: readonly string[] = [];

const scratchDirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "office-web-boundaries-"));
  scratchDirs.push(dir);
  return dir;
}

/** A scratch tree with `features/` and `lib/` as siblings, as the real one has. */
function scratchWebTree(): { features: string; lib: string } {
  const root = scratch();
  const features = path.join(root, "features");
  const lib = path.join(root, "lib");
  mkdirSync(features, { recursive: true });
  mkdirSync(lib, { recursive: true });
  return { features, lib };
}

function write(dir: string, file: string, source: string): void {
  const full = path.join(dir, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, source);
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  }
});

describe("the real web app", () => {
  it("has no cross-feature imports that bypass a contract", () => {
    const illegal = crossFeatureEdges({ featuresDir: webFeatures })
      .filter((edge) => !edge.viaContract)
      .map(edgeKey);
    const unlisted = illegal.filter((edge) => !WEB_BASELINE.includes(edge));

    expect(
      unlisted,
      unlisted.length === 0
        ? ""
        : `New cross-feature imports in packages/web:\n${unlisted.map((e) => `  ${e}`).join("\n")}\n\n`
          + `Import the target feature's contract.ts instead, or publish what you need on it. `
          + `packages/web had ZERO of these when ticket 041 landed, so this is a regression rather than debt — `
          + `do not add it to WEB_BASELINE.`,
    ).toEqual([]);
  });

  it("starts from zero, which is the whole reason the rule is cheap here", () => {
    // If this ever fails, the UI grew its first cross-feature coupling and
    // somebody should decide deliberately whether that is right, rather than
    // discovering it from a merge conflict.
    expect(crossFeatureEdges({ featuresDir: webFeatures }).filter((e) => !e.viaContract)).toEqual(
      [],
    );
  });

  it("keeps `lib/` one-way: imported by features, importing none", () => {
    // `lib/` is the UI's platform. `api.ts`, `ws.ts`, `overlays.tsx` and
    // `SystemStatus.tsx` are imported by everything and own no feature, which
    // is `platform/`'s shape exactly — and 041's open question about whether
    // lib counts as platform is answered by the dependency direction that
    // already holds, not by preference.
    const edges = platformEdges({ featuresDir: webFeatures, platformDir: webLib });
    expect(
      edges,
      edges.length === 0
        ? ""
        : `packages/web/src/lib is the UI's platform: features import it, it imports no feature.\n${edges
            .map((e) => `  ${edgeKey(e)}`)
            .join("\n")}`,
    ).toEqual([]);
  });

  it("still has the two features the ownership map says it has", () => {
    // A cheap guard on the census this file's claims rest on: if a third
    // feature appears, the "zero edges" result above is about a different
    // tree than the one that was measured.
    const edges = crossFeatureEdges({ featuresDir: webFeatures });
    expect(edges.every((e) => ["board", "chat"].includes(e.fromFeature))).toBe(true);
  });
});

describe("the rule itself", () => {
  it("refuses one web feature importing another's internals", () => {
    const { features } = scratchWebTree();
    write(features, "board/Board.tsx", `import { x } from "../chat/useAgentChat.ts";\n`);
    write(features, "chat/useAgentChat.ts", `export const x = 1;\n`);

    const illegal = crossFeatureEdges({ featuresDir: features }).filter((e) => !e.viaContract);
    expect(illegal).toHaveLength(1);
    expect(illegal[0]!.from).toContain("board/Board.tsx");
    expect(illegal[0]!.to).toContain("chat/useAgentChat.ts");
  });

  it("allows one web feature importing another's contract", () => {
    const { features } = scratchWebTree();
    write(features, "board/Board.tsx", `import { x } from "../chat/contract.ts";\n`);
    write(features, "chat/contract.ts", `export const x = 1;\n`);

    expect(crossFeatureEdges({ featuresDir: features }).filter((e) => !e.viaContract)).toEqual([]);
  });

  it("refuses a feature importing another feature's CSS", () => {
    // Styles are the quietest coupling in a UI and the easiest to leave
    // behind: nothing type-checks it, nothing fails at runtime, and the
    // cascade means the damage shows up as a visual bug in a third place.
    // The real tree imports CSS only from its own folder (`./board.css`,
    // `./task-card.css`, `./chat.css`), so this rule costs nothing today.
    const { features } = scratchWebTree();
    write(features, "board/Board.tsx", `import "../chat/chat.css";\n`);
    write(features, "chat/chat.css", `.x { color: red }\n`);

    const illegal = crossFeatureEdges({ featuresDir: features }).filter((e) => !e.viaContract);
    expect(illegal).toHaveLength(1);
    expect(illegal[0]!.to).toContain("chat/chat.css");
  });

  it("allows a feature importing its OWN css, which every one of them does", () => {
    const { features } = scratchWebTree();
    write(features, "board/Board.tsx", `import "./board.css";\n`);
    write(features, "board/board.css", `.x { color: red }\n`);

    expect(crossFeatureEdges({ featuresDir: features })).toEqual([]);
  });

  it("refuses a lib file importing a feature", () => {
    const { features, lib } = scratchWebTree();
    write(features, "board/useBoard.ts", `export const x = 1;\n`);
    write(lib, "api.ts", `import { x } from "../features/board/useBoard.ts";\n`);

    const edges = platformEdges({ featuresDir: features, platformDir: lib });
    expect(edges).toHaveLength(1);
    expect(edges[0]!.from).toContain("lib/api.ts");
    expect(edges[0]!.toFeature).toBe("board");
  });

  it("allows a feature importing lib, which is the normal direction", () => {
    const { features, lib } = scratchWebTree();
    write(lib, "api.ts", `export const fetchBoard = () => 1;\n`);
    write(features, "board/useBoard.ts", `import { fetchBoard } from "../../lib/api.ts";\n`);

    expect(platformEdges({ featuresDir: features, platformDir: lib })).toEqual([]);
    expect(crossFeatureEdges({ featuresDir: features })).toEqual([]);
  });

  it("does not treat `overlay.tsx` as a violation — the shell collects it by glob", () => {
    // `overlay.tsx` and a route file are public by convention, not by
    // contract: the shell reads them with `import.meta.glob` and the router
    // reads the routes. A rule that broke either would be reverted within a
    // day, so it is asserted rather than assumed.
    const { features } = scratchWebTree();
    write(features, "chat/overlay.tsx", `import { ChatPanel } from "./ChatPanel.tsx";\nexport default ChatPanel;\n`);
    write(features, "chat/ChatPanel.tsx", `export const ChatPanel = () => null;\n`);

    expect(crossFeatureEdges({ featuresDir: features })).toEqual([]);
  });
});
