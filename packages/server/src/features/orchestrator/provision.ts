// Provisioning: what has to be true on an agent account before a desk can
// exist. Renders the office hook config into that account's own ~/.claude,
// installs the role definitions `--agent` looks for, pre-trusts the project
// directories, and hands back the exact launch flags and environment a spawn
// must use.
//
// Ticket 009. Run it through scripts/provision-user.sh, which does the parts
// that need root (`su`, chown, and proving a commit actually works).
//
// WHAT THIS FILE IS FOR, IN ONE SENTENCE: ticket 008 refuses to mark a
// session `running` until a hook event reaches ingest, and this is what makes
// that possible. Get it wrong and every session fails to start — which is the
// correct, loud behaviour, and far better than what 008's gate exists to
// prevent: an agent launched without NODE_EXTRA_CA_CERTS works *perfectly*
// and is completely invisible to the orchestrator, because every hook fails
// its TLS handshake silently (spike 001 §12: `tlsv1 alert unknown ca`, four
// rejected handshakes, one visible line of output).
//
// Five properties this module exists to hold:
//
//  1. **The launch environment is part of provisioning, not a caller's
//     detail.** NODE_EXTRA_CA_CERTS must be in the environment the `claude`
//     process is launched with — not in the settings file, which cannot
//     affect Node's TLS trust store. `agentLaunchSpec()` is the single source
//     of truth for the flags and the environment, so there is one place to
//     get it right instead of one per caller.
//
//  2. **The permission mode is explicit.** A bare `claude` starts in `auto`
//     mode on the installed build, which resolves permissions itself and
//     raises no dialog — and the design's whole permissions model ("detect
//     the rest via the PermissionRequest hook, which marks the agent blocked
//     in the UI") assumes prompts actually happen. An inherited mode is
//     therefore not the conservative one. See PERMITTED_PERMISSION_MODES.
//
//  3. **Hook entries come from a template plus fragments**, never from code.
//     config/hooks/base.settings.json holds the design's eight entries;
//     tickets 020 and 027 add theirs by dropping a file into
//     config/hooks/fragments/. Arrays concatenate, so two fragments
//     registering for the same event both survive.
//
//  4. **Nothing is written outside the target account's own files.** Exactly
//     three destinations exist: ~/.claude/office.settings.json,
//     ~/.claude/agents/<role>.md, and ~/.claude.json (the trust store, which
//     lives beside the config directory, not inside it). Every path built
//     from a *name* — a role, a fragment — goes through
//     resolveUnderConfigDir(), and the home directory itself must be an
//     already-normalized absolute path. A provisioner running as root with a
//     traversal in either would otherwise write wherever the string pointed:
//     /etc/cron.d, another account's ~/.ssh, the sudoers file this office's
//     security rests on.
//
//  5. **The certificate's expiry is checked here, not discovered later.** One
//     shared certificate means every agent in the office goes silent on the
//     same day. Provisioning refuses an expired one and warns on a nearly
//     expired one.
//
// THINGS THIS FILE DELIBERATELY DOES NOT DO:
//
//  - **It does not set CLAUDE_CONFIG_DIR** (decided, GLU-44). One config
//    directory per Linux user: $HOME already separates logins, and roles
//    differ by `--agent`. A per-role config directory would be a *fresh* one,
//    and a fresh one triggers the onboarding and folder-trust dialogs that
//    hang a new account indefinitely.
//  - **It does not overwrite the account's own ~/.claude/settings.json.** The
//    office config is a separate file (office.settings.json) passed with
//    `--settings`, which is how spike 001 §8.3 ran it and which leaves the
//    theme, model and personal hooks the account's owner set alone.
//    `--settings` is a trusted settings source for permission modes on the
//    installed build, so `permissions.defaultMode` in it is honoured.
//  - **It does not create a login.** `/login` is a browser flow. The sequence
//    is: create the Linux account, that person runs `claude` once and logs in,
//    then provision. A missing ~/.claude.json means step two has not happened
//    and provisioning refuses, because the alternative is a desk that fails at
//    spawn time far from the cause.
//  - **It does not touch the git config.** The *values* are computed here
//    (gitIdentityFor) but written and then PROVEN by scripts/provision-user.sh,
//    which can `su` to the account and make a real commit. Reading the config
//    back is not a test of it: --global, /etc/gitconfig and a repo-local value
//    all satisfy a file check while only some satisfy git.
//
// ONE KNOWN COMPROMISE, STATED OUT LOUD. The ticket asks that the provisioner
// never write a secret into the settings file. It does write one: the hook
// ingest token, in each URL's query string. The reason is measured, not lazy —
// on the installed build a hook entry's `headers` values interpolate
// environment variables but its `url` does not, and ticket 005's ingest
// authenticates on `?token=`. So there is no shape in which the token reaches
// ingest without being literal in the file. Mitigations: the file is 0600 and
// owned by the account, the token is per-account and rotatable on its own, and
// ingest binds loopback. Note that this is not weaker than the environment for
// a same-uid attacker, who can read /proc/<pid>/environ too. If ingest ever
// accepts a header token, these entries become `headers` + `allowedEnvVars`
// and the file becomes secret-free with no change to anything else here.
import { X509Certificate } from "node:crypto";
import { chmod, chown, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { SESSION_TOKEN_ENV_VAR } from "./session-token.ts";

/** Target-side paths are always POSIX: the host is Linux, the tests are not. */
const posix = nodePath.posix;

// --- What gets provisioned ------------------------------------------------------

/** The roles this ticket ships. A role name is also its file and `--agent` name. */
export const AGENT_ROLES = ["management-lead", "dev-lead"] as const;
export type AgentRoleName = (typeof AGENT_ROLES)[number];

/** Name of the office's settings file inside the account's config directory. */
export const OFFICE_SETTINGS_FILENAME = "office.settings.json";

/**
 * The hook events the base template must register — the design's eight.
 * Asserted against the shipped template by a test, so deleting one from the
 * template is a failing test rather than an event nobody notices is missing.
 */
export const PROVISIONED_HOOK_EVENTS = [
  "Stop",
  "StopFailure",
  "PreToolUse",
  "PermissionRequest",
  "SessionStart",
  "SessionEnd",
  "PreCompact",
  "PostModelSwitch",
] as const;

/**
 * Events Claude Code never dispatches to an `http` hook. Reproduced five
 * times in spike 001 §7, and the installed build says so in as many words:
 * "Skipping HTTP hook <url> — HTTP hooks are not supported for SessionStart".
 * A fragment registering an http hook for one of these would merge cleanly
 * and then never fire, so the merge refuses it.
 */
export const COMMAND_ONLY_HOOK_EVENTS = ["SessionStart", "Setup"] as const;

/**
 * Permission modes an agent session may run in.
 *
 * The vocabulary does not map cleanly and that is not a detail. On 2.1.283
 * `--permission-mode` takes `acceptEdits | auto | bypassPermissions | manual |
 * dontAsk | plan` — `default` is NOT a flag choice, even though `default` is
 * what hook payloads report. The settings key `permissions.defaultMode` is the
 * mirror image: its canonical value IS `default`, and `manual` is accepted as
 * an alias for it. `manual` is therefore the one spelling valid in both
 * places, which is why it is what this module writes and passes.
 *
 * `plan` stays permitted because it is strictly more restrictive and is the
 * right mode for a read-only planning desk (ticket 019). It is not the default
 * here because a lead in plan mode cannot act on its own decisions.
 */
export const PERMITTED_PERMISSION_MODES = ["manual", "default", "plan"] as const;

/**
 * Modes that disqualify an agent session, with the reason attached. All four
 * resolve permissions without asking a human, which silently removes the
 * `PermissionRequest` hook the design relies on to mark an agent blocked in
 * the UI — the failure reported three times as `no_dialog` and blamed on the
 * allowlist before the cause was found.
 */
export const FORBIDDEN_PERMISSION_MODES: Readonly<Record<string, string>> = {
  bypassPermissions: "bypasses every permission check; forbidden for agent sessions outright",
  auto: "is now the CLI default and resolves permissions itself — measured as no_dialog on every trial",
  dontAsk: "never raises a prompt, so PermissionRequest never fires",
  acceptEdits: "auto-accepts file edits, hiding exactly the requests a human most needs to see",
};

/** The mode both roles ship with. See PERMITTED_PERMISSION_MODES for why. */
export const DEFAULT_PERMISSION_MODE = "manual";

// --- Errors ---------------------------------------------------------------------
//
// Typed kinds, like the tmux adapter and the session registry, so a caller can
// switch instead of matching message strings.

export type ProvisionErrorKind =
  | "invalid_request"
  /** A write would land outside the target account's config directory. */
  | "path_escape"
  /** The account has never run `claude`, so there is no config to provision into. */
  | "not_logged_in"
  | "cert_missing"
  | "cert_expired"
  | "cert_invalid"
  /** A `${...}` nobody defined. Never rendered as an empty string. */
  | "unknown_placeholder"
  | "invalid_template"
  | "invalid_fragment"
  /** The account's token is not in the set the event server accepts. */
  | "token_not_accepted"
  | "forbidden_permission_mode"
  /** A role file's `mcpServers` block refers to a launch variable nothing sets. */
  | "invalid_role_definition";

export class ProvisionError extends Error {
  readonly kind: ProvisionErrorKind;

  constructor(kind: ProvisionErrorKind, message: string) {
    super(message);
    this.name = "ProvisionError";
    this.kind = kind;
  }
}

// --- Placeholders ---------------------------------------------------------------

export interface PlaceholderValues {
  readonly EVENT_SERVER_ORIGIN: string;
  readonly HOOK_INGEST_TOKEN: string;
  readonly CA_CERT_PATH: string;
  readonly REPO_ROOT: string;
  readonly USER_HOME: string;
  readonly TARGET_USER: string;
}

export const PLACEHOLDER_NAMES = [
  "EVENT_SERVER_ORIGIN",
  "HOOK_INGEST_TOKEN",
  "CA_CERT_PATH",
  "REPO_ROOT",
  "USER_HOME",
  "TARGET_USER",
] as const satisfies readonly (keyof PlaceholderValues)[];

const PLACEHOLDER_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Substitutes `${NAME}` in one string. The `$NAME` form is left alone on
 * purpose: a `command` hook is shell, and `"$NODE_EXTRA_CA_CERTS"` in the
 * SessionStart entry must reach the shell unexpanded so it reads the agent's
 * own launch environment at run time.
 *
 * An unknown name throws. A placeholder that silently rendered empty would
 * produce a hook posting to `"/events/reply?token="` — accepted by JSON,
 * rejected by ingest, and diagnosed as "hooks are not reaching ingest at all".
 */
export function substitutePlaceholders(
  value: string,
  values: PlaceholderValues,
  where: string,
): string {
  return value.replace(PLACEHOLDER_RE, (_match, name: string) => {
    if (!(name in values)) {
      throw new ProvisionError(
        "unknown_placeholder",
        `${where}: unknown placeholder \${${name}} — known names are ${PLACEHOLDER_NAMES.join(", ")}`,
      );
    }
    return values[name as keyof PlaceholderValues];
  });
}

/** Deep-substitutes every string in a parsed JSON value. Keys are substituted too. */
export function substituteDeep(node: unknown, values: PlaceholderValues, where: string): unknown {
  if (typeof node === "string") return substitutePlaceholders(node, values, where);
  if (Array.isArray(node)) return node.map((item) => substituteDeep(item, values, where));
  if (typeof node === "object" && node !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
      out[substitutePlaceholders(key, values, where)] = substituteDeep(item, values, where);
    }
    return out;
  }
  return node;
}

