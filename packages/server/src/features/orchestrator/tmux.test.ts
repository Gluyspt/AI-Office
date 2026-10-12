// Adapter tests. Everything that decides whether the system is safe —
// argv construction, the `sudo -u` allowlist, the root refusal, timeouts,
// and the refusal to type into a dialog — runs here with no tmux, no sudo
// and no Linux, because those properties are decided before a process is
// spawned.
//
// Two things are exercised against a *real* spawn, using stub binaries
// written to a temp directory: that argv elements reach a child byte for
// byte (so "a message containing `; rm -rf ~` executes nothing" is a
// measured fact rather than a reading of the code), and that a hung
// command is killed rather than leaked.
//
// The live-tmux suite at the bottom is skipped unless OFFICE_TMUX_LIVE is
// set, and is the only part that needs a tmux server.
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildTmuxCommand,
  classifyPane,
  composerText,
  createTmuxAdapter,
  spawnRunner,
  type CommandOutcome,
  type CommandRequest,
  type CommandRunner,
} from "./tmux.ts";

const USER = "gluy";
const SESSION = "office-schedool-dev-dev-lead-0123456789";
const AGENT_USERS = [USER, "user2"];

// --- Test doubles -------------------------------------------------------------

interface RecordedCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  /** The tmux arguments, i.e. everything after `sudo -n -u <user> <tmux>`. */
  readonly tmuxArgs: readonly string[];
}

function ok(partial: Partial<CommandOutcome> = {}): CommandOutcome {
  return { code: 0, signal: null, stdout: "", stderr: "", timedOut: false, ...partial };
}

function makeRunner(handle: (tmuxArgs: readonly string[], call: number) => Partial<CommandOutcome> = () => ({})): {
  readonly run: CommandRunner;
  readonly calls: RecordedCall[];
  readonly subcommands: () => string[];
} {
  const calls: RecordedCall[] = [];
  const run: CommandRunner = async (request: CommandRequest) => {
    const tmuxArgs = request.args.slice(4);
    calls.push({ file: request.file, args: request.args, timeoutMs: request.timeoutMs, tmuxArgs });
    return ok(handle(tmuxArgs, calls.length - 1));
  };
  return { run, calls, subcommands: () => calls.map((call) => call.tmuxArgs[0] ?? "") };
}

/** A pane with the composer up: two U+2500 rules with a U+276F marker between. */
function composerPane(draft = ""): string {
  const rule = "─".repeat(60);
  return ["● I have finished reading the file.", "", rule, ` ❯ ${draft}`, rule, "  ? for shortcuts"].join(
    "\n",
  );
}

const TRUST_PANE = [
  "Is this a project you created or one you trust?",
  "",
  "  1. Yes, I trust this folder",
  "  2. No",
  "",
  "Enter to confirm · Esc to cancel",
].join("\n");

const MODAL_PANE = ["Try the new fullscreen renderer?", "", "Enter to confirm · Esc to cancel"].join("\n");

const PERMISSION_PANE = [
  "Bash command",
  "  touch /home/gluy/out/PERMRAN.txt",
  "",
  "Do you want to proceed?",
  "  1. Yes",
  "  2. Yes, and don't ask again",
  "  3. No",
].join("\n");

const AUTH_PANE = "Invalid API key · Please run /login";

/**
 * A clock the tests drive. `sleep` advances it instead of waiting, so a
 * 120-second readiness timeout is exercised in microseconds and the test
 * suite has no real-time dependency.
 */
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let clock = 1_000_000;
  return {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
  };
}

function adapter(
  run: CommandRunner,
  overrides: Partial<Parameters<typeof createTmuxAdapter>[0]> = {},
): ReturnType<typeof createTmuxAdapter> {
  const clock = fakeClock();
  return createTmuxAdapter({
    agentUsers: AGENT_USERS,
    run,
    // uid 1000: an unprivileged account, the normal case.
    getuid: () => 1000,
    now: clock.now,
    sleep: clock.sleep,
    ...overrides,
  });
}

// --- The invocation shape -----------------------------------------------------

