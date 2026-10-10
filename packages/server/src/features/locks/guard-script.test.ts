// hooks/pretooluse-guard.sh, actually executed.
//
// This file exists because the script is the half of the guard that only runs
// when something is already broken, and "it looks right" is not a test of a
// failure path. Every case here runs the real script through a real `bash`.
//
// TWO KINDS OF DOUBLE, for two kinds of question:
//
//   - A **stub curl** that records its argv and its stdin and exits with a
//     code the test chooses. This is how the load-bearing security property
//     is proven rather than asserted by reading: the payload must reach
//     another process ONLY on stdin, never in an argument. A stub can be
//     asked what it was handed; a real curl cannot.
//   - A **real HTTP server**, including one that never answers, for the
//     questions a stub cannot answer: that `--max-time` is honoured so an
//     agent never hangs on an unreachable orchestrator, and that a real
//     round trip clears the buffer.
//
// The server here is plain http on loopback, deliberately: the https
// decision is enforced on the hook *fragment* (009's merge refuses an http
// hook whose url is not https, and a test in guard-check.test.ts covers the
// shipped fragment). The script takes whatever origin it is given, so making
// this test fight TLS would test node's certificate handling, not the script.
// That `--cacert` is passed at all is asserted against the stub's argv.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { globSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../core/app.ts";
import { loadServerConfig } from "../../core/config.ts";
import { pool } from "../../core/db/pool.ts";
import { createTask } from "../tasks/model.ts";
import { insertTask } from "../tasks/repo.ts";
import { acquireScope } from "./registry.ts";

const repoRoot = nodePath.resolve(import.meta.dirname, "../../../../..");
const scriptPath = nodePath.join(repoRoot, "hooks/pretooluse-guard.sh").replace(/\\/g, "/");
const CWD = "/srv/office/projects/demo";

/** The payload a real `Edit` sends. `content` is the thing that must never be
 *  written anywhere, so it is a string no other part of the fixture uses. */
const SECRET = "API_KEY=sk-THIS-IS-FILE-CONTENT-AND-MUST-NEVER-BE-LOGGED";
function payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: "bbbbbbbb-2222-4222-8222-000000000001",
    transcript_path: "/home/agent1/.claude/projects/x/y.jsonl",
    cwd: CWD,
    prompt_id: randomUUID(),
    permission_mode: "manual",
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_input: {
      file_path: `${CWD}/src/db/schema.ts`,
      old_string: "a",
      new_string: "b",
      content: SECRET,
    },
    tool_use_id: "toolu_abc",
    ...overrides,
  });
}

// --- Locating the tools the script needs -----------------------------------------

/** `jq` on PATH, or the binary npm's `node-jq` cached for this machine. Null
 *  means the jq-dependent cases cannot run here and say so rather than
 *  pretending. */
function findJq(): string | null {
  if (process.env.OFFICE_GUARD_TEST_JQ) return process.env.OFFICE_GUARD_TEST_JQ;
  try {
    const found = execFileSync("bash", ["-c", "command -v jq"], { encoding: "utf8" }).trim();
    if (found) return found;
  } catch {
    /* not on PATH */
  }
  const cache = process.env.npm_config_cache ?? nodePath.join(process.env.LOCALAPPDATA ?? "", "npm-cache");
  for (const pattern of ["_npx/*/node_modules/node-jq/bin/jq.exe", "_npx/*/node_modules/node-jq/bin/jq"]) {
    const hits = globSync(pattern, { cwd: cache }).map((hit) => nodePath.join(cache, hit));
    if (hits.length > 0) return hits[0]!.replace(/\\/g, "/");
  }
  return null;
}