// --- Reading the template and its fragments -------------------------------------

export interface LoadedFragment {
  /** Filename as it appears in config/hooks/fragments/, for error messages. */
  readonly name: string;
  readonly json: unknown;
}

export interface HookTemplate {
  readonly base: unknown;
  readonly fragments: readonly LoadedFragment[];
}

/** Repo paths. `repoRoot` is a host path, so this uses the host separator. */
export function hookConfigPaths(repoRoot: string): {
  readonly baseSettingsPath: string;
  readonly fragmentsDir: string;
} {
  return {
    baseSettingsPath: nodePath.join(repoRoot, "config", "hooks", "base.settings.json"),
    fragmentsDir: nodePath.join(repoRoot, "config", "hooks", "fragments"),
  };
}

/**
 * This repo's checkout, derived from this file's own location: five levels up
 * from packages/server/src/features/orchestrator/. Overridable, because the
 * orchestrator may run from a different path than the one being provisioned.
 */
export function defaultRepoRoot(): string {
  return nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "../../../../..");
}

export async function readHookTemplate(repoRoot: string): Promise<HookTemplate> {
  const { baseSettingsPath, fragmentsDir } = hookConfigPaths(repoRoot);

  let baseText: string;
  try {
    baseText = await readFile(baseSettingsPath, "utf8");
  } catch (error) {
    throw new ProvisionError(
      "invalid_template",
      `cannot read the hook template at ${baseSettingsPath}: ${(error as Error).message}`,
    );
  }
  const base = parseJsonOrThrow(baseText, "invalid_template", baseSettingsPath);

  // Sorted filename order, so the merge order is stable and a fragment that
  // must come before another can be named to say so. Dotfiles are skipped:
  // .gitkeep carries the convention and is not a fragment.
  let entries: string[] = [];
  try {
    entries = (await readdir(fragmentsDir)).filter(
      (name) => name.endsWith(".json") && !name.startsWith("."),
    );
  } catch {
    // A missing fragments directory is not an error — the convention is that
    // fragments are optional. It being absent means no later ticket has added
    // one yet.
    entries = [];
  }
  entries.sort();

  const fragments: LoadedFragment[] = [];
  for (const name of entries) {
    const full = nodePath.join(fragmentsDir, name);
    const text = await readFile(full, "utf8");
    fragments.push({ name, json: parseJsonOrThrow(text, "invalid_fragment", full) });
  }
  return { base, fragments };
}

function parseJsonOrThrow(text: string, kind: ProvisionErrorKind, where: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ProvisionError(kind, `${where} is not valid JSON: ${(error as Error).message}`);
  }
}

// --- Merging --------------------------------------------------------------------

export interface OfficeSettings {
  readonly $schema?: string;
  readonly "//"?: string;
  readonly permissions: { readonly defaultMode: string; readonly allow: readonly string[] };
  readonly hooks: Readonly<Record<string, readonly unknown[]>>;
}

/**
 * Keys a FRAGMENT may carry. Deliberately tiny: a fragment is a hook entry,
 * not a second settings file. Letting one set `permissions.defaultMode`, a
 * model, or an environment would mean a one-line file could change the
 * permission mode of every agent in the office, and the merge would look like
 * it worked.
 */
const FRAGMENT_ALLOWED_KEYS = new Set(["hooks", "permissions", "$schema", "//"]);

