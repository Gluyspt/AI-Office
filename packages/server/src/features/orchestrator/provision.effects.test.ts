// Provisioning's effectful half: the criteria that are only worth anything if
// something real happens.
//
// Split from provision.test.ts deliberately. That file states, and keeps, the
// property that it performs no filesystem writes — which is what lets it run
// anywhere. These tests write: a temporary fragment into the repo's own
// fragment directory, and a scratch git repository in the OS temp dir. They
// are safe to run together only because the suite is configured
// `fileParallelism: false` (see vitest.config.ts) — the temporary fragment is
// visible to any test that reads the fragment directory while it exists, and
// provision.test.ts reads it.
//
// WHAT IS NOT HERE, AND WHY. Two of ticket 009's criteria cannot be checked on
// a development host at all, and are marked UNVERIFIABLE-HERE in the ticket
// rather than approximated:
//
//  - "A session started through ticket 008's API with `--agent dev-lead`
//    reaches `running`, and its SessionStart event arrives at the event
//    server." Needs a provisioned Linux account with a real Claude login.
//  - Committing *as the provisioned user*. Needs `su`, which needs root. The
//    half that is checkable here is whether the identity values git is given
//    actually satisfy git, and that is what `the git identity` does below —
//    the `su` half belongs to scripts/provision-user.sh.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  AGENT_ROLES,
  agentDefinitionTarget,
  defaultRepoRoot,
  gitIdentityFor,
  hookConfigPaths,
  inspectCertificate,
  mergeOfficeSettings,
  mergeTrustEntries,
  provisionUser,
  readHookTemplate,
  serializeOfficeSettings,
  substituteDeep,
  type PlaceholderValues,
} from "./provision.ts";

const VALUES: PlaceholderValues = {
  EVENT_SERVER_ORIGIN: "https://127.0.0.1:4000",
  HOOK_INGEST_TOKEN: "tok-secret-abc",
  CA_CERT_PATH: "/srv/office/tls/dev-cert.pem",
  REPO_ROOT: "/srv/office/orchestrator",
  USER_HOME: "/home/agent1",
  TARGET_USER: "agent1",
};