describe("buildTmuxCommand", () => {
  it("is `sudo -n -u <user> <tmux> <args>` — the shape the VPS will run", () => {
    expect(
      buildTmuxCommand({
        sudoPath: "/usr/bin/sudo",
        tmuxPath: "/usr/bin/tmux",
        user: USER,
        args: ["has-session", "-t", `=${SESSION}`],
      }),
    ).toEqual({
      file: "/usr/bin/sudo",
      // -n is not optional: a rule that still wants a password must fail
      // immediately rather than block on a prompt nobody will see.
      args: ["-n", "-u", USER, "/usr/bin/tmux", "has-session", "-t", `=${SESSION}`],
    });
  });

  it("never produces a single string — every element is its own argv entry", () => {
    const command = buildTmuxCommand({
      sudoPath: "/usr/bin/sudo",
      tmuxPath: "/usr/bin/tmux",
      user: USER,
      args: ["send-keys", "-t", `=${SESSION}:`, "-l", "--", "hi; rm -rf ~"],
    });
    expect(Array.isArray(command.args)).toBe(true);
    expect(command.args.at(-1)).toBe("hi; rm -rf ~");
    expect(command.args.join(" ")).not.toBe(command.file);
  });
});

// --- The two refusals ---------------------------------------------------------

describe("the adapter never runs as root", () => {
  it("refuses every operation when its own uid is 0, before spawning anything", async () => {
    const runner = makeRunner();
    const asRoot = adapter(runner.run, { getuid: () => 0 });
    const results = await Promise.all([
      asRoot.hasSession(USER, SESSION),
      asRoot.killSession(USER, SESSION),
      asRoot.sendEscape(USER, SESSION),
      asRoot.sendMessage(USER, SESSION, "hello"),
      asRoot.listSessions(USER),
      asRoot.newSession({ user: USER, name: SESSION, cwd: "/srv/x", command: ["claude"] }),
    ]);
    for (const result of results) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.kind).toBe("refused_root");
    }
    expect(runner.calls).toHaveLength(0);
  });

  it("runs normally on a platform with no uids at all (getuid undefined)", async () => {
    const runner = makeRunner();
    const noUid = adapter(runner.run, { getuid: () => undefined });
    expect((await noUid.hasSession(USER, SESSION)).ok).toBe(true);
  });
});

describe("the `sudo -u` target comes from the allowlist, never from a caller", () => {
  const unknownUsers = ["mallory", "root", "gluy ", "gluy;id", "", "GLUY"];

  for (const user of unknownUsers) {
    it(`rejects ${JSON.stringify(user)} without spawning anything`, async () => {
      const runner = makeRunner();
      const result = await adapter(runner.run).sendMessage(user, SESSION, "hello");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.kind).toBe("unknown_user");
      expect(runner.calls).toHaveLength(0);
    });
  }

  it("accepts an allowlisted account and passes it verbatim as the -u argument", async () => {
    const runner = makeRunner();
    await adapter(runner.run).hasSession("user2", SESSION);
    expect(runner.calls[0]?.args.slice(0, 3)).toEqual(["-n", "-u", "user2"]);
  });

  it("rejects an illegal session name before it can become a target", async () => {
    const runner = makeRunner();
    const result = await adapter(runner.run).killSession(USER, "has:colon");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("invalid_session_name");
    expect(runner.calls).toHaveLength(0);
  });
});

// --- Command construction through the adapter ---------------------------------