const BANNER =
  "GENERATED FILE — do not edit. Rendered by scripts/provision-user.sh from " +
  "config/hooks/base.settings.json plus config/hooks/fragments/*.json. Edits here are " +
  "overwritten on the next provisioning run, and Claude Code reads hook config ONCE at " +
  "launch — so a change here (or there) reaches a running agent only after that agent is " +
  "restarted. Rotating the certificate NODE_EXTRA_CA_CERTS points at has the same " +
  "property: restart every running agent, or they keep trusting the old one and go silent.";

function asRecord(value: unknown, kind: ProvisionErrorKind, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProvisionError(kind, `${where} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

/**
 * One hook entry's own validation. Three things, each of which has cost real
 * time somewhere in this repo's history:
 *
 *  - `type` must be `http` or `command`. There is no `https` type: that is the
 *    hook-kind keyword, and only the URL scheme changed.
 *  - `timeout` must be present. The default is 30 s and it stalls the turn —
 *    measured, with the TUI showing `running SessionStart hook · 19s` and the
 *    typed prompt queued behind it.
 *  - an `http` URL must be https. Every endpoint in this system is https,
 *    loopback included.
 */
function validateHookEntry(entry: unknown, event: string, where: string): void {
  const record = asRecord(entry, "invalid_template", `${where}: ${event} hook entry`);
  const type = record.type;
  if (type !== "http" && type !== "command") {
    throw new ProvisionError(
      "invalid_template",
      `${where}: ${event} hook entry has type ${JSON.stringify(type)} — must be "http" or "command" (there is no "https" type; only the URL scheme changed)`,
    );
  }
  if (typeof record.timeout !== "number" || !Number.isFinite(record.timeout) || record.timeout <= 0) {
    throw new ProvisionError(
      "invalid_template",
      `${where}: ${event} hook entry has no positive "timeout" — the default is 30s and it stalls the agent's turn`,
    );
  }
  if (type === "http") {
    const url = record.url;
    if (typeof url !== "string" || !url.startsWith("https://")) {
      throw new ProvisionError(
        "invalid_template",
        `${where}: ${event} http hook url must be https — got ${JSON.stringify(url)}`,
      );
    }
    if ((COMMAND_ONLY_HOOK_EVENTS as readonly string[]).includes(event)) {
      throw new ProvisionError(
        "invalid_template",
        `${where}: ${event} cannot be an http hook — Claude Code never dispatches it to one (spike 001 §7, reproduced 5x). Use a command hook that POSTs to the event server.`,
      );
    }
  } else if (typeof record.command !== "string" || record.command.trim() === "") {
    throw new ProvisionError(
      "invalid_template",
      `${where}: ${event} command hook entry has no "command"`,
    );
  }
}

function validateHookGroups(
  value: unknown,
  event: string,
  where: string,
  kind: ProvisionErrorKind,
): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new ProvisionError(kind, `${where}: hooks.${event} must be an array of hook groups`);
  }
  for (const group of value) {
    const record = asRecord(group, kind, `${where}: hooks.${event} group`);
    if (!Array.isArray(record.hooks)) {
      throw new ProvisionError(kind, `${where}: hooks.${event} group has no "hooks" array`);
    }
    for (const entry of record.hooks) validateHookEntry(entry, event, where);
  }
  return value;
}

function stringArray(value: unknown, where: string, kind: ProvisionErrorKind): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ProvisionError(kind, `${where} must be an array of strings`);
  }
  return value as readonly string[];
}

/**
 * Merges the base template with every fragment.
 *
 * Arrays CONCATENATE — base first, then each fragment in sorted filename
 * order — so two fragments registering handlers for the same event both
 * survive and both run. A group byte-identical to one already merged is
 * dropped, which is what makes re-provisioning idempotent and stops a
 * fragment that duplicates a base entry from double-posting every event.
 */
/**
 * Refuses the two `permissions.allow` rules that look permissive and approve
 * nothing. Both are documented Claude Code behaviour, both fail silently, and
 * both have the expensive symptom: every tool call prompts while the settings
 * file reads as though it does not, which sends whoever debugs it to the MCP
 * server instead of to the allowlist (spike 003 §6).
 *
 *   1. An **unanchored allow glob** — `*`, `B*`, `mcp__*` — is skipped with a
 *      warning. An allow rule's server segment must be glob-free so the rule
 *      names a specific configured server. The same pattern is perfectly
 *      valid in a *deny* rule, and that asymmetry is the whole trap.
 *   2. A `mcp__` rule containing **parentheses** is dropped entirely when the
 *      settings file loads. There is no parameter matching in MCP allow
 *      rules, so `mcp__office_tasks__claim_task(task_id:*)` is not a narrower
 *      rule than the glob — it is a discarded line, i.e. a rule that silently
 *      became no rule at all. Parameter-level restriction needs
 *      --disallowedTools.
 *
 * Only `mcp__` rules are checked. `Bash(git push:*)` and friends are a
 * different grammar where parentheses are how the rule works, and 020's
 * fragment relies on it.
 */
function assertAllowRuleUsable(rule: string, where: string): void {
  if (!rule.startsWith("mcp__")) return;
  if (rule.includes("(") || rule.includes(")")) {
    throw new ProvisionError(
      "invalid_template",
      `${where}: the rule ${JSON.stringify(rule)} contains parentheses, and a mcp__ rule with parentheses is DROPPED when the settings file loads — it would appear in the invalid-settings dialog and in \`claude doctor\`, and approve nothing. MCP allow rules have no parameter matching; restrict parameters with --disallowedTools instead.`,
    );
  }
  const server = rule.slice("mcp__".length).split("__")[0] ?? "";
  if (server === "" || server.includes("*")) {
    throw new ProvisionError(
      "invalid_template",
      `${where}: the rule ${JSON.stringify(rule)} globs the SERVER segment, so it is skipped with a warning and auto-approves nothing while looking permissive. Name the server: mcp__office_tasks__* . (The same glob is valid in a deny rule — the asymmetry is the trap.)`,
    );
  }
}

export function mergeOfficeSettings(
  template: HookTemplate,
  options: { readonly permissionMode?: string } = {},
): OfficeSettings {
  const base = asRecord(template.base, "invalid_template", "base.settings.json");

  const basePermissions = asRecord(
    base.permissions ?? {},
    "invalid_template",
    "base.settings.json: permissions",
  );
  const permissionMode = options.permissionMode ?? basePermissions.defaultMode;
  assertPermissionModeAllowed(permissionMode, "base.settings.json: permissions.defaultMode");

  const hooks: Record<string, unknown[]> = {};
  const seen = new Set<string>();
  const baseHooks = asRecord(base.hooks ?? {}, "invalid_template", "base.settings.json: hooks");
  for (const [event, groups] of Object.entries(baseHooks)) {
    const validated = validateHookGroups(groups, event, "base.settings.json", "invalid_template");
    hooks[event] = [];
    for (const group of validated) {
      const key = `${event}\u0000${canonical(group)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hooks[event].push(group);
    }
  }

  const allow = new Set<string>();
  for (const rule of stringArray(
    basePermissions.allow ?? [],
    "base.settings.json: permissions.allow",
    "invalid_template",
  )) {
    assertAllowRuleUsable(rule, "base.settings.json: permissions.allow");
    allow.add(rule);
  }

  for (const fragment of template.fragments) {
    const where = `config/hooks/fragments/${fragment.name}`;
    const record = asRecord(fragment.json, "invalid_fragment", where);
    for (const key of Object.keys(record)) {
      if (!FRAGMENT_ALLOWED_KEYS.has(key)) {
        throw new ProvisionError(
          "invalid_fragment",
          `${where}: a fragment may only carry "hooks" and "permissions.allow" — it must not set ${JSON.stringify(key)}. A fragment that could change the permission mode or the environment of every agent in the office is not a hook entry.`,
        );
      }
    }
    if (record.permissions !== undefined) {
      const permissions = asRecord(record.permissions, "invalid_fragment", `${where}: permissions`);
      for (const key of Object.keys(permissions)) {
        if (key !== "allow") {
          throw new ProvisionError(
            "invalid_fragment",
            `${where}: a fragment may only set permissions.allow, not permissions.${key}`,
          );
        }
      }
      for (const rule of stringArray(
        permissions.allow ?? [],
        `${where}: permissions.allow`,
        "invalid_fragment",
      )) {
        assertAllowRuleUsable(rule, `${where}: permissions.allow`);
        allow.add(rule);
      }
    }
    if (record.hooks === undefined) continue;
    const fragmentHooks = asRecord(record.hooks, "invalid_fragment", `${where}: hooks`);
    for (const [event, groups] of Object.entries(fragmentHooks)) {
      const validated = validateHookGroups(groups, event, where, "invalid_fragment");
      const target = (hooks[event] ??= []);
      for (const group of validated) {
        const key = `${event}\u0000${canonical(group)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        target.push(group);
      }
    }
  }

  const settings: OfficeSettings = {
    ...(typeof base.$schema === "string" ? { $schema: base.$schema } : {}),
    "//": BANNER,
    permissions: {
      defaultMode: permissionMode as string,
      // Sorted, so the rendered file is byte-identical whatever order the
      // fragments contributed rules in.
      allow: [...allow].sort(),
    },
    hooks,
  };
  return settings;
}

