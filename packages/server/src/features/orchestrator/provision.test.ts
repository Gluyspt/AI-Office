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
  agentLaunchSpec,
  assertAbsolutePosixPath,
  checkRoleDefinition,
  launchEnvironmentNames,
  assertPermissionModeAllowed,
  assertRoleName,
  defaultRepoRoot,
  mergeOfficeSettings,
  officeConfigPaths,
  readHookTemplate,
  resolveUnderConfigDir,
  serializeOfficeSettings,
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

// --- Determinism, and what makes a re-run safe ----------------------------------
//
// Criterion: "Re-running is idempotent: byte-identical output, and any fragment
// already present is not duplicated." Both halves fail silently. A file whose
// bytes drift between runs makes every re-provision look like a change nobody
// made; a duplicated hook entry makes the agent POST every event twice, which
// looks like ingest double-counting rather than a merge bug.

describe("re-provisioning is byte-identical", () => {
  it("renders the same bytes twice — nothing in the file is a clock or a map order", async () => {
    const first = serializeOfficeSettings(await renderedSettings());
    const second = serializeOfficeSettings(await renderedSettings());
    expect(second).toBe(first);
  });

  it("drops a fragment entry the base template already registers", async () => {
    const template = await readHookTemplate(defaultRepoRoot());
    const base = substituteDeep(template.base, VALUES, "base.settings.json") as {
      hooks: Record<string, unknown[]>;
    };
    const baseStop = base.hooks.Stop ?? [];
    const alreadyThere = structuredClone(baseStop[0]);
    const merged = mergeOfficeSettings({
      base,
      fragments: [{ name: "zz-duplicate.json", json: { hooks: { Stop: [alreadyThere] } } }],
    });
    expect(merged.hooks.Stop).toHaveLength(baseStop.length);
  });

  it("sorts permissions.allow, so the order fragments contributed rules in cannot change the bytes", async () => {
    const template = await readHookTemplate(defaultRepoRoot());
    const base = substituteDeep(template.base, VALUES, "base.settings.json");
    const render = (names: readonly string[]) =>
      serializeOfficeSettings(
        mergeOfficeSettings({
          base,
          fragments: names.map((name) => ({
            name,
            json: { permissions: { allow: [`Bash(${name})`] } },
          })),
        }),
      );
    expect(render(["a.json", "b.json"])).toBe(render(["b.json", "a.json"]));
  });
});

// --- Fragments concatenate ------------------------------------------------------

describe("fragments merge rather than replace", () => {
  const httpGroup = (path: string) => ({
    hooks: [{ type: "http", url: `https://127.0.0.1:4000${path}`, timeout: 2 }],
  });

  it("keeps BOTH fragments' entries for one event, and the base entry with them", async () => {
    // This is the convention that lets tickets 020 and 027 each add a
    // PreToolUse hook without editing base.settings.json or knowing the other
    // exists. If the merge replaced instead of concatenating, the last
    // fragment in sorted order would silently win and one ticket's hook would
    // never fire — with nothing at provisioning time saying so.
    const template = await readHookTemplate(defaultRepoRoot());
    const merged = mergeOfficeSettings({
      base: substituteDeep(template.base, VALUES, "base.settings.json"),
      fragments: [
        { name: "020-guard.json", json: { hooks: { PreToolUse: [httpGroup("/events/guard")] } } },
        { name: "027-controls.json", json: { hooks: { PreToolUse: [httpGroup("/events/controls")] } } },
      ],
    });
    const rendered = JSON.stringify(merged.hooks.PreToolUse);
    expect(rendered).toContain("/events/guard");
    expect(rendered).toContain("/events/controls");
    expect(rendered).toContain("/events/tool"); // the base template's own entry
    expect(merged.hooks.PreToolUse).toHaveLength(3);
  });

  it("lets a fragment register an event the base template does not carry at all", async () => {
    const template = await readHookTemplate(defaultRepoRoot());
    const merged = mergeOfficeSettings({
      base: substituteDeep(template.base, VALUES, "base.settings.json"),
      fragments: [{ name: "040-notify.json", json: { hooks: { Notification: [httpGroup("/events/notify")] } } }],
    });
    expect(merged.hooks.Notification).toHaveLength(1);
  });

  it("refuses a fragment that reaches beyond hooks and permissions.allow", async () => {
    // A fragment is a hook entry, not a second settings file. One that could
    // set permissionMode or env would change every agent in the office from a
    // file any later ticket may drop in.
    const template = await readHookTemplate(defaultRepoRoot());
    const base = substituteDeep(template.base, VALUES, "base.settings.json");
    for (const json of [
      { permissions: { defaultMode: "bypassPermissions" } },
      { env: { NODE_EXTRA_CA_CERTS: "/tmp/attacker.pem" } },
    ]) {
      expect(() => mergeOfficeSettings({ base, fragments: [{ name: "bad.json", json }] })).toThrow();
    }
  });
});