function findShellcheck(): string | null {
  try {
    const found = execFileSync("bash", ["-c", "command -v shellcheck"], { encoding: "utf8" }).trim();
    if (found) return found;
  } catch {
    /* not on PATH */
  }
  const cache = process.env.npm_config_cache ?? nodePath.join(process.env.LOCALAPPDATA ?? "", "npm-cache");
  for (const pattern of [
    "_npx/*/node_modules/shellcheck/bin/shellcheck.exe",
    "_npx/*/node_modules/shellcheck/bin/shellcheck",
  ]) {
    const hits = globSync(pattern, { cwd: cache }).map((hit) => nodePath.join(cache, hit));
    if (hits.length > 0) return hits[0]!;
  }
  return null;
}

const jqBin = findJq();
const shellcheckBin = findShellcheck();

// --- Harness -----------------------------------------------------------------------

let dir: string;
let stub: string;
const scratch: string[] = [];

function posix(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * A fake curl. Records every argument it was given and everything it was fed
 * on stdin, honours `-o <file>` by writing `$STUB_BODY` there, and exits with
 * `$STUB_EXIT`.
 */
function writeStub(target: string): void {
  writeFileSync(
    target,
    [
      "#!/usr/bin/env bash",
      'printf "%s\\n" "$@" > "$STUB_DIR/argv"',
      'cat > "$STUB_DIR/stdin"',
      "out=''",
      "while [ $# -gt 0 ]; do",
      '  if [ "$1" = "-o" ]; then out="$2"; fi',
      "  shift",
      "done",
      'if [ -n "$out" ] && [ "$out" != "/dev/null" ]; then',
      '  printf "%s" "${STUB_BODY:-}" > "$out"',
      "fi",
      'exit "${STUB_EXIT:-0}"',
      "",
    ].join("\n"),
  );
  chmodSync(target, 0o755);
}

interface RunOptions {
  readonly env?: Record<string, string>;
  readonly stdin?: string;
}

function runGuard(options: RunOptions = {}) {
  const result = spawnSync("bash", [scriptPath], {
    input: options.stdin ?? payload(),
    encoding: "utf8",
    env: {
      ...process.env,
      OFFICE_EVENT_SERVER_ORIGIN: "https://127.0.0.1:4000",
      OFFICE_HOOK_INGEST_TOKEN: "tok-test-0123456789abcdef",
      NODE_EXTRA_CA_CERTS: "/srv/office/tls/dev-cert.pem",
      OFFICE_GUARD_DIR: posix(dir),
      OFFICE_GUARD_CURL: posix(stub),
      OFFICE_GUARD_JQ: jqBin ?? "definitely-not-jq",
      OFFICE_GUARD_ENFORCE: "0",
      STUB_DIR: posix(dir),
      STUB_EXIT: "0",
      ...options.env,
    },
  });
  return result;
}

/**
 * The same thing, ASYNCHRONOUSLY — and the distinction is load-bearing for
 * every case that talks to a listener in this process.
 *
 * `spawnSync` blocks node's event loop, so an in-process HTTP server cannot
 * answer the script's request while it runs: curl connects, sends, and times
 * out. Two cases here passed for exactly that wrong reason before this
 * existed — the "401 is an outage" case was really measuring a timeout, which
 * is a different outage and proved nothing about the 401.
 */
function runGuardAsync(
  env: Record<string, string>,
  stdin: string = payload(),
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [scriptPath], {
      env: {
        ...process.env,
        OFFICE_HOOK_INGEST_TOKEN: "tok-test-0123456789abcdef",
        NODE_EXTRA_CA_CERTS: "",
        OFFICE_GUARD_DIR: posix(dir),
        OFFICE_GUARD_JQ: jqBin ?? "definitely-not-jq",
        OFFICE_GUARD_ENFORCE: "0",
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

function bufferPath(): string {
  return nodePath.join(dir, "guard-buffer.jsonl");
}

function bufferLines(): string[] {
  if (!existsSync(bufferPath())) return [];
  return readFileSync(bufferPath(), "utf8").split("\n").filter((line) => line.trim() !== "");
}

function droppedCount(): number {
  const path = nodePath.join(dir, "guard-dropped");
  if (!existsSync(path)) return 0;
  return Number.parseInt(readFileSync(path, "utf8").trim(), 10);
}

beforeEach(() => {
  dir = mkdtempSync(nodePath.join(tmpdir(), "t020-guard-"));
  scratch.push(dir);
  stub = nodePath.join(dir, "curl-stub.sh");
  writeStub(stub);
});

afterEach(() => {
  /* directories are removed in afterAll, so a failing case leaves its evidence */
});

afterAll(() => {
  for (const path of scratch) rmSync(path, { recursive: true, force: true });
});

// --- Static analysis -----------------------------------------------------------------

describe("shellcheck", () => {
  it(
    shellcheckBin
      ? "reports nothing at all, at every severity"
      : "SKIPPED — no shellcheck binary on this machine",
    () => {
      if (!shellcheckBin) {
        console.warn(
          "guard-script.test.ts: shellcheck not found on PATH or in the npm cache — " +
            "the shellcheck criterion is UNVERIFIED by this run. " +
            "`npx --yes shellcheck@latest hooks/pretooluse-guard.sh` verifies it.",
        );
        return;
      }
      const result = spawnSync(shellcheckBin, [scriptPath], { encoding: "utf8" });
      expect(`${result.stdout}${result.stderr}`.trim()).toBe("");
      expect(result.status).toBe(0);
    },
  );

  it("is syntactically valid bash", () => {
    const result = spawnSync("bash", ["-n", scriptPath], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});

// --- The property that matters most ---------------------------------------------------

describe("the payload never reaches a command line", () => {
  it("hands the body to curl on STDIN and puts nothing from it in argv", () => {
    const result = runGuard();
    expect(result.status).toBe(0);

    const argv = readFileSync(nodePath.join(dir, "argv"), "utf8");
    // Nothing from the payload — not the path, not the session id, and above
    // all not the file content.
    expect(argv).not.toContain(SECRET);
    expect(argv).not.toContain("schema.ts");
    expect(argv).not.toContain("bbbbbbbb-2222");
    // Only the orchestrator's own configuration reaches the command line.
    expect(argv).toContain("https://127.0.0.1:4000/guard/flush?token=tok-test-0123456789abcdef");
    expect(argv).toContain("--cacert");
    expect(argv).toContain("/srv/office/tls/dev-cert.pem");
    expect(argv).toContain("--max-time");
    // `--data-binary @-` is how the body travels, and it is the whole reason
    // argv stays clean.
    expect(argv).toContain("--data-binary");
    expect(argv).toContain("@-");
  });

  it("sends a constant 24-byte body on the common path, needing no jq at all", () => {
    // The hot path: buffer empty, orchestrator up. No jq invocation, no
    // payload parsing, nothing but a fixed probe.
    runGuard({ env: { OFFICE_GUARD_JQ: "definitely-not-jq" } });
    expect(readFileSync(nodePath.join(dir, "stdin"), "utf8")).toBe('{"dropped":0,"edits":[]}');
    expect(bufferLines()).toHaveLength(0);
  });
});

// --- Failing open ----------------------------------------------------------------------

describe("when the orchestrator does not answer", () => {
  it("still exits 0 — the agent proceeds", () => {
    const result = runGuard({ env: { STUB_EXIT: "7" } });
    expect(result.status).toBe(0);
  });

  it("buffers the attempt to disk, with the path and WITHOUT the file content", () => {
    if (!jqBin) {
      console.warn("guard-script.test.ts: no jq — path extraction UNVERIFIED by this run");
    }
    const result = runGuard({ env: { STUB_EXIT: "7" } });
    expect(result.status).toBe(0);

    const lines = bufferLines();
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(typeof entry.edit_id).toBe("string");
    expect(String(entry.reason)).toContain("curl exit 7");

    // THE criterion: paths, never contents.
    expect(lines[0]).not.toContain(SECRET);
    expect(lines[0]).not.toContain("API_KEY");
    if (jqBin) {
      expect(entry.paths).toEqual([`${CWD}/src/db/schema.ts`]);
      expect(entry.tool_name).toBe("Edit");
      expect(entry.cwd).toBe(CWD);
      expect(entry.session_id).toBe("bbbbbbbb-2222-4222-8222-000000000001");
      // The fields that carry file text are absent from the record entirely.
      expect(Object.keys(entry)).not.toContain("tool_input");
      expect(Object.keys(entry)).not.toContain("content");
    }
  });

  it("records the attempt with NO path rather than guessing one when jq is missing", () => {
    // Not a graceful degradation for its own sake: `tool_input.content` can
    // contain text that looks exactly like a `"file_path": "..."` pair, so a
    // grep would produce a wrong path AND leak the content.
    const result = runGuard({
      env: { STUB_EXIT: "7", OFFICE_GUARD_JQ: "definitely-not-jq-at-all" },
    });
    expect(result.status).toBe(0);
    const entry = JSON.parse(bufferLines()[0]!) as Record<string, unknown>;
    expect(entry.paths).toEqual([]);
    expect(String(entry.extract)).toContain("jq unavailable");
    expect(bufferLines()[0]).not.toContain(SECRET);
    expect(result.stderr).toContain("no jq on this box");
  });

  it("buffers when the environment carries no origin or token", () => {
    const result = runGuard({
      env: { OFFICE_EVENT_SERVER_ORIGIN: "", OFFICE_HOOK_INGEST_TOKEN: "" },
    });
    expect(result.status).toBe(0);
    expect(String((JSON.parse(bufferLines()[0]!) as { reason: string }).reason)).toContain(
      "OFFICE_EVENT_SERVER_ORIGIN",
    );
    // And it did not call curl at all — there was nowhere to call.
    expect(existsSync(nodePath.join(dir, "argv"))).toBe(false);
  });
});

// --- Flush and clear -------------------------------------------------------------------

describe("the buffer flushes on the next successful check", () => {
  it("sends every buffered line as one array and deletes the spool only after the ack", () => {
    // Two failures, then a success.
    runGuard({ env: { STUB_EXIT: "7" } });
    runGuard({ env: { STUB_EXIT: "7" }, stdin: payload({ tool_name: "Write" }) });
    expect(bufferLines()).toHaveLength(2);

    runGuard({ env: { STUB_EXIT: "0" } });

    const sent = JSON.parse(readFileSync(nodePath.join(dir, "stdin"), "utf8")) as {
      dropped: number;
      edits: { edit_id: string }[];
    };
    expect(sent.edits).toHaveLength(2);
    expect(sent.edits.every((edit) => typeof edit.edit_id === "string")).toBe(true);
    expect(bufferLines()).toHaveLength(0);
    // And no spool left behind.
    expect(globSync("guard-spool.*", { cwd: dir })).toHaveLength(0);
  });

  it("keeps the buffer when the flush is NOT acknowledged", () => {
    runGuard({ env: { STUB_EXIT: "7" } });
    const first = bufferLines();
    expect(first).toHaveLength(1);

    // A second failed attempt: the spool is restored and this attempt added.
    runGuard({ env: { STUB_EXIT: "7" } });
    const second = bufferLines();
    expect(second).toHaveLength(2);
    expect(second).toContain(first[0]);
    expect(globSync("guard-spool.*", { cwd: dir })).toHaveLength(0);
  });

  it("reports and resets the dropped count on a successful flush", () => {
    writeFileSync(nodePath.join(dir, "guard-dropped"), "11\n");
    runGuard({ env: { STUB_EXIT: "0" } });
    const sent = JSON.parse(readFileSync(nodePath.join(dir, "stdin"), "utf8")) as {
      dropped: number;
    };
    expect(sent.dropped).toBe(11);
    expect(droppedCount()).toBe(0);
  });
});

// --- The cap -----------------------------------------------------------------------------

describe("the buffer is size-capped", () => {
  it("drops OLDEST first and records how many it dropped", () => {
    // Five failures with a cap of three.
    const marks: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      runGuard({
        env: { STUB_EXIT: "7", OFFICE_GUARD_BUFFER_MAX_LINES: "3" },
        stdin: payload({ tool_use_id: `toolu_${i}` }),
      });
      marks.push(`toolu_${i}`);
    }

    const lines = bufferLines();
    expect(lines).toHaveLength(3);
    expect(droppedCount()).toBe(2);

    if (jqBin) {
      const ids = lines.map((line) => (JSON.parse(line) as { tool_use_id: string }).tool_use_id);
      // The NEWEST three survive — the ones an operator can still act on.
      expect(ids).toEqual([marks[2], marks[3], marks[4]]);
    }
  });

  it("falls back to the default when the cap is not a number, and says so", () => {
    const result = runGuard({
      env: { STUB_EXIT: "7", OFFICE_GUARD_BUFFER_MAX_LINES: "lots" },
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("OFFICE_GUARD_BUFFER_MAX_LINES is not a number");
    expect(bufferLines()).toHaveLength(1);
  });
});

// --- Optional enforcement ----------------------------------------------------------------

describe("OFFICE_GUARD_ENFORCE=1", () => {
  it("exits 2 with the orchestrator's reason on stderr", () => {
    // The `command`-hook refusal path. Off by default because the http entry
    // already blocks; it exists as the lever to pull if a build changes the
    // blocking vocabulary again.
    const reason = "src/db/schema.ts is owned by task 41 (owner agent2). Ask, or pick another file.";
    const result = runGuard({
      env: {
        OFFICE_GUARD_ENFORCE: "1",
        STUB_EXIT: "0",
        STUB_BODY: JSON.stringify({ decision: "block", reason }),
      },
    });
    expect(result.status).toBe(2);
    if (jqBin) {
      expect(result.stderr).toContain(reason);
    } else {
      expect(result.stderr).toContain("owned by another active task");
    }
    // The message reads sensibly behind the "[<script path>]: " prefix Claude
    // Code puts in front of a command hook's stderr.
    expect(result.stderr.startsWith("office-guard: ")).toBe(true);
  });

  it("exits 0 when the orchestrator allows", () => {
    const result = runGuard({
      env: {
        OFFICE_GUARD_ENFORCE: "1",
        STUB_EXIT: "0",
        STUB_BODY: JSON.stringify({ office: { outcome: "allow" } }),
      },
    });
    expect(result.status).toBe(0);
  });

  it("does not refuse when the orchestrator is unreachable — it buffers", () => {
    const result = runGuard({ env: { OFFICE_GUARD_ENFORCE: "1", STUB_EXIT: "7" } });
    expect(result.status).toBe(0);
    expect(bufferLines()).toHaveLength(1);
  });

  it("leaves no verdict file behind", () => {
    runGuard({
      env: {
        OFFICE_GUARD_ENFORCE: "1",
        STUB_EXIT: "0",
        STUB_BODY: JSON.stringify({ office: { outcome: "allow" } }),
      },
    });
    expect(globSync("verdict.*", { cwd: dir })).toHaveLength(0);
  });
});

// --- Against a real listener ----------------------------------------------------------------

describe("against a real HTTP listener", () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
    server = createServer(handler);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    return `http://127.0.0.1:${port}`;
  }

  it("does not hang on an endpoint that never answers, and buffers the edit", async () => {
    // THE criterion: "an agent never hangs waiting on an unreachable
    // orchestrator". The listener accepts the connection and then says
    // nothing at all, which is the shape a wedged orchestrator actually has —
    // worse than a refused connection, because a refusal is instant.
    const origin = await listen(() => {
      /* never respond */
    });

    const started = Date.now();
    const result = await runGuardAsync({
      OFFICE_EVENT_SERVER_ORIGIN: origin,
      OFFICE_GUARD_TIMEOUT_S: "1",
    });
    const elapsed = Date.now() - started;

    expect(result.status).toBe(0);
    // ~1 s of curl plus process spawn. The ceiling is the hook's own
    // "timeout": 2, past which Claude Code discards the output and the turn
    // resumes anyway — so anything under that is the agent not hanging.
    expect(elapsed).toBeLessThan(5_000);
    expect(bufferLines()).toHaveLength(1);
    expect(String((JSON.parse(bufferLines()[0]!) as { reason: string }).reason)).toContain(
      "curl exit",
    );
  }, 30_000);

  it("round-trips a real flush and clears the buffer", async () => {
    const bodies: string[] = [];
    const paths: string[] = [];
    const origin = await listen((request, response) => {
      paths.push(request.url ?? "");
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        bodies.push(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, accepted: 0 }));
      });
    });

    // One buffered failure first, against the stub.
    runGuard({ env: { STUB_EXIT: "7" } });
    expect(bufferLines()).toHaveLength(1);

    const result = await runGuardAsync({
      OFFICE_EVENT_SERVER_ORIGIN: origin,
      OFFICE_HOOK_INGEST_TOKEN: "tok-live",
    });

    expect(result.status).toBe(0);
    expect(paths).toEqual(["/guard/flush?token=tok-live"]);
    const sent = JSON.parse(bodies[0]!) as { edits: unknown[] };
    expect(sent.edits).toHaveLength(1);
    expect(bodies[0]).not.toContain(SECRET);
    expect(bufferLines()).toHaveLength(0);
  }, 30_000);

  it("treats a 401 as an outage, because an unauthorised guard is not a guard", async () => {
    let requests = 0;
    const origin = await listen((_request, response) => {
      requests += 1;
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "missing or invalid token" }));
    });
    const result = await runGuardAsync({
      OFFICE_EVENT_SERVER_ORIGIN: origin,
      OFFICE_HOOK_INGEST_TOKEN: "wrong",
      // Generous, so a timeout cannot stand in for the 401: curl must really
      // have been answered and really have refused.
      OFFICE_GUARD_TIMEOUT_S: "10",
    });
    expect(result.status).toBe(0);
    expect(bufferLines()).toHaveLength(1);
    // curl exit 22 is "HTTP error returned", not 28 ("timed out") — the
    // distinction this case exists for.
    expect(String((JSON.parse(bufferLines()[0]!) as { reason: string }).reason)).toContain(
      "curl exit 22",
    );
    expect(requests).toBe(1);
  }, 30_000);
});