/** Stable key for dedup: object key order must not decide whether two entries match. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function assertPermissionModeAllowed(mode: unknown, where: string): void {
  if (typeof mode !== "string" || mode.trim() === "") {
    throw new ProvisionError(
      "forbidden_permission_mode",
      `${where} must be set explicitly — an inherited mode is NOT the conservative one: a bare \`claude\` starts in auto mode, which resolves permissions itself and raises no dialog`,
    );
  }
  const reason = FORBIDDEN_PERMISSION_MODES[mode];
  if (reason !== undefined) {
    throw new ProvisionError(
      "forbidden_permission_mode",
      `${where}: ${mode} ${reason}. Permitted: ${PERMITTED_PERMISSION_MODES.join(", ")}.`,
    );
  }
  if (!(PERMITTED_PERMISSION_MODES as readonly string[]).includes(mode)) {
    throw new ProvisionError(
      "forbidden_permission_mode",
      `${where}: ${JSON.stringify(mode)} is not a permission mode this office provisions. Permitted: ${PERMITTED_PERMISSION_MODES.join(", ")}.`,
    );
  }
}

/** Deterministic rendering: same inputs, byte-identical file, no timestamps. */
export function serializeOfficeSettings(settings: OfficeSettings): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

// --- Paths inside the account's config directory --------------------------------

export interface OfficeConfigPaths {
  readonly configDir: string;
  readonly settingsPath: string;
  readonly agentsDir: string;
  /** ~/.claude.json — the trust store, and the proof the account has logged in. */
  readonly claudeJsonPath: string;
}

const ABSOLUTE_POSIX_RE = /^\/[^\0]*$/;

export function assertAbsolutePosixPath(value: string, what: string): string {
  if (!ABSOLUTE_POSIX_RE.test(value)) {
    throw new ProvisionError(
      "invalid_request",
      `${what} must be an absolute POSIX path — got ${JSON.stringify(value)}`,
    );
  }
  const normalized = posix.normalize(value).replace(/\/+$/, "");
  if (normalized === "" || normalized === "/") {
    throw new ProvisionError("invalid_request", `${what} must not be the filesystem root`);
  }
  if (normalized !== value.replace(/\/+$/, "")) {
    throw new ProvisionError(
      "invalid_request",
      `${what} must already be normalized — got ${JSON.stringify(value)}, normalizes to ${JSON.stringify(normalized)}`,
    );
  }
  return normalized;
}

export function officeConfigPaths(homeDir: string): OfficeConfigPaths {
  const home = assertAbsolutePosixPath(homeDir, "homeDir");
  const configDir = posix.join(home, ".claude");
  return {
    configDir,
    settingsPath: posix.join(configDir, OFFICE_SETTINGS_FILENAME),
    agentsDir: posix.join(configDir, "agents"),
    claudeJsonPath: posix.join(home, ".claude.json"),
  };
}

/**
 * The only way this module builds a path it will write to.
 *
 * Refuses anything that escapes the config directory. The provisioner runs as
 * root on a real host, and a role name or fragment name carrying `../` would
 * otherwise write wherever the string pointed — /etc/cron.d, another user's
 * ~/.ssh, or the sudoers file this office's security rests on.
 */
export function resolveUnderConfigDir(configDir: string, relative: string): string {
  const base = assertAbsolutePosixPath(configDir, "configDir");
  if (relative === "" || posix.isAbsolute(relative)) {
    throw new ProvisionError(
      "path_escape",
      `refusing to write ${JSON.stringify(relative)}: provisioning writes only relative paths inside ${base}`,
    );
  }
  const resolved = posix.normalize(posix.join(base, relative));
  if (resolved !== base && !resolved.startsWith(`${base}/`)) {
    throw new ProvisionError(
      "path_escape",
      `refusing to write ${JSON.stringify(relative)}: it resolves to ${resolved}, outside ${base}`,
    );
  }
  return resolved;
}

const ROLE_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * A role name becomes a filename and an `--agent` argument. Validated rather
 * than sanitized: a name that needed sanitizing is a name somebody typed
 * wrong, and silently provisioning `devlead` when they asked for `dev/lead`
 * produces a `--agent` that finds nothing.
 */
export function assertRoleName(role: string): string {
  if (!ROLE_NAME_RE.test(role)) {
    throw new ProvisionError(
      "invalid_request",
      `role name ${JSON.stringify(role)} must match ${ROLE_NAME_RE} — it becomes a filename and an --agent argument`,
    );
  }
  return role;
}

export function agentDefinitionTarget(configDir: string, role: string): string {
  return resolveUnderConfigDir(configDir, posix.join("agents", `${assertRoleName(role)}.md`));
}

// --- The launch spec ------------------------------------------------------------

export interface AgentLaunchSpec {
  /** Appended to the `claude` argv by whatever spawns the session. */
  readonly flags: readonly string[];
  /** Merged into the pane environment. */
  readonly env: Readonly<Record<string, string>>;
}

export interface AgentLaunchInput {
  readonly role: string;
  readonly homeDir: string;
  readonly caCertPath: string;
  readonly eventServerOrigin: string;
  readonly hookToken: string;
  readonly permissionMode?: string;
}

/**
 * The single source of truth for how an agent session is launched.
 *
 * `NODE_EXTRA_CA_CERTS` is the reason this function exists. It cannot live in
 * the settings file: it is the Node process's own TLS trust store, so it has
 * to be in the environment the `claude` process is launched with. Spike 001
 * §12, run A versus run B: without it, zero events delivered and four
 * rejected handshakes; with it, everything delivered and a clean log.
 *
 * `--permission-mode` is the second reason. Nothing inherited is safe here.
 *
 * The other two variables are for `command` hooks, which inherit this
 * environment: a fragment's script can read $OFFICE_EVENT_SERVER_ORIGIN and
 * $OFFICE_HOOK_INGEST_TOKEN instead of having them rendered into its command
 * line. (The *http* entries cannot — a hook's `url` is not interpolated, only
 * its `headers` are. See this file's header.)
 *
 * THE ONE LAUNCH VARIABLE THIS DOES NOT SET, and why (GLU-55). A desk also
 * carries `OFFICE_SESSION_TOKEN`, the per-session credential its MCP servers
 * present. Spike 003 §6 proposed adding it to this function's inputs, and
 * that was not taken: this spec is built once per *role* at provisioning
 * time, before any session exists, while that token is per *session* and is
 * minted by `startSession` — the only place that knows a desk is being
 * created. Passing it through here would mean rebuilding the spec at every
 * spawn and handing provisioning a secret it has no use for. So `startSession`
 * merges that one variable at spawn and `launchEnvironmentNames()` below is
 * what keeps the two halves' spellings from drifting apart.
 */