// --- The launch spec ------------------------------------------------------------

describe("the launch spec", () => {
  const input = {
    role: "dev-lead",
    homeDir: "/home/agent1",
    caCertPath: "/srv/office/tls/dev-cert.pem",
    eventServerOrigin: "https://127.0.0.1:4000",
    hookToken: "tok-abc",
  };

  it("puts NODE_EXTRA_CA_CERTS in the ENVIRONMENT, where it is the only place it works", () => {
    // Spike 001 §12, run A vs run B: without this variable every hook fails
    // its TLS handshake with `tlsv1 alert unknown ca` — zero events delivered,
    // and the agent otherwise works perfectly. It cannot go in the settings
    // file: it is the Node process's own trust store.
    const spec = agentLaunchSpec(input);
    expect(spec.env.NODE_EXTRA_CA_CERTS).toBe(input.caCertPath);
    expect(JSON.stringify(spec.flags)).not.toContain("NODE_EXTRA_CA_CERTS");
  });

  it("sets the permission mode explicitly rather than inheriting one", () => {
    // A bare `claude` starts in auto mode on the installed build, which
    // resolves permissions itself and raises no dialog — so the design's
    // "mark the agent blocked via PermissionRequest" never happens.
    const spec = agentLaunchSpec(input);
    const at = spec.flags.indexOf("--permission-mode");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(spec.flags[at + 1]).toBe(DEFAULT_PERMISSION_MODE);
  });

  it("names the role's own definition and the office settings file", () => {
    const spec = agentLaunchSpec(input);
    expect(spec.flags).toContain("--agent");
    expect(spec.flags).toContain("dev-lead");
    expect(spec.flags).toContain(officeConfigPaths(input.homeDir).settingsPath);
  });

  it("refuses to build a launch for a forbidden mode", () => {
    for (const permissionMode of Object.keys(FORBIDDEN_PERMISSION_MODES)) {
      expect(() => agentLaunchSpec({ ...input, permissionMode })).toThrow();
    }
  });
});


// --- Role definitions: the launch variables they may reference -------------------
//
// GLU-55 / spike 003 §3.3. These are the tests for the trap that an UNSET
// variable does not fail a desk: Claude Code loads the MCP config and sends
// the literal "${VAR}" text as the credential, identically on every affected
// desk, warning only in `claude mcp list` output. The office refuses that at
// the endpoint, but refusing it HERE is what turns "this desk cannot claim
// any task, hours later" into "provisioning said which variable".

describe("the launch environment's variable names", () => {
  it("includes the per-session token, which agentLaunchSpec does not set", () => {
    const names = launchEnvironmentNames();
    expect(names).toContain("OFFICE_SESSION_TOKEN");
    // Derived from a real spec, so a variable added to agentLaunchSpec cannot
    // leave the role-file check behind.
    expect(names).toContain("NODE_EXTRA_CA_CERTS");
    expect(names).toContain("OFFICE_EVENT_SERVER_ORIGIN");
    expect(names).toContain("OFFICE_HOOK_INGEST_TOKEN");
  });
});