describe("each operation's argv", () => {
  it("sends literal text with -l -- and submits separately", async () => {
    const runner = makeRunner((args) => (args[0] === "capture-pane" ? { stdout: composerPane() } : {}));
    const text = "please refactor; rm -rf ~ && echo pwned > /tmp/PWNED";
    const result = await adapter(runner.run).sendMessage(USER, SESSION, text);
    expect(result.ok).toBe(true);

    const sends = runner.calls.filter((call) => call.tmuxArgs[0] === "send-keys");
    const literal = sends.find((call) => call.tmuxArgs.includes("-l"));
    const submit = sends.find((call) => call.tmuxArgs.includes("Enter"));
    expect(literal?.tmuxArgs).toEqual(["send-keys", "-t", `=${SESSION}:`, "-l", "--", text]);
    expect(submit?.tmuxArgs).toEqual(["send-keys", "-t", `=${SESSION}:`, "Enter"]);
    // The submit is a separate invocation, after the text.
    expect(sends.indexOf(literal!)).toBeLessThan(sends.indexOf(submit!));
  });

  it("clears the composer before typing, because an interrupt restores the last prompt into it", async () => {
    const runner = makeRunner((args) =>
      args[0] === "capture-pane" ? { stdout: composerPane("a leftover draft") } : {},
    );
    await adapter(runner.run).sendMessage(USER, SESSION, "the next message");
    const order = runner.calls
      .filter((call) => call.tmuxArgs[0] === "send-keys")
      .map((call) => call.tmuxArgs.slice(3).join(" "));
    expect(order[0]).toBe("C-u");
    expect(order.at(-2)).toContain("-l -- the next message");
    expect(order.at(-1)).toBe("Enter");
  });

  it("interrupts with a single Escape keystroke", async () => {
    const runner = makeRunner();
    expect((await adapter(runner.run).sendEscape(USER, SESSION)).ok).toBe(true);
    expect(runner.calls[0]?.tmuxArgs).toEqual(["send-keys", "-t", `=${SESSION}:`, "Escape"]);
  });

  it("starts a detached session with the config dir, working directory and argv command", async () => {
    const runner = makeRunner((args) => (args[0] === "capture-pane" ? { stdout: composerPane() } : {}));
    const result = await adapter(runner.run).newSession({
      user: USER,
      name: SESSION,
      cwd: "/srv/office/projects/schedool",
      configDir: "/home/gluy/.claude",
      env: { NODE_EXTRA_CA_CERTS: "/srv/office/tls/ca.pem" },
      command: ["claude", "--agent", "dev-lead", "--permission-mode", "default"],
    });
    expect(result.ok).toBe(true);
    expect(runner.calls[0]?.tmuxArgs).toEqual([
      "new-session",
      "-d",
      "-s",
      SESSION,
      "-x",
      "200",
      "-y",
      "50",
      "-c",
      "/srv/office/projects/schedool",
      "-e",
      "CLAUDE_CONFIG_DIR=/home/gluy/.claude",
      "-e",
      "NODE_EXTRA_CA_CERTS=/srv/office/tls/ca.pem",
      "--",
      "claude",
      "--agent",
      "dev-lead",
      "--permission-mode",
      "default",
    ]);
    // hasSession is checked straight afterwards — the ticket's "reports it
    // within 2 s" criterion — and it proves the session, not readiness.
    expect(runner.subcommands()[1]).toBe("has-session");
  });

  it("refuses a launch command tmux would hand to a shell", async () => {
    const runner = makeRunner();
    const result = await adapter(runner.run).newSession({
      user: USER,
      name: SESSION,
      cwd: "/srv/x",
      // The design's own example. It needs a shell for the inline
      // assignment, which is why the adapter uses `new-session -e` instead.
      command: ["CLAUDE_CONFIG_DIR=/home/gluy/.claude claude --agent dev-lead"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("invalid_command");
    expect(runner.calls).toHaveLength(0);
  });
});

// --- Typed outcomes -----------------------------------------------------------

describe("killSession", () => {
  it("returns a typed not-found result instead of throwing", async () => {
    const runner = makeRunner(() => ({ code: 1, stderr: "can't find session: office-gone\n" }));
    const result = await adapter(runner.run).killSession(USER, SESSION);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("not_found");
      expect(result.exitCode).toBe(1);
    }
  });

  it("reports a sudo refusal as a sudo problem, not a missing session", async () => {
    const runner = makeRunner(() => ({
      code: 1,
      stderr: "sudo: a password is required\n",
    }));
    const result = await adapter(runner.run).killSession(USER, SESSION);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("sudo_denied");
  });
});

describe("hasSession", () => {
  it("is true on exit 0", async () => {
    const result = await adapter(makeRunner().run).hasSession(USER, SESSION);
    expect(result).toEqual({ ok: true, value: { exists: true } });
  });

  for (const stderr of ["can't find session: office-x\n", "no server running on /tmp/tmux-1000/default\n"]) {
    it(`is false, not an error, for ${JSON.stringify(stderr.trim())}`, async () => {
      const runner = makeRunner(() => ({ code: 1, stderr }));
      const result = await adapter(runner.run).hasSession(USER, SESSION);
      expect(result).toEqual({ ok: true, value: { exists: false } });
    });
  }

  it('surfaces an unclassified tmux failure rather than reporting "false"', async () => {
    const runner = makeRunner(() => ({ code: 1, stderr: "tmux: invalid option -- 'q'\n" }));
    const result = await adapter(runner.run).hasSession(USER, SESSION);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("tmux_error");
  });
});

describe("listSessions", () => {
  it("separates our sessions from everyone else's and never touches theirs", async () => {
    const runner = makeRunner(() => ({
      stdout: [SESSION, "office-capture", "gluy-scratch", `${SESSION}-g2`, ""].join("\n"),
    }));
    const result = await adapter(runner.run).listSessions(USER);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.names).toEqual([SESSION, `${SESSION}-g2`]);
      // `office-capture` is a real long-lived hook-listener session on the
      // dev box. It starts with "office" and is emphatically not ours.
      expect(result.value.foreign).toEqual(["office-capture", "gluy-scratch"]);
    }
  });

  it("treats 'no server running' as an empty list", async () => {
    const runner = makeRunner(() => ({ code: 1, stderr: "no server running on /tmp/tmux-1000/default\n" }));
    const result = await adapter(runner.run).listSessions(USER);
    expect(result).toEqual({ ok: true, value: { names: [], foreign: [] } });
  });

  it("never issues kill-server", async () => {
    const runner = makeRunner(() => ({ stdout: "" }));
    await adapter(runner.run).listSessions(USER);
    for (const call of runner.calls) {
      expect(call.tmuxArgs).not.toContain("kill-server");
    }
  });
});