export function agentLaunchSpec(input: AgentLaunchInput): AgentLaunchSpec {
  const { settingsPath } = officeConfigPaths(input.homeDir);
  const role = assertRoleName(input.role);
  const mode = input.permissionMode ?? DEFAULT_PERMISSION_MODE;
  assertPermissionModeAllowed(mode, `launch spec for ${role}`);
  const caCertPath = assertAbsolutePosixPath(input.caCertPath, "caCertPath");
  return {
    flags: ["--settings", settingsPath, "--agent", role, "--permission-mode", mode],
    env: {
      NODE_EXTRA_CA_CERTS: caCertPath,
      OFFICE_EVENT_SERVER_ORIGIN: input.eventServerOrigin,
      OFFICE_HOOK_INGEST_TOKEN: input.hookToken,
    },
  };
}

// --- Role definitions -----------------------------------------------------------
//
// THE §3.3 TRAP, caught here instead of at spawn time.
//
// A role file's `mcpServers:` block reaches the office's MCP endpoints by
// having Claude Code expand `${VAR}` out of the launch environment — the same
// channel that already carries NODE_EXTRA_CA_CERTS. Spike 003 §3.3 quotes the
// decisive sentence in the reference: if a referenced variable is unset and
// has no default, **the config still loads** and Claude Code "uses the
// unexpanded `${VAR}` text as-is", reporting the problem only in
// `claude mcp list` output.
//
// So a typo in a variable name does not fail the desk. It makes the desk
// present the literal string `${OFFICE_SESSION_TOKEN}` as its credential —
// the SAME string on every affected desk, which a careless server would read
// as one shared identity. The endpoints refuse it (session-auth.ts,
// kind `unexpanded`), but refusing at the door means the symptom is "this
// desk cannot claim any task", hours after provisioning, with the evidence in
// a list nobody is reading.
//
// Hence this check, which is the exact parallel of substitutePlaceholders()
// refusing an unknown `${...}` in the hook template: a variable this module
// cannot promise to set is a provisioning failure, named, before the account
// is ever used.

/**
 * The launch environment's variable names: what `agentLaunchSpec` sets, plus
 * the per-session token `startSession` merges in at spawn.
 *
 * Derived from a real spec rather than hand-listed, so adding a variable to
 * `agentLaunchSpec` cannot leave this list behind.
 */
export function launchEnvironmentNames(): readonly string[] {
  const probe = agentLaunchSpec({
    role: "probe",
    homeDir: "/home/probe",
    caCertPath: "/dev/null",
    eventServerOrigin: "https://probe.invalid",
    hookToken: "probe",
  });
  return [...Object.keys(probe.env), SESSION_TOKEN_ENV_VAR].sort();
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;
// Matches ${VAR} and ${VAR:-default}; the default form is legal even for a
// variable nothing sets, because that is what a default is for.
const LAUNCH_VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(:-[^}]*)?\}/g;

export interface RoleDefinitionReport {
  /** Launch variables the frontmatter expects to be expanded. */
  readonly variables: readonly string[];
  /** Whether the frontmatter declares any MCP servers at all. */
  readonly declaresMcpServers: boolean;
}

/**
 * Checks one role definition before it is installed.
 *
 * Only the YAML frontmatter is scanned. The body is prose the model reads,
 * where a `${...}` is an example and not an expansion — scanning it would
 * refuse a role file for documenting the very trap this function enforces.
 */
export function checkRoleDefinition(role: string, text: string): RoleDefinitionReport {
  const frontmatter = FRONTMATTER_RE.exec(text);
  if (!frontmatter) {
    throw new ProvisionError(
      "invalid_role_definition",
      `agents/${role}.md has no YAML frontmatter. \`claude --agent ${role}\` identifies a role by its frontmatter \`name\`, so a file without one installs cleanly and then does nothing.`,
    );
  }
  const block = frontmatter[1] ?? "";

  const known = launchEnvironmentNames();
  const seen = new Set<string>();
  const unknown = new Set<string>();
  for (const match of block.matchAll(LAUNCH_VAR_RE)) {
    const name = match[1] as string;
    const hasDefault = match[2] !== undefined;
    seen.add(name);
    if (!hasDefault && !known.includes(name)) unknown.add(name);
  }

  if (unknown.size > 0) {
    throw new ProvisionError(
      "invalid_role_definition",
      `agents/${role}.md refers to ${[...unknown]
        .map((name) => `\${${name}}`)
        .join(", ")}, which the launch environment does not set (it sets ${known.join(
        ", ",
      )}). Claude Code loads an MCP config with unset variables and sends the literal \${...} text as the value, so this would not fail the desk — it would make the desk unidentifiable, and the warning appears only in \`claude mcp list\`. Either use one of those names, or write \${NAME:-default} if a default is genuinely meant.`,
    );
  }

  // An http server reached over plain http would carry the session token in
  // clear text, and the office decided https on every endpoint including
  // loopback. Checked here for the same reason mergeOfficeSettings checks a
  // hook url: the role file is the other place a url is written by hand.
  for (const line of block.split(/\r?\n/)) {
    const url = /^\s*url:\s*(\S+)\s*$/.exec(line);
    if (!url) continue;
    const value = url[1] as string;
    if (!value.startsWith("https://") && !value.startsWith("${")) {
      throw new ProvisionError(
        "invalid_role_definition",
        `agents/${role}.md has an MCP server url ${JSON.stringify(value)}. Every office endpoint is https, including on loopback — this one would carry the desk's session token in clear text.`,
      );
    }
  }

  return {
    variables: [...seen].sort(),
    declaresMcpServers: /^\s*mcpServers:/m.test(block),
  };
}

// --- The certificate ------------------------------------------------------------

export interface CertificateStatus {
  readonly path: string;
  readonly subject: string;
  /** ISO 8601, so it compares and sorts; the PEM's own format does not. */
  readonly notAfter: string;
  readonly daysRemaining: number;
  readonly expired: boolean;
}

const MS_PER_DAY = 86_400_000;

export function inspectCertificate(pem: string, certPath: string, now: Date): CertificateStatus {
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(pem);
  } catch (error) {
    throw new ProvisionError(
      "cert_invalid",
      `${certPath} is not a certificate this office can read: ${(error as Error).message}`,
    );
  }
  const notAfter = cert.validToDate instanceof Date ? cert.validToDate : new Date(cert.validTo);
  if (Number.isNaN(notAfter.getTime())) {
    throw new ProvisionError("cert_invalid", `${certPath}: cannot parse notAfter (${cert.validTo})`);
  }
  // Floor, not round: "0 days left" must not mean "half a day left".
  const daysRemaining = Math.floor((notAfter.getTime() - now.getTime()) / MS_PER_DAY);
  return {
    path: certPath,
    subject: cert.subject,
    notAfter: notAfter.toISOString(),
    daysRemaining,
    expired: notAfter.getTime() <= now.getTime(),
  };
}