describe("checkRoleDefinition", () => {
  const withFrontmatter = (body: string): string =>
    ["---", "name: dev-lead", body, "---", "", "# Dev lead", ""].join("\n");

  it("accepts the role files this repo actually ships", async () => {
    // The one assertion here that a unit test cannot fake: the shipped files
    // must pass the check that provisioning will run on them.
    const { readFile } = await import("node:fs/promises");
    const nodePath = (await import("node:path")).default;
    for (const role of AGENT_ROLES) {
      const text = await readFile(nodePath.join(defaultRepoRoot(), "agents", `${role}.md`), "utf8");
      const report = checkRoleDefinition(role, text);
      expect(report.declaresMcpServers).toBe(true);
      expect(report.variables).toContain("OFFICE_SESSION_TOKEN");
      expect(report.variables).toContain("OFFICE_EVENT_SERVER_ORIGIN");
    }
  });

  it("refuses a variable the launch environment does not set", () => {
    const text = withFrontmatter(
      [
        "mcpServers:",
        "  - office_tasks:",
        "      type: http",
        "      url: ${OFFICE_EVENT_SERVER_ORIGIN}/mcp/tasks",
        "      headers:",
        "        Authorization: Bearer ${OFFICE_SESSION_TOKN}",
      ].join("\n"),
    );
    expect(() => checkRoleDefinition("dev-lead", text)).toThrow(/OFFICE_SESSION_TOKN/);
    // And it says what the launch environment does provide, because the
    // repair is choosing one of those names.
    expect(() => checkRoleDefinition("dev-lead", text)).toThrow(/OFFICE_SESSION_TOKEN/);
  });

  it("allows the ${VAR:-default} form for an unset variable", () => {
    const text = withFrontmatter(
      ["mcpServers:", "  - probe:", "      type: http", "      url: ${SOMETHING:-https://x}"].join("\n"),
    );
    expect(() => checkRoleDefinition("dev-lead", text)).not.toThrow();
  });

  it("ignores ${...} in the body, where it is prose", () => {
    const text = [
      "---",
      "name: dev-lead",
      "---",
      "",
      "Never write ${NOT_A_REAL_VARIABLE} in your MCP config.",
      "",
    ].join("\n");
    expect(() => checkRoleDefinition("dev-lead", text)).not.toThrow();
  });

  it("refuses a file with no frontmatter at all", () => {
    expect(() => checkRoleDefinition("dev-lead", "# Dev lead\n\nprose only\n")).toThrow(
      /frontmatter/,
    );
  });

  it("refuses a plain-http MCP url", () => {
    const text = withFrontmatter(
      ["mcpServers:", "  - office_tasks:", "      type: http", "      url: http://127.0.0.1:4000/mcp/tasks"].join("\n"),
    );
    // https everywhere including loopback — this url would carry the desk's
    // session token in clear text.
    expect(() => checkRoleDefinition("dev-lead", text)).toThrow(/https/);
  });

  it("reports a role file with no mcpServers rather than throwing", () => {
    const report = checkRoleDefinition("dev-lead", withFrontmatter("permissionMode: manual"));
    expect(report.declaresMcpServers).toBe(false);
  });
});

// --- permissions.allow: the two rules that approve nothing ----------------------

describe("the MCP allowlist", () => {
  const base = (allow: readonly string[]): Record<string, unknown> => ({
    permissions: { defaultMode: "manual", allow },
    hooks: {},
  });

  it("carries the office's own servers through the merge", () => {
    const settings = mergeOfficeSettings(
      { base: base(["mcp__office_tasks__*", "mcp__office_session__*"]), fragments: [] },
    );
    expect(settings.permissions.allow).toEqual([
      "mcp__office_session__*",
      "mcp__office_tasks__*",
    ]);
  });

  it("refuses mcp__* , which is skipped at load and approves nothing", () => {
    // The expensive direction: it LOOKS permissive, so the symptom is every
    // tool prompting and someone debugging the MCP server.
    expect(() => mergeOfficeSettings({ base: base(["mcp__*"]), fragments: [] })).toThrow(
      /globs the SERVER segment/,
    );
  });

  it("refuses a mcp__ rule with parentheses, which is dropped entirely", () => {
    expect(() =>
      mergeOfficeSettings(
        { base: base(["mcp__office_tasks__claim_task(task_id:*)"]), fragments: [] },
      ),
    ).toThrow(/parentheses/);
  });

  it("leaves non-MCP rules alone, where parentheses are the grammar", () => {
    const settings = mergeOfficeSettings(
      { base: base(["Bash(git push:*)", "Read(//srv/office/**)"]), fragments: [] },
    );
    expect(settings.permissions.allow).toContain("Bash(git push:*)");
  });

  it("checks a fragment's rules too, not just the template's", () => {
    expect(() =>
      mergeOfficeSettings(
        {
          base: base([]),
          fragments: [{ name: "x.json", json: { permissions: { allow: ["mcp__*"] } } }],
        },
      ),
    ).toThrow(/globs the SERVER segment/);
  });
});