const scratchDirs: string[] = [];
function scratch(prefix: string): string {
  const dir = mkdtempSync(nodePath.join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

// --- A fragment is added by dropping in a file ----------------------------------

describe("adding a fragment needs no edit to base.settings.json", () => {
  // The criterion asks for this to be verified "with a temporary fragment in a
  // test", and the reason is the one-file-one-ticket convention: tickets 020
  // and 027 both add hook entries, and if either had to edit the template
  // their diffs would collide. Asserting it through `mergeOfficeSettings` with
  // a synthetic fragment would prove the merge works but not that the
  // *directory* is read, which is the half that breaks when someone changes a
  // glob or a filter.
  it("picks up a .json file written into config/hooks/fragments and merges its entries", async () => {
    const { fragmentsDir, baseSettingsPath } = hookConfigPaths(defaultRepoRoot());
    const before = await readHookTemplate(defaultRepoRoot());
    const baseBytes = execFileSync("git", ["hash-object", baseSettingsPath], {
      cwd: defaultRepoRoot(),
      encoding: "utf8",
    }).trim();

    const path = nodePath.join(fragmentsDir, "zzz-provision-effects-fixture.json");
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          "//": "Temporary fixture written by provision.effects.test.ts. If this file is on disk, a test crashed between writing and removing it — delete it.",
          hooks: {
            PreToolUse: [
              { hooks: [{ type: "http", url: "${EVENT_SERVER_ORIGIN}/events/fixture", timeout: 2 }] },
            ],
          },
          permissions: { allow: ["Bash(echo fixture)"] },
        },
        null,
        2,
      )}\n`,
    );

    try {
      const after = await readHookTemplate(defaultRepoRoot());
      expect(after.fragments.map((fragment) => fragment.name)).toContain(
        "zzz-provision-effects-fixture.json",
      );
      expect(after.fragments).toHaveLength(before.fragments.length + 1);

      const merged = mergeOfficeSettings({
        base: substituteDeep(after.base, VALUES, "base.settings.json"),
        fragments: after.fragments.map((fragment) => ({
          name: fragment.name,
          json: substituteDeep(fragment.json, VALUES, fragment.name),
        })),
      });
      // The fragment's placeholders were substituted like the template's, its
      // hook entry survived beside the base entry for the same event, and its
      // allow rule reached permissions.
      expect(JSON.stringify(merged.hooks.PreToolUse)).toContain(
        "https://127.0.0.1:4000/events/fixture",
      );
      expect(JSON.stringify(merged.hooks.PreToolUse)).toContain("/events/tool");
      expect(merged.permissions.allow).toContain("Bash(echo fixture)");
    } finally {
      rmSync(path, { force: true });
    }

    // And the template itself was never touched — the whole point of the
    // convention. Compared by content hash, because a mode or mtime change is
    // not what this is about.
    expect(
      execFileSync("git", ["hash-object", baseSettingsPath], {
        cwd: defaultRepoRoot(),
        encoding: "utf8",
      }).trim(),
    ).toBe(baseBytes);
    expect((await readHookTemplate(defaultRepoRoot())).fragments).toHaveLength(
      before.fragments.length,
    );
  });

  it("ignores dotfiles, so the directory's own .gitkeep is not a fragment", async () => {
    const template = await readHookTemplate(defaultRepoRoot());
    for (const fragment of template.fragments) {
      expect(fragment.name.startsWith(".")).toBe(false);
      expect(fragment.name.endsWith(".json")).toBe(true);
    }
  });
});

// --- The git identity -----------------------------------------------------------

describe("the git identity", () => {
  // Found on rtdvps 2026-10-07: a freshly provisioned agent1 could not commit
  // at all — `fatal: unable to auto-detect email address (got
  // 'agent1@rtdvps.(none)')`. Delivering work means committing, so this fails
  // *inside an agent's turn*, where a human watching the chat panel sees a
  // confused agent rather than a host-config gap.
  //
  // Reading the config back is not a test of it: --global, /etc/gitconfig and
  // a repo-local value all satisfy a file check while only some satisfy git.
  // So this makes a real commit with the real values.
  it("lets git commit — exercised, not read back", () => {
    const identity = gitIdentityFor("agent1", "ai-office.invalid");
    const repo = scratch("office-git-identity-");
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

    git("init", "--quiet");
    git("config", "user.name", identity.name);
    git("config", "user.email", identity.email);
    git("config", "commit.gpgsign", "false");
    writeFileSync(nodePath.join(repo, "delivered.txt"), "work\n");
    git("add", "delivered.txt");
    git("commit", "--quiet", "-m", "deliver by committing");

    // The commit exists AND carries the identity, which is the part a human
    // reads in `git blame` forever.
    expect(git("log", "-1", "--format=%an <%ae>").trim()).toBe(
      `${identity.name} <${identity.email}>`,
    );
  });

  it("names the office and the account, so a blame view cannot read it as a person", () => {
    const identity = gitIdentityFor("agent1", "ai-office.invalid");
    expect(identity.name).toContain("AI Office");
    expect(identity.name).toContain("agent1");
    // `.invalid` is reserved by RFC 2606 and guaranteed never to resolve, so
    // an agent's commit mail can never reach a real mailbox.
    expect(identity.email.endsWith(".invalid")).toBe(true);
  });

  it("refuses an empty account name rather than committing as nobody", () => {
    expect(() => gitIdentityFor("   ", "ai-office.invalid")).toThrow();
  });
});

// --- The certificate ------------------------------------------------------------

// A fixed, self-signed fixture with a known validity window, so these assert
// against an injected `now` and never against the machine's clock. Generated
// with `openssl req -x509 -newkey rsa:2048 -days 1 -nodes -subj
// /CN=ai-office-test-fixture`; valid 2026-10-09T18:47:26Z .. 2026-10-10T18:47:26Z.
const FIXTURE_NOT_BEFORE = new Date("2026-10-09T18:47:26Z");
const FIXTURE_NOT_AFTER = new Date("2026-10-10T18:47:26Z");
const FIXTURE_CERT = `-----BEGIN CERTIFICATE-----
MIIDIzCCAgugAwIBAgIUPtHjnfK1AQL2F+FzOnOVfANW8fEwDQYJKoZIhvcNAQEL
BQAwITEfMB0GA1UEAwwWYWktb2ZmaWNlLXRlc3QtZml4dHVyZTAeFw0yNjEwMDkx
ODQ3MjZaFw0yNjEwMTAxODQ3MjZaMCExHzAdBgNVBAMMFmFpLW9mZmljZS10ZXN0
LWZpeHR1cmUwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCru1+2yBUD
6Cdhnubp/pIzXFOZ2xCVaZLUjAF6XbPjVrkE/ADHLBlRDkpzwjwMWSOrQZz/C/db
DS2LuipB84zbSrWGu30ZDop7Rc7c16dhB8PphN1VQTdJ/tGDxyvlel+xrMskxb2W
1gmkPxpE16qeKZJvbu+9zPSUXKP9Sgf2tcEgghx4HxYPAXAPsOb+U1P2jkND7XIR
KsQ2kKFStQk4A+lnckotxXKMa2RPgU6zivWtn9T9dvBKFSRVaSDnpB3c8QtGPOC/
dw7tVd3rK+TpKjKnnkrCKXr7s/HSZXYwMHTGKFfr6xudprQQDnuePMthfu1HrQ7b
zVFLiV3Kzq6lAgMBAAGjUzBRMB0GA1UdDgQWBBQKYiKzfdO2rQdZluNinBVfxEW1
gDAfBgNVHSMEGDAWgBQKYiKzfdO2rQdZluNinBVfxEW1gDAPBgNVHRMBAf8EBTAD
AQH/MA0GCSqGSIb3DQEBCwUAA4IBAQB4Axm3ohQx/US9i+CaqdSGIAU1zDLZY7Nb
FyUcTp5ixdziPyWn38od3eUfXw1e2EhNoouG/5BddLfeYfY4NN1WwzMUJ9Qbloyq
pDYJ0e8HbbupKd0ezDh5e23pcKoLIFr6E0tK2o5Ydw+f3tfXerr/6lOI5/l+/Brn
VKFMmJQi/rK4kn4zgrVYkZSZ7KmmSSnPEHBDcrTwzD6KF+T4iYfJlEDvpkiIjeHV
vI/4V3pd2AvB002rCHstmfDpn2kdqgQYzaAMXJmlrZojLYNUGz/Y/aY24r61Vvx2
Ol8/JWWM1TeT8gbZbY8l7STg08+4gp08SvZJDQ4ujxJJXHDqfwYi
-----END CERTIFICATE-----
`;

describe("the certificate is checked at provisioning time", () => {
  const valid = new Date(FIXTURE_NOT_BEFORE.getTime() + 3_600_000);

  it("reads the expiry out of the PEM rather than trusting a filename or a note", () => {
    const status = inspectCertificate(FIXTURE_CERT, "/srv/office/tls/dev-cert.pem", valid);
    expect(status.expired).toBe(false);
    expect(status.notAfter).toBe(FIXTURE_NOT_AFTER.toISOString());
    expect(status.subject).toContain("ai-office-test-fixture");
  });

  it("floors days remaining — `0 days left` must not mean `half a day left`", () => {
    const halfADayLeft = new Date(FIXTURE_NOT_AFTER.getTime() - 43_200_000);
    expect(inspectCertificate(FIXTURE_CERT, "x", halfADayLeft).daysRemaining).toBe(0);
  });

  it("calls it expired at the instant it lapses, not a day later", () => {
    expect(inspectCertificate(FIXTURE_CERT, "x", FIXTURE_NOT_AFTER).expired).toBe(true);
    const wellAfter = new Date(FIXTURE_NOT_AFTER.getTime() + 86_400_000 * 400);
    const status = inspectCertificate(FIXTURE_CERT, "x", wellAfter);
    expect(status.expired).toBe(true);
    expect(status.daysRemaining).toBeLessThan(0);
  });

  it("refuses a file that is not a certificate, naming the file", () => {
    expect(() => inspectCertificate("not a pem", "/srv/office/tls/dev-cert.pem", valid)).toThrow(
      /dev-cert\.pem/,
    );
  });

  it("REFUSES TO PROVISION against an expired certificate, before writing anything", async () => {
    // One shared certificate means every agent in the office goes silent on
    // the same day it expires, and the failure mode is the invisible one:
    // hooks fail their TLS handshake with nothing in the orchestrator saying
    // so. The check is step 2 of provisionUser, ahead of every mkdir and
    // write, which is why this test can name a home directory that does not
    // exist on any host and still expect a clean refusal.
    //
    // "BEFORE writing anything" is asserted, not assumed. Verified by
    // mutation: disabling the guard made this test fail *and* left a
    // /home/office-provision-test-nobody/.claude behind, because the run
    // carried on to step 4. The directory check is what turns that from litter
    // on someone's disk into a second failed expectation.
    const home = "/home/office-provision-test-nobody";
    const expiredNow = new Date(FIXTURE_NOT_AFTER.getTime() + 86_400_000);
    try {
      await expect(
        provisionUser({
          user: "office-provision-test-nobody",
          homeDir: home,
          projectPaths: ["/srv/office/projects/throwaway"],
          hookToken: "tok-secret-abc",
          eventServerOrigin: "https://127.0.0.1:4000",
          caCertPath: "/srv/office/tls/dev-cert.pem",
          certPem: FIXTURE_CERT,
          allowNoLogin: true,
          now: expiredNow,
        }),
      ).rejects.toThrow(/expired/i);
      expect(existsSync(nodePath.join(home, ".claude"))).toBe(false);
    } finally {
      rmSync(nodePath.join(home, ".claude"), { recursive: true, force: true });
    }
  });
});

// --- Folder trust ---------------------------------------------------------------

describe("pre-trusting project directories", () => {
  // A fresh Linux account trusts nothing, and the folder-trust dialog gates
  // readiness while tmux reports a healthy session — one of the three
  // documented ways a desk is alive and useless. Enter does not clear it.
  it("trusts the given paths and completes onboarding, without clobbering the login", () => {
    const existing = {
      // The shape that matters: .claude.json also holds the credentials
      // reference and the account's history. Overwriting it logs the account out.
      oauthAccount: { emailAddress: "agent1@example.test" },
      projects: { "/srv/office/projects/other": { history: ["kept"] } },
    };
    const { json, changed } = mergeTrustEntries(existing, ["/srv/office/projects/throwaway"]);
    const projects = json.projects as Record<string, Record<string, unknown>>;

    expect(projects["/srv/office/projects/throwaway"]?.hasTrustDialogAccepted).toBe(true);
    expect(json.hasCompletedOnboarding).toBe(true);
    expect(json.oauthAccount).toEqual(existing.oauthAccount);
    expect(projects["/srv/office/projects/other"]?.history).toEqual(["kept"]);
    expect(changed).toContain("/srv/office/projects/throwaway");
  });

  it("changes nothing on a re-run — the idempotency the provisioner relies on", () => {
    const first = mergeTrustEntries({}, ["/srv/office/projects/throwaway"]);
    const second = mergeTrustEntries(first.json, ["/srv/office/projects/throwaway"]);
    expect(second.changed).toEqual([]);
    expect(second.json).toEqual(first.json);
  });

  it("refuses a relative project path, which would trust nothing and say it did", () => {
    // The trust key is matched literally against Claude Code's cwd, so a path
    // that is not the spawn cwd byte for byte trusts a directory that does not
    // exist and leaves the real one on the dialog.
    expect(() => mergeTrustEntries({}, ["projects/throwaway"])).toThrow();
  });
});

// --- Where the role definitions land --------------------------------------------

describe("the role definitions", () => {
  it("installs each role where `claude --agent <role>` looks for it", () => {
    for (const role of AGENT_ROLES) {
      expect(agentDefinitionTarget("/home/agent1/.claude", role)).toBe(
        `/home/agent1/.claude/agents/${role}.md`,
      );
    }
  });

  it("states the planning constraint in management-lead.md", async () => {
    // Enforcement is ticket 019; the prompt has to state it here, or the lead
    // starts workers during planning and the draft batch stops being a draft.
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(
      nodePath.join(defaultRepoRoot(), "agents", "management-lead.md"),
      "utf8",
    );
    expect(text).toMatch(/read-only/i);
    expect(text).toMatch(/may not call `start_session` for workers/i);
    expect(text).toMatch(/may read the repo/i);
  });

  it("states in dev-lead.md that it never spawns directly", async () => {
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(nodePath.join(defaultRepoRoot(), "agents", "dev-lead.md"), "utf8");
    expect(text).toMatch(/never spawn directly/i);
    expect(text).toMatch(/only through `start_session`/i);
    // Hook config and the launch environment are read once, at spawn — so a
    // rotated certificate or a re-provisioned hook needs the desk restarted.
    // The agent has to know this; it cannot pick either up from inside a turn.
    expect(text).toMatch(/read once/i);
    expect(text).toMatch(/restart/i);
  });
});

// --- The one known compromise, pinned -------------------------------------------

describe("the hook ingest token in the settings file", () => {
  // Ticket 009 asks that the provisioner never write a secret into the
  // settings file. IT DOES WRITE ONE — the hook ingest token, in each URL's
  // query string — and the criterion is therefore NOT met. The reason is
  // measured: on the installed build a hook entry's `headers` values
  // interpolate environment variables but its `url` does not, and ticket 005's
  // ingest authenticates on `?token=` alone (`hasValidToken` reads
  // `request.query.token`, nothing else). So no shape exists today in which
  // the token reaches ingest without being literal in the file.
  //
  // This test pins that, so the day ingest learns to read a header the test
  // fails and sends someone back to this decision instead of leaving a secret
  // in a file nobody is looking at any more. Changing it is a two-ticket job:
  // ingest accepts an Authorization header (005's events.ts), and these
  // entries become `headers` + `allowedEnvVars`.
  it("is still in the rendered URLs — the criterion is unmet, deliberately and visibly", async () => {
    const template = await readHookTemplate(defaultRepoRoot());
    const rendered = serializeOfficeSettings(
      mergeOfficeSettings({
        base: substituteDeep(template.base, VALUES, "base.settings.json"),
        fragments: template.fragments.map((fragment) => ({
          name: fragment.name,
          json: substituteDeep(fragment.json, VALUES, fragment.name),
        })),
      }),
    );
    expect(rendered).toContain("token=tok-secret-abc");
    // The mitigation that makes it tolerable: nothing else secret is in there,
    // and the file is written 0600 and owned by the account (provisionUser).
    expect(rendered).not.toContain("oauth");
    expect(rendered).not.toContain("credential");
  });
});