// --- The join: a real buffer, written by the script, read by the real server ------------------

describe("the whole outage, end to end", () => {
  // THE CRITERION: "stop the server, have an agent edit a file owned by another
  // active task, restart, and confirm both tasks are flagged."
  //
  // The one part this machine cannot supply is the agent — there is no live
  // Claude desk and no tmux here. Everything else is real: a port with nothing
  // listening (connection refused, which is what a stopped server actually
  // looks like — not a timeout), the real script, the real buffer file it
  // writes, and that file POSTed VERBATIM to the real endpoint on the real app.
  //
  // The join between the two halves is a FILE FORMAT, and that is the part a
  // test can hold. Every other test in this repo that touches the flush
  // constructs the buffer by hand; this one does not, so a change to what the
  // script writes fails here rather than in production.
  it("script buffers to disk against a dead port, and the real endpoint flags both tasks", async () => {
    if (!jqBin) {
      console.warn(
        "guard-script.test.ts: no jq on this machine — the end-to-end case cannot extract " +
          "a path and is therefore UNVERIFIED by this run.",
      );
      return;
    }

    const slug = `t020e2e-${randomUUID()}`;
    const { rows: projectRows } = await pool.query<{ id: string }>(
      `insert into projects (name, slug, repo_url) values ($1, $2, $3) returning id`,
      [slug, slug, "https://example.invalid/repo.git"],
    );
    const project = projectRows[0]!.id;

    try {
      const claudeId = randomUUID();
      const { rows: sessionRows } = await pool.query<{ id: string }>(
        `insert into sessions
           (project_id, tmux_name, role, dept, owner, backend, model, model_reason,
            status, claude_session_id)
         values ($1, $2, 'dept_lead', 'dev', 'agent1', 'claude', 'claude-sonnet-5',
                 'test fixture', 'running', $3)
         returning id`,
        [project, slug, claudeId],
      );
      const sessionRowId = sessionRows[0]!.id;

      const offender = await insertTask(
        createTask({
          projectId: project as never,
          title: "the offender",
          department: "dev",
          owner: "agent1",
        }),
      );
      const owner = await insertTask(
        createTask({
          projectId: project as never,
          title: "the owner",
          department: "dev",
          owner: "agent2",
        }),
      );
      await acquireScope({
        projectId: project as never,
        taskId: offender.id,
        sessionId: sessionRowId,
        patterns: ["src/offender/"],
        ttlSeconds: 900,
      });
      await acquireScope({
        projectId: project as never,
        taskId: owner.id,
        sessionId: randomUUID(),
        patterns: ["src/db/"],
        ttlSeconds: 900,
      });

      // A port with nothing on it. ECONNREFUSED, which is what a stopped
      // orchestrator gives you — distinct from the never-answering listener
      // tested above, and the faster of the two failures.
      const deadPort = 1;
      const run = await runGuardAsync(
        {
          OFFICE_EVENT_SERVER_ORIGIN: `http://127.0.0.1:${deadPort}`,
          OFFICE_GUARD_TIMEOUT_S: "2",
        },
        JSON.stringify({
          session_id: claudeId,
          cwd: CWD,
          hook_event_name: "PreToolUse",
          tool_name: "Edit",
          tool_input: {
            file_path: `${CWD}/src/db/schema.ts`,
            old_string: "a",
            new_string: "b",
            content: SECRET,
          },
          tool_use_id: "toolu_e2e",
        }),
      );
      expect(run.status, "the agent must proceed even with the server down").toBe(0);

      // The buffer the script actually wrote, read off disk and sent as-is.
      const lines = bufferLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain(SECRET);

      const app = await buildApp();
      try {
        const token = loadServerConfig().hookIngestTokens[0]!;
        const response = await app.inject({
          method: "POST",
          url: `/guard/flush?token=${token}`,
          headers: { "content-type": "application/json" },
          // Exactly the shape the script builds: the lines joined into an
          // array. Not re-serialised through an object, so a field it renamed
          // would show up here.
          payload: `{"dropped":0,"edits":[${lines.join(",")}]}`,
        });
        expect(response.statusCode).toBe(200);
        const body = response.json() as {
          accepted: number;
          conflicts: number;
          flagged_task_ids: string[];
        };
        expect(body.accepted).toBe(1);
        expect(body.conflicts).toBe(1);
        // BOTH tasks, which is what the criterion asks for.
        expect(body.flagged_task_ids).toContain(owner.id);
        expect(body.flagged_task_ids).toContain(offender.id);
      } finally {
        await app.close();
      }
    } finally {
      await pool.query("delete from projects where id = $1", [project]);
    }
  }, 60_000);
});

// --- Permissions ---------------------------------------------------------------------------

describe("file permissions", () => {
  it("keeps the buffer private to the account that wrote it", () => {
    runGuard({ env: { STUB_EXIT: "7" } });
    const mode = statSync(bufferPath()).mode & 0o777;
    if (process.platform === "win32") {
      // MSYS synthesises POSIX modes from Windows ACLs, so the number here
      // says nothing about the target. UNVERIFIED on this platform, and said
      // out loud rather than asserted into a false pass.
      console.warn(
        `guard-script.test.ts: buffer mode is ${mode.toString(8)} on win32 — ` +
          "the 0600 requirement is UNVERIFIED on this platform.",
      );
      expect(existsSync(bufferPath())).toBe(true);
      return;
    }
    expect(mode & 0o077).toBe(0);
  });
});
