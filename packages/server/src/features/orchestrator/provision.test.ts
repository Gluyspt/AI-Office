// Provisioning's pure half: placeholder substitution, the hook merge, the
// permission-mode gate and path safety.
//
// No database and no filesystem writes, so this file runs anywhere — which
// matters because the things it asserts are the ones that fail *silently* if
// they are wrong. A hook URL with an empty token is accepted by JSON and
// rejected by ingest; a permission mode that never prompts removes the
// `PermissionRequest` hook the design relies on; a fragment that replaces
// rather than appends loses another ticket's hook entirely. None of those
// announce themselves at provisioning time.
import { describe, expect, it } from "vitest";
import {
  AGENT_ROLES,
  COMMAND_ONLY_HOOK_EVENTS,
  DEFAULT_PERMISSION_MODE,
  FORBIDDEN_PERMISSION_MODES,
  PERMITTED_PERMISSION_MODES,
  PLACEHOLDER_NAMES,
  PROVISIONED_HOOK_EVENTS,
  assertAbsolutePosixPath,
  assertPermissionModeAllowed,
  assertRoleName,
  defaultRepoRoot,
  mergeOfficeSettings,
  readHookTemplate,
  resolveUnderConfigDir,
  substituteDeep,
  substitutePlaceholders,
  type PlaceholderValues,
} from "./provision.ts";

const VALUES: PlaceholderValues = {
  EVENT_SERVER_ORIGIN: "https://127.0.0.1:4000",
  HOOK_INGEST_TOKEN: "tok-abc",
  CA_CERT_PATH: "/srv/office/tls/dev-cert.pem",
  REPO_ROOT: "/srv/office/orchestrator",
  USER_HOME: "/home/agent1",
  TARGET_USER: "agent1",
};

// --- The permission-mode gate ---------------------------------------------------

describe("the permission-mode gate", () => {
  // Measured on build 2.1.283: `--permission-mode` takes
  // acceptEdits|auto|bypassPermissions|manual|dontAsk|plan. `auto` is now the
  // CLI default and resolves permissions itself, which is why a delivery
  // trial returned `no_dialog` on every attempt until the mode was forced.
  // All four refused modes share one property: nothing ever asks, so the
  // PermissionRequest hook never fires and an agent can never be shown as
  // blocked.
  for (const [mode, reason] of Object.entries(FORBIDDEN_PERMISSION_MODES)) {
    it(`refuses ${mode}, and says why`, () => {
      expect(() => assertPermissionModeAllowed(mode, "test")).toThrow();
      expect(reason.length).toBeGreaterThan(20);
    });
  }

  it("refuses auto by name — it is the CLI default, so an inherited mode is not the safe one", () => {
    expect(() => assertPermissionModeAllowed("auto", "test")).toThrow(/auto/);
  });

  for (const mode of PERMITTED_PERMISSION_MODES) {
    it(`permits ${mode}`, () => {
      expect(() => assertPermissionModeAllowed(mode, "test")).not.toThrow();
    });
  }

  it("permits and forbids disjoint sets, so neither list can quietly win", () => {
    for (const mode of PERMITTED_PERMISSION_MODES) {
      expect(Object.keys(FORBIDDEN_PERMISSION_MODES)).not.toContain(mode);
    }
  });

  it("ships `manual` — the one spelling valid as both a flag and a settings value", () => {
    expect(DEFAULT_PERMISSION_MODE).toBe("manual");
    expect(PERMITTED_PERMISSION_MODES).toContain("manual");
  });

  it("refuses an unknown mode rather than passing it through to the CLI", () => {
    expect(() => assertPermissionModeAllowed("sudo-everything", "test")).toThrow();
    expect(() => assertPermissionModeAllowed(undefined, "test")).toThrow();
    expect(() => assertPermissionModeAllowed(42, "test")).toThrow();
  });
});

// --- Placeholders ---------------------------------------------------------------

describe("placeholder substitution", () => {
  it("substitutes every documented name", () => {
    for (const name of PLACEHOLDER_NAMES) {
      expect(substitutePlaceholders(`x=\${${name}}`, VALUES, "t")).toBe(
        `x=${VALUES[name]}`,
      );
    }
  });

  it("throws on an unknown name instead of rendering it empty", () => {
    // A placeholder that rendered empty would produce a hook posting to
    // "/events/reply?token=" — accepted by JSON, rejected by ingest, and
    // then diagnosed as "hooks are not reaching ingest at all", which sends
    // the reader to the wrong layer entirely.
    expect(() => substitutePlaceholders("${NOPE}", VALUES, "t")).toThrow(/NOPE/);
  });

  it("LEAVES `$NAME` alone — a command hook is shell, and that is load-bearing", () => {
    // The SessionStart entry is a `command` hook, so "$NODE_EXTRA_CA_CERTS"
    // must reach the shell unexpanded to read the agent's own launch
    // environment at run time. Expanding it here would bake in whatever the
    // orchestrator's environment happened to hold.
    const shell = 'curl --cacert "$NODE_EXTRA_CA_CERTS" ${EVENT_SERVER_ORIGIN}/events';
    expect(substitutePlaceholders(shell, VALUES, "t")).toBe(
      'curl --cacert "$NODE_EXTRA_CA_CERTS" https://127.0.0.1:4000/events',
    );
  });

  it("walks nested structures, not just top-level strings", () => {
    const got = substituteDeep(
      { a: ["${TARGET_USER}", { b: "${USER_HOME}" }], n: 1, t: true, z: null },
      VALUES,
      "t",
    );
    expect(got).toEqual({ a: ["agent1", { b: "/home/agent1" }], n: 1, t: true, z: null });
  });
});