// --- Git identity ---------------------------------------------------------------

export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

/**
 * The identity an agent account commits under.
 *
 * ASSUMPTION, stated because it is permanent in `git log` and the ticket
 * leaves the form open: **one identity per Linux account, not one shared
 * office identity.** `git blame` is read forever, and with a shared identity
 * two desks' work is indistinguishable in history for good — whereas
 * per-account costs nothing but a second `git config` line. If the office
 * decides otherwise, decide it before the first commit lands, not after.
 *
 * The name says what it is. An agent's commits are attributable to an account
 * no human ever types into, so "AI Office agent (agent1)" is the whole point:
 * it must not read as a person in a blame view. The domain defaults to a
 * reserved, guaranteed-undeliverable TLD so the address can never reach a real
 * mailbox.
 */
export function gitIdentityFor(user: string, emailDomain: string): GitIdentity {
  if (user.trim() === "") {
    throw new ProvisionError("invalid_request", "git identity needs an account name");
  }
  return { name: `AI Office agent (${user})`, email: `${user}@${emailDomain}` };
}

// --- Folder trust ---------------------------------------------------------------

export interface TrustMergeResult {
  readonly json: Record<string, unknown>;
  /** Paths whose trust entry this run added or flipped. Empty on a re-run. */
  readonly changed: readonly string[];
}

/**
 * Pre-trusts the project directories in the account's own `.claude.json`.
 *
 * A newly created Linux account trusts nothing, the folder-trust dialog gates
 * readiness, and **Enter does not clear it** — an agent started in an
 * untrusted directory sat on the dialog indefinitely, alive at 80 s, while
 * tmux reported a healthy session. That is one of the three documented ways a
 * session lies about being usable, and driving the dialog from the
 * orchestrator is not a substitute: it is one more TUI string that changes
 * between builds.
 *
 * The trust key is the project path as Claude Code sees its cwd. It is matched
 * literally, so a trailing slash, a symlinked parent or a different spelling
 * of the same directory is a *different* key and trusts nothing. The
 * provisioner prints the keys it wrote for exactly that reason — compare them
 * with the `cwd` the orchestrator spawns with.
 */
export function mergeTrustEntries(
  existing: unknown,
  projectPaths: readonly string[],
): TrustMergeResult {
  const json = existing === undefined || existing === null
    ? {}
    : asRecord(existing, "invalid_request", "~/.claude.json");
  const changed: string[] = [];

  const projects = asRecord(json.projects ?? {}, "invalid_request", "~/.claude.json: projects");
  for (const raw of projectPaths) {
    const path = assertAbsolutePosixPath(raw, "project path");
    const entry = asRecord(projects[path] ?? {}, "invalid_request", `~/.claude.json: projects[${path}]`);
    if (entry.hasTrustDialogAccepted !== true) {
      entry.hasTrustDialogAccepted = true;
      changed.push(path);
    }
    projects[path] = entry;
  }
  json.projects = projects;

  // A fresh account also meets the onboarding modal, which sits in front of
  // the trust dialog and blocks just as hard. Set only when it is not already
  // true, so a re-run changes nothing.
  if (json.hasCompletedOnboarding !== true) {
    json.hasCompletedOnboarding = true;
    changed.push("hasCompletedOnboarding");
  }
  return { json, changed };
}

// --- Provisioning ---------------------------------------------------------------

export interface ProvisionRequest {
  /** Target Linux account. */
  readonly user: string;
  /** That account's home directory, as an absolute POSIX path. */
  readonly homeDir: string;
  /** Project directories to pre-trust. May be empty; a warning says so. */
  readonly projectPaths: readonly string[];
  readonly hookToken: string;
  readonly eventServerOrigin: string;
  readonly caCertPath: string;
  /** Roles to install. Defaults to every role this ticket ships. */
  readonly roles?: readonly AgentRoleName[];
  readonly repoRoot?: string;
  readonly permissionMode?: string;
  /**
   * The set the event server accepts (HOOK_INGEST_TOKENS). Checked rather
   * than assumed: if the account's token is not in it, every hook 401s, every
   * session fails its hook gate, and nothing in the failure names the
   * mismatch.
   */
  readonly acceptedTokens?: readonly string[];
  readonly minCertRemainingDays?: number;
  /** Certificate PEM. Read from caCertPath when absent. */
  readonly certPem?: string;
  readonly gitEmailDomain?: string;
  readonly now?: Date;
  /**
   * Provision an account that has never logged in. The default refuses,
   * because a missing ~/.claude.json means nobody has run `claude` as this
   * account and the desk would fail at spawn time, far from the cause. The
   * escape hatch exists for the VPS simulator and CI, where there is no login
   * to have; it warns loudly that the account cannot run a session yet.
   */
  readonly allowNoLogin?: boolean;
  readonly uid?: number;
  readonly gid?: number;
}

export interface ProvisionedFile {
  readonly path: string;
  readonly mode: number;
  readonly bytes: number;
}

export interface ProvisionResult {
  readonly user: string;
  readonly configDir: string;
  readonly settingsPath: string;
  readonly files: readonly ProvisionedFile[];
  readonly roles: readonly AgentRoleName[];
  readonly launch: Readonly<Record<string, AgentLaunchSpec>>;
  readonly certificate: CertificateStatus;
  readonly gitIdentity: GitIdentity;
  readonly trustedPaths: readonly string[];
  readonly hookEvents: readonly string[];
  readonly fragments: readonly string[];
  readonly warnings: readonly string[];
}

const SETTINGS_MODE = 0o600;
const CONFIG_DIR_MODE = 0o700;
const AGENT_FILE_MODE = 0o644;