// --- Readiness ----------------------------------------------------------------

describe("classifyPane — readiness is the composer's structure, never a hint string", () => {
  const rows: ReadonlyArray<{ readonly what: string; readonly pane: string; readonly expected: string }> = [
    { what: "a composer with the default hint", pane: composerPane(), expected: "composer_ready" },
    {
      what: "a composer whose hint line moved with the permission mode",
      // Spike 002's harness waited 90 s against a live, input-accepting
      // session because it matched `? for shortcuts` and this build says
      // something else. Structure has to be the check.
      pane: composerPane().replace("? for shortcuts", "⏵⏵ auto mode on (shift+tab to cycle)"),
      expected: "composer_ready",
    },
    { what: "the folder-trust dialog", pane: TRUST_PANE, expected: "trust_dialog" },
    { what: "an onboarding modal", pane: MODAL_PANE, expected: "modal" },
    { what: "a permission dialog", pane: PERMISSION_PANE, expected: "permission_dialog" },
    { what: "a rejected login", pane: AUTH_PANE, expected: "auth_failed" },
    { what: "an empty pane", pane: "", expected: "unknown" },
    { what: "a pane still drawing the banner", pane: "Welcome to Claude Code", expected: "unknown" },
    {
      what: "a dialog drawn over a composer",
      // The reason dialogs are tested before readiness: the composer is
      // still on screen underneath, so a readiness-first check types the
      // opening brief into the dialog.
      pane: `${composerPane()}\n${TRUST_PANE}`,
      expected: "trust_dialog",
    },
    {
      what: "a permission dialog drawn over a composer",
      pane: `${composerPane()}\n${PERMISSION_PANE}`,
      expected: "permission_dialog",
    },
  ];

  for (const row of rows) {
    it(`reports ${row.expected} for ${row.what}`, () => {
      expect(classifyPane(row.pane)).toBe(row.expected);
    });
  }

  it("does not mistake a busy turn for a dialog", () => {
    // `esc to interrupt` is not a busy signal (spike §2) and must not be a
    // readiness signal either — the composer is up throughout a turn.
    expect(classifyPane(`${composerPane()}\n  esc to interrupt`)).toBe("composer_ready");
  });
});

