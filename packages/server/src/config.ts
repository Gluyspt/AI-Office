// Centralized environment parsing for @office/server.
//
// This file owns every environment variable the server package reads (see
// the file ownership map in docs/tasks/README.md — no later ticket may edit
// this file, so anything a later ticket needs must either already be here
// or be added as a documented gap, not invented ad hoc elsewhere).
//
// Config is grouped into small, independently-validated sections instead of
// one flat object that is required in full the moment anything imports this
// module. That matters concretely for this ticket: the migration runner
// only needs database settings, and must not fail to start just because an
// unrelated TLS certificate path isn't set yet. Each `loadXConfig()` reads
// process.env (or an injected env object, for testing) and throws a single
// ConfigError naming every problem it finds, the first time it's called.
//
// TLS: the design decided HTTPS everywhere, including loopback (see
// docs/tasks/README.md "Decisions made"). Ticket 005 stands up the actual
// HTTPS listener, but this file is the only place that will ever parse env
// vars for @office/server, so the cert/key path variables are defined here
// now, required with no default — a dev cert with no path configured is not
// a safe default to fabricate, and 005 cannot add them later without
// violating one-file-one-ticket.
import { config as loadDotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

// dotenv resolves its default `.env` path against process.cwd(). Under pnpm,
// `pnpm migrate` / `pnpm --filter @office/server run <script>` run with cwd
// set to this package's directory, not the repo root where `.env` actually
// lives (see README.md). Resolve relative to this file instead so behaviour
// doesn't depend on which directory a script happened to be invoked from.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
loadDotenv({ path: path.join(repoRoot, ".env") });

export class ConfigError extends Error {
  constructor(problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

interface Reader {
  readonly env: NodeJS.ProcessEnv;
  readonly problems: string[];
}

function readString(reader: Reader, name: string): string | undefined {
  const value = reader.env[name];
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  return value;
}

function requiredString(reader: Reader, name: string): string {
  const value = readString(reader, name);
  if (value === undefined) {
    reader.problems.push(`${name} is required but not set`);
    return "";
  }
  return value;
}

function optionalInt(reader: Reader, name: string, fallback: number, min: number): number {
  const raw = readString(reader, name);
  if (raw === undefined) {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || String(value) !== raw.trim() || value < min) {
    reader.problems.push(`${name} must be an integer >= ${min}, got ${JSON.stringify(raw)}`);
    return fallback;
  }
  return value;
}

function finish(reader: Reader): void {
  if (reader.problems.length > 0) {
    throw new ConfigError(reader.problems);
  }
}

export interface DatabaseConfig {
  readonly url: string;
  readonly poolSize: number;
  readonly statementTimeoutMs: number;
}

// Conventional pg-pool defaults. Not "measured" numbers like the spawn caps
// and lock TTLs flagged elsewhere as needing real data — these are ordinary
// connection-pool tuning with no project-specific basis yet, so a sane
// default that can be overridden beats forcing every environment to set
// them just to run a migration.
const DEFAULT_DATABASE_POOL_SIZE = 10;
const DEFAULT_DATABASE_STATEMENT_TIMEOUT_MS = 5_000;

export function loadDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const reader: Reader = { env, problems: [] };
  const url = requiredString(reader, "DATABASE_URL");
  const poolSize = optionalInt(reader, "DATABASE_POOL_SIZE", DEFAULT_DATABASE_POOL_SIZE, 1);
  const statementTimeoutMs = optionalInt(
    reader,
    "DATABASE_STATEMENT_TIMEOUT_MS",
    DEFAULT_DATABASE_STATEMENT_TIMEOUT_MS,
    0,
  );
  finish(reader);
  return { url, poolSize, statementTimeoutMs };
}

export interface TlsConfig {
  readonly certPath: string;
  readonly keyPath: string;
}

export function loadTlsConfig(env: NodeJS.ProcessEnv = process.env): TlsConfig {
  const reader: Reader = { env, problems: [] };
  const certPath = requiredString(reader, "TLS_CERT_PATH");
  const keyPath = requiredString(reader, "TLS_KEY_PATH");
  finish(reader);
  return { certPath, keyPath };
}

// --- Ticket 005: event server -----------------------------------------------
//
// Appended under the manifest exception recorded in docs/tasks/README.md
// ("A later ticket may append a loadXConfig() to config.ts") — 004 owns this
// file permanently, but had no way to validate a variable ticket 005 is the
// first to read. This section does not touch ConfigError or either
// loadXConfig() above.
//
// EVENT_SERVER_PORT has no default (like DATABASE_URL and the TLS paths
// above) — a port genuinely has no safe value to fabricate, and
// .env.example documents it without the "Optional — defaults to..." wording
// used for values that do have one.
//
// HOOK_INGEST_TOKENS exists because of this ticket's binding "Decided"
// finding (spike 002): hook POSTs carry no authentication or signature, so
// anything that can reach the port can forge any event for any session_id.
// TLS authenticates the *server* to the client, the wrong direction; the
// mitigation is binding loopback only (enforced in server.ts, not
// configurable — there is no "trusted non-loopback" mode to opt into) plus a
// per-user token carried in the hook URL's query string, which the spike
// verified survives the hook call intact. There is no user table yet
// (that's later steps' access-control work), so this ticket treats it as a
// flat set of opaque accepted tokens rather than a token-to-user map;
// ticket 009, which provisions each role's hook URLs, is what gives each
// token a person.
export interface ServerConfig {
  readonly port: number;
  readonly hookIngestTokens: readonly string[];
}

function requiredInt(reader: Reader, name: string, min: number): number {
  const raw = requiredString(reader, name);
  if (raw === "") {
    // requiredString already recorded the "missing" problem.
    return 0;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || String(value) !== raw.trim() || value < min) {
    reader.problems.push(`${name} must be an integer >= ${min}, got ${JSON.stringify(raw)}`);
    return 0;
  }
  return value;
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const reader: Reader = { env, problems: [] };
  const port = requiredInt(reader, "EVENT_SERVER_PORT", 1);
  const tokensRaw = requiredString(reader, "HOOK_INGEST_TOKENS");
  const hookIngestTokens = tokensRaw
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokensRaw !== "" && hookIngestTokens.length === 0) {
    reader.problems.push("HOOK_INGEST_TOKENS must contain at least one non-empty token");
  }
  finish(reader);
  return { port, hookIngestTokens };
}

// --- Ticket 006: WebSocket fan-out -------------------------------------------
//
// Appended under the manifest exception recorded in docs/tasks/README.md
// ("A later ticket may append a loadXConfig() to config.ts") — 004 owns this
// file permanently; this section does not touch ConfigError or any
// loadXConfig() above, and reuses the same Reader/optionalInt/finish helpers
// ticket 005's section above already established as shared, not owned by
// either ticket.
//
// All three values have safe defaults, unlike EVENT_SERVER_PORT and
// HOOK_INGEST_TOKENS above (which have none because a port or a secret has
// no fabricatable safe value). These are the opposite case: the ticket's own
// "Decided" section fixes the heartbeat at 30s, and the backpressure limit
// is ordinary tuning with no project-specific measurement behind it yet —
// see docs/tasks/README.md's "Still open" table for the numbers that
// genuinely have no default yet (spawn caps, memory floor, lock TTL, pause
// deadline). A default that a test can override to a short interval (so a
// heartbeat test doesn't wait 60s+ real time) beats forcing every
// environment to set these just to start the server.
export interface WsConfig {
  readonly heartbeatIntervalMs: number;
  readonly heartbeatMaxMissedPongs: number;
  readonly backpressureLimitBytes: number;
}

const DEFAULT_WS_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_WS_HEARTBEAT_MAX_MISSED_PONGS = 2;
const DEFAULT_WS_BACKPRESSURE_LIMIT_BYTES = 1_000_000;

export function loadWsConfig(env: NodeJS.ProcessEnv = process.env): WsConfig {
  const reader: Reader = { env, problems: [] };
  const heartbeatIntervalMs = optionalInt(
    reader,
    "WS_HEARTBEAT_INTERVAL_MS",
    DEFAULT_WS_HEARTBEAT_INTERVAL_MS,
    1,
  );
  const heartbeatMaxMissedPongs = optionalInt(
    reader,
    "WS_HEARTBEAT_MAX_MISSED_PONGS",
    DEFAULT_WS_HEARTBEAT_MAX_MISSED_PONGS,
    1,
  );
  const backpressureLimitBytes = optionalInt(
    reader,
    "WS_BACKPRESSURE_LIMIT_BYTES",
    DEFAULT_WS_BACKPRESSURE_LIMIT_BYTES,
    1,
  );
  finish(reader);
  return { heartbeatIntervalMs, heartbeatMaxMissedPongs, backpressureLimitBytes };
}

// --- Ticket 007: tmux adapter ------------------------------------------------
//
// Appended under the manifest exception recorded in docs/tasks/README.md
// ("A later ticket may append a loadXConfig() to config.ts") — 004 owns
// this file permanently; this section adds nothing to ConfigError, the
// shared readers, or any loadXConfig() above.
//
// TMUX_AGENT_USERS is the security-relevant one and has **no default on
// purpose**. It is the adapter's allowlist of accounts it may pass to
// `sudo -u`, and it must mirror `deploy/sudoers.d/office` line for line.
// The adapter never takes that target from a request: a user-supplied
// value reaching `sudo -u` is the failure this whole ticket exists to
// prevent, so the set of legal targets is configuration, and an unknown
// one is refused before a process is spawned. The design's example
// accounts (`gluy`, `user2`, `user3`) are placeholders — whether they
// exist on the target VPS is an open question on ticket 007 — which is a
// second reason there is nothing safe to default to.
//
// TMUX_BIN must match the sudoers rule's path byte for byte: sudo matches
// the permitted command by literal path, so `/usr/bin/tmux` and
// `/bin/tmux` are different grants even when they are the same binary.
//
// The three timeouts and the geometry all have defaults, and all of them
// are *chosen*, not measured — see the comment on each. Nothing in
// docs/spikes/002-tmux-tui-control.md measures a tmux command's own
// latency under sudo, because that spike ran with no sudo in the path at
// all (§7, DEFERRED). The VPS re-measurement is the ticket criterion that
// replaces these.
export interface TmuxConfig {
  readonly agentUsers: readonly string[];
  readonly tmuxPath: string;
  readonly sudoPath: string;
  readonly commandTimeoutMs: number;
  readonly readyTimeoutMs: number;
  readonly maxMessageBytes: number;
  readonly sessionCols: number;
  readonly sessionRows: number;
}

// A tmux client command (`send-keys`, `has-session`, `kill-session`)
// returns in milliseconds; 10s is a generous ceiling whose only job is to
// stop a wedged `sudo` from parking a promise forever.
const DEFAULT_TMUX_COMMAND_TIMEOUT_MS = 10_000;
// A first launch in an unseen directory has to get past a folder-trust
// dialog, and a fresh CLAUDE_CONFIG_DIR past onboarding modals
// (docs/spikes/001-hook-payloads.md §8.1). Spike 002's harness waited 90s
// and still timed out once for an unrelated reason. 120s is deliberately
// slack: the cost of waiting is a slow spawn, the cost of giving up early
// is a brief typed into a modal.
const DEFAULT_TMUX_READY_TIMEOUT_MS = 120_000;
// Linux MAX_ARG_STRLEN — a kernel ceiling, NOT a measurement of what the
// TUI accepts. See EXECVE_ARG_BYTE_LIMIT in orchestrator/shell-quote.ts
// for why the real limit is still unknown and why this is configurable.
const DEFAULT_TMUX_MAX_MESSAGE_BYTES = 131_072;
// Matches the geometry spike 002's harness drove the TUI at. Pane width
// changes how Claude Code wraps its own output, and the readiness check
// reads the pane, so this is not a free parameter.
const DEFAULT_TMUX_SESSION_COLS = 200;
const DEFAULT_TMUX_SESSION_ROWS = 50;

// POSIX-portable account name. Defence in depth only: the allowlist is the
// actual control, and this rejects a config entry that could never be a
// real account before it can become an argv element.
const POSIX_USERNAME_RE = /^[a-z_][a-z0-9_-]{0,31}\$?$/;

export function loadTmuxConfig(env: NodeJS.ProcessEnv = process.env): TmuxConfig {
  const reader: Reader = { env, problems: [] };
  const usersRaw = requiredString(reader, "TMUX_AGENT_USERS");
  const agentUsers = usersRaw
    .split(",")
    .map((user) => user.trim())
    .filter((user) => user.length > 0);
  if (usersRaw !== "" && agentUsers.length === 0) {
    reader.problems.push("TMUX_AGENT_USERS must contain at least one account name");
  }
  for (const user of agentUsers) {
    if (!POSIX_USERNAME_RE.test(user)) {
      reader.problems.push(`TMUX_AGENT_USERS contains an invalid account name: ${JSON.stringify(user)}`);
    }
    if (user === "root") {
      reader.problems.push("TMUX_AGENT_USERS must not contain root — the orchestrator never runs agents as root");
    }
  }
  const tmuxPath = readString(reader, "TMUX_BIN") ?? "/usr/bin/tmux";
  const sudoPath = readString(reader, "SUDO_BIN") ?? "/usr/bin/sudo";
  const commandTimeoutMs = optionalInt(
    reader,
    "TMUX_COMMAND_TIMEOUT_MS",
    DEFAULT_TMUX_COMMAND_TIMEOUT_MS,
    1,
  );
  const readyTimeoutMs = optionalInt(reader, "TMUX_READY_TIMEOUT_MS", DEFAULT_TMUX_READY_TIMEOUT_MS, 1);
  const maxMessageBytes = optionalInt(
    reader,
    "TMUX_MAX_MESSAGE_BYTES",
    DEFAULT_TMUX_MAX_MESSAGE_BYTES,
    1,
  );
  const sessionCols = optionalInt(reader, "TMUX_SESSION_COLS", DEFAULT_TMUX_SESSION_COLS, 20);
  const sessionRows = optionalInt(reader, "TMUX_SESSION_ROWS", DEFAULT_TMUX_SESSION_ROWS, 5);
  finish(reader);
  return {
    agentUsers,
    tmuxPath,
    sudoPath,
    commandTimeoutMs,
    readyTimeoutMs,
    maxMessageBytes,
    sessionCols,
    sessionRows,
  };
}