export async function provisionUser(request: ProvisionRequest): Promise<ProvisionResult> {
  const now = request.now ?? new Date();
  const repoRoot = request.repoRoot ?? defaultRepoRoot();
  const roles = request.roles ?? AGENT_ROLES;
  const permissionMode = request.permissionMode ?? DEFAULT_PERMISSION_MODE;
  const warnings: string[] = [];

  if (request.user.trim() === "") {
    throw new ProvisionError("invalid_request", "user is required");
  }
  assertPermissionModeAllowed(permissionMode, `provisioning ${request.user}`);
  const paths = officeConfigPaths(request.homeDir);
  const caCertPath = assertAbsolutePosixPath(request.caCertPath, "caCertPath");
  if (request.hookToken.trim() === "") {
    throw new ProvisionError("invalid_request", `no hook ingest token for ${request.user}`);
  }
  if (request.acceptedTokens !== undefined && !request.acceptedTokens.includes(request.hookToken)) {
    throw new ProvisionError(
      "token_not_accepted",
      `${request.user}'s token is not in HOOK_INGEST_TOKENS, so the event server would reject every hook it sends. Add it there (or fix OFFICE_HOOK_TOKENS) and re-run — the symptom otherwise is every session failing its hook gate with nothing naming this mismatch.`,
    );
  }
  for (const role of roles) assertRoleName(role);
  if (request.projectPaths.length === 0) {
    warnings.push(
      "no project paths given, so nothing was pre-trusted. The first spawn in an untrusted directory parks on the folder-trust dialog while tmux reports a live session.",
    );
  }

  // 1. The login must already exist. Provisioning cannot create one.
  const existingClaudeJson = await readJsonIfPresent(paths.claudeJsonPath);
  if (existingClaudeJson === undefined) {
    if (request.allowNoLogin !== true) {
      throw new ProvisionError(
        "not_logged_in",
        `${paths.claudeJsonPath} does not exist, so ${request.user} has never run \`claude\`. Provisioning cannot create a login — /login is a browser flow. The sequence is: create the account, have its owner run \`claude\` once and log in, then re-run this. Pass --allow-no-login only for a host simulation where there is no login to have.`,
      );
    }
    warnings.push(
      `${request.user} has no ~/.claude.json: nobody has logged in as this account, and a session started now reaches the onboarding screen rather than the composer. Provisioned anyway because --allow-no-login was given.`,
    );
  }

  // 2. The certificate, before anything is written. An expired one means every
  //    agent in the office is silent, so provisioning against it is refused
  //    rather than warned about.
  const certPem = request.certPem ?? (await readCertificate(caCertPath));
  const certificate = inspectCertificate(certPem, caCertPath, now);
  if (certificate.expired) {
    throw new ProvisionError(
      "cert_expired",
      `${caCertPath} expired on ${certificate.notAfter}. Every agent's hooks fail the TLS handshake against an expired certificate, silently — reissue it (it is self-signed and internal, so issue it long-lived; there is no revocation story worth preserving), then re-provision and RESTART every running agent.`,
    );
  }
  const minDays = request.minCertRemainingDays ?? 0;
  if (certificate.daysRemaining < minDays) {
    warnings.push(
      `the certificate at ${caCertPath} expires in ${certificate.daysRemaining} day(s), on ${certificate.notAfter}. One shared certificate means EVERY agent in the office goes silent on the same day. Reissue it long-lived, and remember a rotation only reaches an agent that is restarted.`,
    );
  }

  // 3. Render. Placeholders are substituted per source so an error names the
  //    file that carried the bad one.
  const template = await readHookTemplate(repoRoot);
  const values: PlaceholderValues = {
    EVENT_SERVER_ORIGIN: request.eventServerOrigin,
    HOOK_INGEST_TOKEN: request.hookToken,
    CA_CERT_PATH: caCertPath,
    REPO_ROOT: repoRoot,
    USER_HOME: assertAbsolutePosixPath(request.homeDir, "homeDir"),
    TARGET_USER: request.user,
  };
  const rendered: HookTemplate = {
    base: substituteDeep(template.base, values, "config/hooks/base.settings.json"),
    fragments: template.fragments.map((fragment) => ({
      name: fragment.name,
      json: substituteDeep(fragment.json, values, `config/hooks/fragments/${fragment.name}`),
    })),
  };
  const settings = mergeOfficeSettings(rendered, { permissionMode });

  const missingEvents = PROVISIONED_HOOK_EVENTS.filter((event) => settings.hooks[event] === undefined);
  if (missingEvents.length > 0) {
    throw new ProvisionError(
      "invalid_template",
      `the rendered hook config is missing ${missingEvents.join(", ")} — the design's eight events must all be registered, and ${missingEvents.includes("SessionStart") ? "SessionStart in particular is what ticket 008's hook gate waits for" : "a missing event is an event nobody will notice is absent"}`,
    );
  }

  // 4. Write. Directory first, 0700: the settings file holds this account's
  //    ingest token.
  const files: ProvisionedFile[] = [];
  await mkdir(paths.configDir, { recursive: true, mode: CONFIG_DIR_MODE });
  await mkdir(paths.agentsDir, { recursive: true, mode: CONFIG_DIR_MODE });

  const settingsText = serializeOfficeSettings(settings);
  files.push(await writeProvisionedFile(paths.settingsPath, settingsText, SETTINGS_MODE, request));

  for (const role of roles) {
    const source = nodePath.join(repoRoot, "agents", `${role}.md`);
    let definition: string;
    try {
      definition = await readFile(source, "utf8");
    } catch (error) {
      throw new ProvisionError(
        "invalid_request",
        `no role definition at ${source}: ${(error as Error).message}. \`claude --agent ${role}\` needs this file installed in the account's own config directory.`,
      );
    }
    // Before it is installed, not after: see checkRoleDefinition's header
    // for why an unexpandable variable in here is worse than a crash.
    const report = checkRoleDefinition(role, definition);
    if (!report.declaresMcpServers) {
      // A warning, not a refusal. A role with no MCP servers is a legitimate
      // configuration (step 1's spine ran that way for weeks), but from step
      // 2 on it is far more often a role file that lost its block in an edit
      // — and the symptom is an agent that cannot claim work and does not
      // know why, since the tools simply are not there to call.
      warnings.push(
        `agents/${role}.md declares no mcpServers, so this desk will have no office tools — no claim_task, no complete_task, no start_session. Deliberate for a plain chat desk; a mistake for a lead.`,
      );
    }
    const target = agentDefinitionTarget(paths.configDir, role);
    files.push(await writeProvisionedFile(target, definition, AGENT_FILE_MODE, request));
  }

  // 5. Trust. Read-modify-write: .claude.json holds the account's credentials
  //    reference, its history and its own project settings. Clobbering it
  //    would log the account out.
  const trust = mergeTrustEntries(existingClaudeJson ?? {}, request.projectPaths);
  files.push(
    await writeProvisionedFile(
      paths.claudeJsonPath,
      `${JSON.stringify(trust.json, null, 2)}\n`,
      SETTINGS_MODE,
      request,
    ),
  );

  const launch: Record<string, AgentLaunchSpec> = {};
  for (const role of roles) {
    launch[role] = agentLaunchSpec({
      role,
      homeDir: request.homeDir,
      caCertPath,
      eventServerOrigin: request.eventServerOrigin,
      hookToken: request.hookToken,
      permissionMode,
    });
  }

  return {
    user: request.user,
    configDir: paths.configDir,
    settingsPath: paths.settingsPath,
    files,
    roles: [...roles],
    launch,
    certificate,
    gitIdentity: gitIdentityFor(request.user, request.gitEmailDomain ?? "ai-office.invalid"),
    trustedPaths: request.projectPaths.map((path) => assertAbsolutePosixPath(path, "project path")),
    hookEvents: Object.keys(settings.hooks),
    fragments: template.fragments.map((fragment) => fragment.name),
    warnings,
  };
}

async function readJsonIfPresent(path: string): Promise<unknown | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  if (text.trim() === "") return {};
  return parseJsonOrThrow(text, "invalid_request", path);
}

async function readCertificate(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new ProvisionError(
      "cert_missing",
      `cannot read the certificate at ${path}: ${(error as Error).message}. Agents are launched with NODE_EXTRA_CA_CERTS pointed at it; without it every hook fails its TLS handshake and the orchestrator sees an agent that never speaks. Generate one with \`node scripts/dev-cert.mjs\`, or let deploy/host/provision-host.sh do it.`,
    );
  }
}

/**
 * writeFile's `mode` applies only when it CREATES the file, so a re-run over
 * an existing file would silently keep the old permissions. chmod explicitly.
 */
async function writeProvisionedFile(
  path: string,
  contents: string,
  mode: number,
  request: ProvisionRequest,
): Promise<ProvisionedFile> {
  await writeFile(path, contents, { mode });
  await chmod(path, mode);
  if (request.uid !== undefined && request.gid !== undefined) {
    // The provisioner runs as root; a file it leaves owned by root in the
    // account's home is a file the account cannot rewrite and, for
    // .claude.json, cannot even log in through.
    await chown(path, request.uid, request.gid);
  }
  return { path, mode, bytes: Buffer.byteLength(contents, "utf8") };
}

// --- Reporting ------------------------------------------------------------------

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The contract between this module and scripts/provision-user.sh: shell
 * assignments the script `eval`s, rather than JSON it would have to parse in
 * POSIX sh. Quoted so a path with a space cannot become two words.
 */