describe("composerText", () => {
  it("reads only the input box, stripping the marker and the NBSP padding", () => {
    expect(composerText(composerPane("half a draft"))).toBe("half a draft");
    expect(composerText(composerPane().replace("❯ ", `❯  draft `))).toBe("draft");
  });

  it("is undefined when no composer is on screen", () => {
    expect(composerText("")).toBeUndefined();
    expect(composerText(TRUST_PANE)).toBeUndefined();
  });
});

describe("newSession readiness", () => {
  it("does not treat has-session as readiness — it waits for a composer", async () => {
    let captures = 0;
    const runner = makeRunner((args) => {
      if (args[0] !== "capture-pane") return {};
      captures += 1;
      // The session is alive and tmux says so from the first moment, but
      // a trust dialog is sitting in front of the TUI. This is the exact
      // case where a naive adapter sends the brief into the dialog.
      if (captures === 1) return { stdout: TRUST_PANE };
      if (captures === 2) return { stdout: MODAL_PANE };
      return { stdout: composerPane() };
    });
    const result = await adapter(runner.run).newSession({
      user: USER,
      name: SESSION,
      cwd: "/srv/x",
      command: ["claude", "--agent", "dev-lead"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.dialogsAnswered).toEqual(["trust(Enter)", "modal(Escape)"]);
      expect(result.value.readyMs).toBeGreaterThan(0);
    }
    // Nothing but the dialog answers was sent. No brief, no text.
    const sent = runner.calls.filter((call) => call.tmuxArgs[0] === "send-keys");
    expect(sent.map((call) => call.tmuxArgs.at(-1))).toEqual(["Enter", "Escape"]);
    expect(sent.some((call) => call.tmuxArgs.includes("-l"))).toBe(false);
  });

  it("never answers a permission dialog, even at startup", async () => {
    const runner = makeRunner((args) =>
      args[0] === "capture-pane" ? { stdout: PERMISSION_PANE } : {},
    );
    const result = await adapter(runner.run).newSession({
      user: USER,
      name: SESSION,
      cwd: "/srv/x",
      command: ["claude"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("blocked_by_dialog");
    expect(runner.calls.some((call) => call.tmuxArgs.includes("Enter"))).toBe(false);
  });

  it("kills the session and reports not_ready when no composer ever appears", async () => {
    const runner = makeRunner((args) => (args[0] === "capture-pane" ? { stdout: "still booting" } : {}));
    const result = await adapter(runner.run, { readyTimeoutMs: 5_000 }).newSession({
      user: USER,
      name: SESSION,
      cwd: "/srv/x",
      command: ["claude"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("not_ready");
      // The pane is carried on the failure so the diagnosis survives the
      // kill below.
      expect(result.pane).toBe("still booting");
    }
    // No orphan left holding memory against ticket 018's cap.
    expect(runner.subcommands()).toContain("kill-session");
  });

  it("fails when the pane command exits immediately, rather than reporting a live desk", async () => {
    const runner = makeRunner((args) =>
      args[0] === "has-session" ? { code: 1, stderr: "can't find session: x\n" } : {},
    );
    const result = await adapter(runner.run).newSession({
      user: USER,
      name: SESSION,
      cwd: "/srv/x",
      command: ["claude"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("not_found");
  });

  it("skips readiness only when asked, and then reports readyMs as null", async () => {
    const runner = makeRunner();
    const result = await adapter(runner.run).newSession({
      user: USER,
      name: SESSION,
      cwd: "/srv/x",
      command: ["claude"],
      waitForComposer: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.readyMs).toBeNull();
    expect(runner.subcommands()).not.toContain("capture-pane");
  });
});

// --- The permission-dialog hazard ---------------------------------------------

describe("sendMessage refuses to deliver into a dialog", () => {
  // Spike 002 §1: a chat message delivered while a permission dialog is up
  // selects the highlighted `1. Yes` and the tool runs — 3/3, proven by the
  // file the approved command created. This is defence in depth over
  // fragile pane strings, not the gate; ticket 008 owns that.
  for (const [what, pane, kind] of [
    ["a permission dialog", PERMISSION_PANE, "blocked_by_dialog"],
    ["the folder-trust dialog", TRUST_PANE, "blocked_by_dialog"],
    ["an onboarding modal", MODAL_PANE, "blocked_by_dialog"],
    ["a rejected login", AUTH_PANE, "auth_failed"],
    ["an unrecognised pane", "who knows", "not_ready"],
  ] as const) {
    it(`refuses with ${kind} when the pane shows ${what}, sending no keys at all`, async () => {
      const runner = makeRunner((args) => (args[0] === "capture-pane" ? { stdout: pane } : {}));
      const result = await adapter(runner.run).sendMessage(USER, SESSION, "hello");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.kind).toBe(kind);
      expect(runner.calls.filter((call) => call.tmuxArgs[0] === "send-keys")).toHaveLength(0);
    });
  }
});

describe("message rejection is loud, never silent truncation", () => {
  for (const [what, text, contains] of [
    ["a NUL byte", "before\0after", "NUL"],
    ["a carriage return", "line one\r\nline two", "carriage return"],
    ["an empty message", "", "empty"],
  ] as const) {
    it(`rejects ${what} before spawning anything`, async () => {
      const runner = makeRunner();
      const result = await adapter(runner.run).sendMessage(USER, SESSION, text);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe("invalid_message");
        expect(result.message).toContain(contains);
      }
      expect(runner.calls).toHaveLength(0);
    });
  }

  it("rejects an over-limit message rather than delivering a prefix", async () => {
    const runner = makeRunner();
    const small = adapter(runner.run, { maxMessageBytes: 32 });
    const result = await small.sendLiteral(USER, SESSION, "x".repeat(33));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("invalid_message");
    expect(runner.calls).toHaveLength(0);
  });
});

// --- Timeouts, against a real process -----------------------------------------

describe("every invocation has a timeout", () => {
  let dir: string;
  let sleeper: string;
  let recorder: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "office-tmux-test-"));
    sleeper = path.join(dir, "sleeper.mjs");
    recorder = path.join(dir, "recorder.mjs");
    // A stub binary that never exits on its own — the hung `sudo` case.
    await writeFile(sleeper, "setTimeout(() => {}, 60_000);\n", "utf8");
    // A stub binary that records the argv it was handed, byte for byte.
    await writeFile(
      recorder,
      [
        "import { writeFileSync } from 'node:fs';",
        "const [out, ...rest] = process.argv.slice(2);",
        "writeFileSync(out, JSON.stringify(rest), 'utf8');",
        "",
      ].join("\n"),
      "utf8",
    );
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("kills a hung command and resolves as timedOut instead of leaking it", async () => {
    const started = Date.now();
    const outcome = await spawnRunner({ file: process.execPath, args: [sleeper], timeoutMs: 300 });
    const elapsed = Date.now() - started;
    expect(outcome.timedOut).toBe(true);
    // Resolving at all means the child's `close` fired, i.e. the process
    // is gone rather than orphaned.
    expect(elapsed).toBeLessThan(10_000);
    expect(outcome.code === null || outcome.code !== 0).toBe(true);
  });

  it("surfaces that as a typed `timeout` through the adapter", async () => {
    // The adapter's own runner, rewired to run the hung stub instead of
    // sudo, so the classification path is the real one.
    const run: CommandRunner = (request) =>
      spawnRunner({ file: process.execPath, args: [sleeper], timeoutMs: request.timeoutMs });
    const result = await createTmuxAdapter({
      agentUsers: AGENT_USERS,
      run,
      getuid: () => 1000,
      commandTimeoutMs: 300,
    }).hasSession(USER, SESSION);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("timeout");
  });

  it("reports a missing binary as spawn_failed rather than hanging", async () => {
    const run: CommandRunner = (request) =>
      spawnRunner({
        file: path.join(dir, "definitely-not-a-binary"),
        args: request.args,
        timeoutMs: request.timeoutMs,
      });
    const result = await createTmuxAdapter({ agentUsers: AGENT_USERS, run, getuid: () => 1000 }).hasSession(
      USER,
      SESSION,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("spawn_failed");
  });

  it("passes `; rm -rf ~` to a real child as one literal argument, executing nothing", async () => {
    // The ticket's named case, measured rather than reasoned about. The
    // payload contains a redirect that WOULD create a file if any shell
    // ever saw it; the assertion is that the file does not exist.
    const marker = path.join(dir, "PWNED");
    const payload = `refactor the auth module; rm -rf ~ && echo pwned > ${marker}`;
    const recorded = path.join(dir, "argv.json");

    // Exactly the argv the adapter builds, down to the last element.
    const runner = makeRunner((args) => (args[0] === "capture-pane" ? { stdout: composerPane() } : {}));
    await adapter(runner.run).sendMessage(USER, SESSION, payload);
    const literalCall = runner.calls.find((call) => call.tmuxArgs.includes("-l"));
    expect(literalCall).toBeDefined();

    const outcome = await spawnRunner({
      file: process.execPath,
      args: [recorder, recorded, ...(literalCall?.args ?? [])],
      timeoutMs: 10_000,
    });
    expect(outcome.code).toBe(0);

    const seen: string[] = JSON.parse(await readFile(recorded, "utf8"));
    // Byte for byte, in one element, with the `--` still in front of it.
    expect(seen.at(-1)).toBe(payload);
    expect(seen.at(-2)).toBe("--");
    expect(seen.filter((arg) => arg === payload)).toHaveLength(1);
    await expect(stat(marker)).rejects.toThrow();
  });
});

// --- Live tmux ----------------------------------------------------------------

// These need a real tmux server and are skipped by default. They do NOT
// need Claude Code: they drive `cat` in a pane, so they spend no tokens and
// prove only what tmux does. Run with:
//
//   OFFICE_TMUX_LIVE=1 OFFICE_TMUX_BIN=/usr/bin/tmux pnpm run test -- orchestrator
//
// Everything above is what actually guards the system; this suite exists so
// the targeting and delivery claims can be re-checked on the VPS, where the
// `sudo -n -u` path spike 002 never measured (§7, DEFERRED) is finally real.
// It creates only `office-live-*` sessions and kills only those — never
// `kill-server`, because other people have tmux sessions on that box.
const live = process.env.OFFICE_TMUX_LIVE === "1";

describe.skipIf(!live)("live tmux", () => {
  const name = `office-live-${process.pid}-0000000000`;
  const tmuxPath = process.env.OFFICE_TMUX_BIN ?? "/usr/bin/tmux";
  const user = process.env.OFFICE_TMUX_USER;

  // With no OFFICE_TMUX_USER the commands run without sudo, which is NOT
  // what the VPS does — the same caveat every row in spike 002 carries.
  const run: CommandRunner = (request) =>
    user === undefined
      ? spawnRunner({ file: tmuxPath, args: request.args.slice(4), timeoutMs: request.timeoutMs })
      : spawnRunner(request);

  const liveAdapter = createTmuxAdapter({
    agentUsers: [user ?? "live"],
    tmuxPath,
    run,
    getuid: () => process.getuid?.() ?? 1000,
  });
  const asUser = user ?? "live";

  afterAll(async () => {
    await liveAdapter.killSession(asUser, name);
  });

  it("starts, addresses and stops a session with no shell in the path", async () => {
    const started = await liveAdapter.newSession({
      user: asUser,
      name,
      cwd: process.cwd(),
      command: ["/bin/cat"],
      waitForComposer: false,
    });
    expect(started.ok).toBe(true);

    const text = 'literal "$HOME" `id` ; echo pwned';
    expect((await liveAdapter.sendLiteral(asUser, name, text)).ok).toBe(true);
    expect((await liveAdapter.sendKeys(asUser, name, ["Enter"])).ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 500));

    const pane = await liveAdapter.capturePane(asUser, name);
    expect(pane.ok).toBe(true);
    if (pane.ok) expect(pane.value.pane).toContain(text);

    expect((await liveAdapter.killSession(asUser, name)).ok).toBe(true);
    const after = await liveAdapter.killSession(asUser, name);
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.kind).toBe("not_found");
  });
});