// --- The hook merge -------------------------------------------------------------

// SUBSTITUTE BEFORE MERGING. The merge validates that every http hook url
// starts with `https://`, and a raw template's url is `${EVENT_SERVER_ORIGIN}/…`
// — not yet a URL at all. `provisionUser` therefore renders the template and
// every fragment first and merges the result, which is the order reproduced
// here. Calling the merge on the raw template throws, and that is the
// validation working rather than a bug: a template that reached an agent with
// an unsubstituted placeholder would produce a hook posting to a literal
// `${EVENT_SERVER_ORIGIN}`, which fails its handshake and is then diagnosed as
// "hooks are not reaching ingest at all".
async function renderedSettings(options: { readonly permissionMode?: string } = {}) {
  const template = await readHookTemplate(defaultRepoRoot());
  return mergeOfficeSettings(
    {
      base: substituteDeep(template.base, VALUES, "base.settings.json"),
      fragments: template.fragments.map((fragment) => ({
        name: fragment.name,
        json: substituteDeep(fragment.json, VALUES, fragment.name),
      })),
    },
    options,
  );
}

describe("the hook merge", () => {
  it("reads the repo's own template and fragment directory", async () => {
    const template = await readHookTemplate(defaultRepoRoot());
    expect(Array.isArray(template.fragments)).toBe(true);
    // `base` is deliberately typed `unknown` — parsed JSON that has not been
    // validated yet — so this asserts through the merge, which is typed.
    const merged = await renderedSettings();
    expect(Object.keys(merged.hooks).length).toBeGreaterThan(0);
    expect(merged.permissions.defaultMode).toBe(DEFAULT_PERMISSION_MODE);
  });

  it("refuses a template whose placeholders were never substituted", async () => {
    const raw = await readHookTemplate(defaultRepoRoot());
    expect(() => mergeOfficeSettings(raw)).toThrow(/https/);
  });

  it("registers every hook event the ticket names", async () => {
    const merged = await renderedSettings();
    for (const event of PROVISIONED_HOOK_EVENTS) {
      expect(Object.keys(merged.hooks)).toContain(event);
    }
  });

  it("keeps SessionStart as a command hook — it is never delivered to an http hook", async () => {
    // Spike 001, reproduced 5×. 008's hook gate waits for SessionStart
    // specifically, so registering it as `http` would mean the gate never
    // passes and every single session fails to start.
    expect(COMMAND_ONLY_HOOK_EVENTS).toContain("SessionStart");
    const merged = await renderedSettings();
    expect(JSON.stringify(merged.hooks.SessionStart)).toContain("command");
  });

  it('never writes "type": "https" — that is the URL scheme, not the hook kind', async () => {
    // Every URL in this system is https, including loopback. But Claude
    // Code's hook kinds are `command` and `http`; there is no `https` value,
    // so only the scheme changed.
    const serialized = JSON.stringify(await renderedSettings());
    expect(serialized).not.toContain('"type":"https"');
    expect(serialized).not.toContain('"type": "https"');
  });

  it("applies the permission mode it is given, and refuses a forbidden one", async () => {
    expect((await renderedSettings({ permissionMode: "plan" })).permissions.defaultMode).toBe(
      "plan",
    );
    await expect(renderedSettings({ permissionMode: "bypassPermissions" })).rejects.toThrow();
  });
});

// --- Paths ----------------------------------------------------------------------

describe("path safety", () => {
  it("requires absolute POSIX paths", () => {
    expect(assertAbsolutePosixPath("/srv/office/tls/cert.pem", "x")).toBe(
      "/srv/office/tls/cert.pem",
    );
    expect(() => assertAbsolutePosixPath("relative/path", "x")).toThrow();
    expect(() => assertAbsolutePosixPath("", "x")).toThrow();
    // A Windows path would be absolute on the development host and meaningless
    // on the agent host, which is the only place these are used.
    expect(() => assertAbsolutePosixPath("C:\\Users\\x", "x")).toThrow();
  });

  it("refuses to resolve outside the config directory", () => {
    expect(resolveUnderConfigDir("/home/agent1/.claude", "agents/dev-lead.md")).toBe(
      "/home/agent1/.claude/agents/dev-lead.md",
    );
    for (const escape of ["../../etc/passwd", "/etc/passwd", "agents/../../../etc/passwd"]) {
      expect(() => resolveUnderConfigDir("/home/agent1/.claude", escape)).toThrow();
    }
  });

  it("refuses a role name that is not one this ticket ships", () => {
    for (const role of AGENT_ROLES) {
      expect(assertRoleName(role)).toBe(role);
    }
    // An unknown role means `claude --agent <role>` finds no definition and
    // the desk behaves like a bare agent — exactly the "alive but useless"
    // shape spike 002 catalogued three ways.
    for (const bad of ["../escape", "dev_lead", "", "DEV-LEAD"]) {
      expect(() => assertRoleName(bad)).toThrow();
    }
  });
});