export function formatShellAssignments(result: ProvisionResult): string {
  const lines = [
    `OFFICE_PROVISIONED_USER=${shellQuote(result.user)}`,
    `OFFICE_CONFIG_DIR=${shellQuote(result.configDir)}`,
    `OFFICE_SETTINGS_PATH=${shellQuote(result.settingsPath)}`,
    `OFFICE_GIT_NAME=${shellQuote(result.gitIdentity.name)}`,
    `OFFICE_GIT_EMAIL=${shellQuote(result.gitIdentity.email)}`,
    `OFFICE_CA_CERT_PATH=${shellQuote(result.certificate.path)}`,
    `OFFICE_CERT_NOT_AFTER=${shellQuote(result.certificate.notAfter)}`,
    `OFFICE_CERT_DAYS_REMAINING=${shellQuote(String(result.certificate.daysRemaining))}`,
    `OFFICE_ROLES=${shellQuote(result.roles.join(" "))}`,
    `OFFICE_WARNING_COUNT=${shellQuote(String(result.warnings.length))}`,
  ];
  for (const role of result.roles) {
    const spec = result.launch[role];
    if (spec === undefined) continue;
    const key = role.replace(/-/g, "_").toUpperCase();
    lines.push(`OFFICE_LAUNCH_FLAGS_${key}=${shellQuote(spec.flags.join(" "))}`);
  }
  const spec = result.launch[result.roles[0] ?? ""];
  if (spec !== undefined) {
    // The environment is identical for every role on one account (roles differ
    // by --agent, not by config directory), so it is emitted once.
    lines.push(
      `OFFICE_LAUNCH_ENV=${shellQuote(
        Object.entries(spec.env)
          .map(([name, value]) => `${name}=${value}`)
          .join(" "),
      )}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function formatHumanReport(result: ProvisionResult): string {
  const lines: string[] = [];
  lines.push(`== Provisioned ${result.user}`);
  for (const file of result.files) {
    lines.push(`  ok      ${file.path} (${file.bytes} bytes, mode 0${file.mode.toString(8)})`);
  }
  lines.push(`  ok      hook events: ${result.hookEvents.join(", ")}`);
  lines.push(
    `  ok      fragments merged: ${result.fragments.length === 0 ? "(none)" : result.fragments.join(", ")}`,
  );
  lines.push(
    `  ok      certificate ${result.certificate.path} valid until ${result.certificate.notAfter} (${result.certificate.daysRemaining} days)`,
  );
  lines.push(`  ok      git identity: ${result.gitIdentity.name} <${result.gitIdentity.email}>`);
  if (result.trustedPaths.length > 0) {
    lines.push(`  ok      pre-trusted: ${result.trustedPaths.join(", ")}`);
    lines.push("          (matched literally against the spawn cwd — compare them byte for byte)");
  }
  for (const role of result.roles) {
    const spec = result.launch[role];
    if (spec === undefined) continue;
    lines.push(`  ok      launch ${role}: claude --session-id <id> ${spec.flags.join(" ")}`);
  }
  const envSpec = result.launch[result.roles[0] ?? ""];
  if (envSpec !== undefined) {
    for (const [name, value] of Object.entries(envSpec.env)) {
      const shown = name === "OFFICE_HOOK_INGEST_TOKEN" ? "<redacted>" : value;
      lines.push(`  ok      launch env ${name}=${shown}`);
    }
  }
  for (const warning of result.warnings) lines.push(`  WARN    ${warning}`);
  return lines.join("\n");
}

// --- CLI ------------------------------------------------------------------------

interface CliArgs {
  readonly user: string;
  readonly homeDir?: string;
  readonly projectPaths: string[];
  readonly format: "text" | "sh";
  readonly allowNoLogin: boolean;
  readonly roles?: AgentRoleName[];
  readonly uid?: number;
  readonly gid?: number;
}

export function parseCliArgs(argv: readonly string[]): CliArgs {
  let user = "";
  let homeDir: string | undefined;
  let format: "text" | "sh" = "text";
  let allowNoLogin = false;
  let roles: AgentRoleName[] | undefined;
  let uid: number | undefined;
  let gid: number | undefined;
  const projectPaths: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new ProvisionError("invalid_request", `${arg} needs a value`);
      }
      index += 1;
      return value;
    };
    switch (arg) {
      case "--user":
        user = next();
        break;
      case "--home":
        homeDir = next();
        break;
      case "--project":
        projectPaths.push(next());
        break;
      case "--format":
        {
          const value = next();
          if (value !== "text" && value !== "sh") {
            throw new ProvisionError("invalid_request", `--format must be text or sh, got ${value}`);
          }
          format = value;
        }
        break;
      case "--roles":
        roles = next()
          .split(",")
          .map((role) => role.trim())
          .filter((role) => role !== "")
          .map((role) => {
            if (!(AGENT_ROLES as readonly string[]).includes(role)) {
              throw new ProvisionError(
                "invalid_request",
                `unknown role ${JSON.stringify(role)} — this ticket ships ${AGENT_ROLES.join(", ")}`,
              );
            }
            return role as AgentRoleName;
          });
        break;
      case "--allow-no-login":
        allowNoLogin = true;
        break;
      case "--uid":
        uid = Number.parseInt(next(), 10);
        break;
      case "--gid":
        gid = Number.parseInt(next(), 10);
        break;
      default:
        if (arg.startsWith("-")) {
          throw new ProvisionError("invalid_request", `unknown option ${arg}`);
        }
        if (user === "") user = arg;
        else projectPaths.push(arg);
    }
  }
  if (user === "") {
    throw new ProvisionError("invalid_request", "usage: provision.ts <user> [project-path...]");
  }
  return {
    user,
    ...(homeDir === undefined ? {} : { homeDir }),
    projectPaths,
    format,
    allowNoLogin,
    ...(roles === undefined ? {} : { roles }),
    ...(uid === undefined || Number.isNaN(uid) ? {} : { uid }),
    ...(gid === undefined || Number.isNaN(gid) ? {} : { gid }),
  };
}

async function main(): Promise<void> {
  // Imported lazily so the module can be unit-tested, and imported by other
  // modules, without every environment variable this needs being set.
  const { loadProvisioningConfig, loadServerConfig } = await import("../../core/config.ts");
  const args = parseCliArgs(process.argv.slice(2));
  const config = loadProvisioningConfig();
  const token = config.hookTokens[args.user];
  if (token === undefined) {
    throw new ProvisionError(
      "invalid_request",
      `OFFICE_HOOK_TOKENS has no token for ${args.user}. Generate one (openssl rand -hex 24), add it there AND to HOOK_INGEST_TOKENS, then re-run.`,
    );
  }
  const result = await provisionUser({
    user: args.user,
    homeDir: args.homeDir ?? posix.join("/home", args.user),
    projectPaths: args.projectPaths,
    hookToken: token,
    eventServerOrigin: config.eventServerOrigin,
    caCertPath: config.agentCaCertPath,
    acceptedTokens: loadServerConfig().hookIngestTokens,
    minCertRemainingDays: config.certMinRemainingDays,
    gitEmailDomain: config.gitEmailDomain,
    allowNoLogin: args.allowNoLogin,
    ...(args.roles === undefined ? {} : { roles: args.roles }),
    ...(args.uid === undefined ? {} : { uid: args.uid }),
    ...(args.gid === undefined ? {} : { gid: args.gid }),
  });
  process.stdout.write(
    args.format === "sh" ? formatShellAssignments(result) : `${formatHumanReport(result)}\n`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  nodePath.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`provision failed: ${message}\n`);
    process.exitCode = 1;
  }
}
