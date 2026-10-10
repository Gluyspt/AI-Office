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
//
// Four levels: packages/server/src/core/config.ts -> repo root. This count
// is tied to this file's depth — it was three before config.ts moved into
// src/core/, and the symptom of getting it wrong is every config value
// reading as unset, which looks like a missing .env rather than a bad path.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
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
  /**
   * An operator override that can only LOWER the measured limit. Optional
   * and with no default since 2026-10-07: tmux's own command-length limit
   * was measured at ~16.3 KB *of whole command*, so the real maximum
   * depends on the session name and is computed per call by
   * `maxMessageBytesFor` in shell-quote.ts. A flat default here was 131 072
   * — the Linux execve ceiling — which is eight times too high and cannot
   * express the name dependency at all.
   */
  readonly maxMessageBytes?: number;
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
// No DEFAULT_TMUX_MAX_MESSAGE_BYTES any more. The limit is measured and
// name-dependent (shell-quote.ts, TMUX_COMMAND_BYTE_LIMIT); a constant here
// could only repeat it wrongly or override it upward.

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
  // Unset means "use the measured per-session-name limit". Set means
  // "tighten it to this"; the adapter takes the lower of the two, so this
  // can never raise the ceiling above what tmux will actually accept.
  const maxMessageBytes =
    readString(reader, "TMUX_MAX_MESSAGE_BYTES") === undefined
      ? undefined
      : optionalInt(reader, "TMUX_MAX_MESSAGE_BYTES", 1, 1);
  const sessionCols = optionalInt(reader, "TMUX_SESSION_COLS", DEFAULT_TMUX_SESSION_COLS, 20);
  const sessionRows = optionalInt(reader, "TMUX_SESSION_ROWS", DEFAULT_TMUX_SESSION_ROWS, 5);
  finish(reader);
  return {
    agentUsers,
    tmuxPath,
    sudoPath,
    commandTimeoutMs,
    readyTimeoutMs,
    ...(maxMessageBytes === undefined ? {} : { maxMessageBytes }),
    sessionCols,
    sessionRows,
  };
}

// --- File-scope locks (ticket 015, features/locks/registry.ts) ----------------
//
// Appended as a self-contained loadXConfig() section, per the manifest
// exception in docs/tasks/README.md: ticket 004 owns this file but cannot
// invent a validation shape for a ticket that did not exist when it
// shipped. Editing an existing section, the shared readers or ConfigError
// still belongs to 004.

export interface LocksConfig {
  /** How long an acquired file lock survives without a heartbeat. */
  readonly ttlSeconds: number;
}

/**
 * LOCK_TTL_SECONDS is **required with no default**, deliberately.
 *
 * The TTL is one of the design's own open questions, and ticket 015's
 * ticket says not to let it default to something comfortable: SessionEnd is
 * the path that normally releases a lock, but whether `tmux kill-session`
 * fires SessionEnd through `sudo -u` is still unmeasured on the target
 * host. If it does not, this value stops being a backstop and becomes the
 * primary release path — and a number nobody chose would then decide how
 * long a dead agent keeps its files. Refusing to start is the honest
 * behaviour.
 */
export function loadLocksConfig(env: NodeJS.ProcessEnv = process.env): LocksConfig {
  const reader: Reader = { env, problems: [] };
  const ttlSeconds = requiredInt(reader, "LOCK_TTL_SECONDS", 1);
  finish(reader);
  return { ttlSeconds };
}

// --- Ticket 008: the session registry ------------------------------------------
//
// Appended per the manifest exception in docs/tasks/README.md: a later
// ticket may add its own self-contained `loadXConfig()`; editing an existing
// section or the shared helpers still belongs to 004.

export interface SessionsConfig {
  /**
   * How long `startSession` waits for the first hook event carrying the
   * session id it chose, before marking the row `failed`.
   *
   * **Required, with no default.** This is not a tuning knob, it is the
   * window in which the worst failure shape in the system is caught: an
   * agent launched without `NODE_EXTRA_CA_CERTS` works perfectly and is
   * completely invisible to the orchestrator, because every hook fails its
   * TLS handshake and nothing crashes. A value chosen by nobody would
   * decide how long the orchestrator waits before noticing it is blind.
   *
   * Set it from measurement, not taste. On the target host 2026-10-07 a
   * session reached its composer in seconds, not milliseconds, and the host
   * clock was observed stepping backwards twice — so a tight value will
   * produce false failures. Several seconds is the right order.
   */
  readonly hookArrivalTimeoutMs: number;
}

export function loadSessionsConfig(env: NodeJS.ProcessEnv = process.env): SessionsConfig {
  const reader: Reader = { env, problems: [] };
  const hookArrivalTimeoutMs = requiredInt(reader, "SESSION_HOOK_ARRIVAL_TIMEOUT_MS", 1);
  finish(reader);
  return { hookArrivalTimeoutMs };
}

// --- Ticket 010: chat transcript and the turn-end watchdog ----------------------
//
// Appended per the manifest exception in docs/tasks/README.md: a later
// ticket may add its own self-contained `loadXConfig()`; editing an existing
// section, the shared readers or ConfigError still belongs to 004.

export interface ChatConfig {
  /**
   * How long after a turn starts the orchestrator gives up waiting for a
   * turn-end event, and marks the turn abandoned so the desk stops showing
   * as busy.
   *
   * **Required, with no default**, and the reason is a measurement rather
   * than a preference.
   *
   * A turn can end with **no turn-end event at all**. Two independent paths
   * were observed, each twice: an `Escape` interrupt, and a `PreToolUse`
   * answered `continue:false`. Neither fires `Stop` *or* `StopFailure` — the
   * only event for an interrupted turn is the `UserPromptSubmit` that opened
   * it. So `Stop` is not a bookend, and this value is how long a desk sits
   * "thinking" after someone hits Escape.
   *
   * Do NOT set it from the reply-latency numbers. Those exist (20 trials on
   * the target host: p50 2176 ms, p95 2888 ms) but they measure a one-word
   * reply and bound nothing — a real agent turn runs for minutes. The
   * number has to be larger than the longest turn anyone is willing to
   * believe in, because firing early reports a *working* agent as idle,
   * which is precisely the failure spike 003 found in pane scraping and
   * which this watchdog exists to replace. Several minutes is the right
   * order; measure a real workload before tightening it.
   *
   * Note also that the target host's wall clock was observed stepping
   * backwards twice in one session. The watchdog therefore times with
   * `performance.now()`, not `Date.now()` — but a value chosen tightly
   * would still be the first thing a clock step broke.
   */
  readonly turnWatchdogMs: number;
}

export function loadChatConfig(env: NodeJS.ProcessEnv = process.env): ChatConfig {
  const reader: Reader = { env, problems: [] };
  const turnWatchdogMs = requiredInt(reader, "CHAT_TURN_WATCHDOG_MS", 1);
  finish(reader);
  return { turnWatchdogMs };
}

// --- Ticket 009: role definitions and hook config provisioning ---------------
//
// Appended per the manifest exception in docs/tasks/README.md: a later ticket
// may add its own self-contained `loadXConfig()`. This section adds nothing to
// ConfigError, the shared readers, or any section above it; it reads
// POSIX_USERNAME_RE and the readers declared above, which the 005 and 007
// sections already established as shared rather than owned.
//
// OFFICE_HOOK_TOKENS is the map 005's section promised and could not write:
// "there is no user table yet, so this ticket treats it as a flat set of
// opaque accepted tokens ... ticket 009, which provisions each role's hook
// URLs, is what gives each token a person." HOOK_INGEST_TOKENS stays the
// accepted *set* the server checks; this is the account -> token assignment
// the provisioner needs to render one account's hook URLs. Provisioning
// refuses a token that is not also in HOOK_INGEST_TOKENS, because the symptom
// otherwise is every hook 401ing and every session failing its hook gate with
// no indication that the two lists disagree.
//
// No default, and no fabricated token: a generated-on-the-fly token would
// differ between the server process and the provisioner, which is the same
// failure with extra steps.
export interface ProvisioningConfig {
  /** https origin of the event server, no trailing slash. */
  readonly eventServerOrigin: string;
  /** Linux account -> that account's hook ingest token. */
  readonly hookTokens: Readonly<Record<string, string>>;
  /**
   * The certificate agents are told to trust — exported into every agent's
   * environment as NODE_EXTRA_CA_CERTS. With a self-signed event-server cert
   * this is that same file: spike 001 §12 measured the hook client rejecting
   * it outright (`tlsv1 alert unknown ca`) and this variable fixing it
   * completely.
   */
  readonly agentCaCertPath: string;
  /** Provisioning warns below this many days left on the certificate. */
  readonly certMinRemainingDays: number;
  /** Domain for agent git identities. Never a routable one — see provision.ts. */
  readonly gitEmailDomain: string;
}

// 30 days is a warning threshold, not a measurement: one shared certificate
// means every agent in the office goes silent on the same day it expires, and
// a rotation needs every running agent restarted, so the warning has to arrive
// while someone can still schedule that.
const DEFAULT_CERT_MIN_REMAINING_DAYS = 30;
// RFC 2606 reserves .invalid precisely so an address can be guaranteed
// undeliverable. An agent's commits must not be able to mail a real person.
const DEFAULT_GIT_EMAIL_DOMAIN = "ai-office.invalid";
// URL-safe characters only: the token is carried in the hook URL's query
// string, so anything needing escaping would arrive at ingest as a different
// string than was provisioned, and the 401 would name nothing.
const HOOK_TOKEN_RE = /^[A-Za-z0-9._~-]{16,}$/;

export function loadProvisioningConfig(env: NodeJS.ProcessEnv = process.env): ProvisioningConfig {
  const reader: Reader = { env, problems: [] };

  // Derived from EVENT_SERVER_PORT rather than required separately, so the
  // hook URLs cannot disagree with the port the server actually binds. An
  // explicit override is still accepted for a host that fronts the event
  // server differently.
  let eventServerOrigin = readString(reader, "OFFICE_EVENT_SERVER_ORIGIN");
  if (eventServerOrigin === undefined) {
    const port = requiredInt(reader, "EVENT_SERVER_PORT", 1);
    eventServerOrigin = `https://127.0.0.1:${port}`;
  }
  if (!eventServerOrigin.startsWith("https://")) {
    // Every endpoint in this system is https, loopback included. A plaintext
    // origin here would be a silent downgrade of that decision for every hook
    // in the office.
    reader.problems.push(
      `OFFICE_EVENT_SERVER_ORIGIN must start with https:// — got ${JSON.stringify(eventServerOrigin)}`,
    );
  }
  if (eventServerOrigin.endsWith("/")) {
    reader.problems.push(
      "OFFICE_EVENT_SERVER_ORIGIN must not end with a slash — endpoint paths are appended to it",
    );
  }

  const tokensRaw = requiredString(reader, "OFFICE_HOOK_TOKENS");
  const hookTokens: Record<string, string> = {};
  for (const pair of tokensRaw.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "")) {
    const separator = pair.indexOf(":");
    if (separator <= 0 || separator === pair.length - 1) {
      reader.problems.push(
        `OFFICE_HOOK_TOKENS entries must be <user>:<token> — got ${JSON.stringify(pair)}`,
      );
      continue;
    }
    const user = pair.slice(0, separator).trim();
    const token = pair.slice(separator + 1).trim();
    if (!POSIX_USERNAME_RE.test(user)) {
      reader.problems.push(`OFFICE_HOOK_TOKENS has an invalid account name: ${JSON.stringify(user)}`);
      continue;
    }
    if (!HOOK_TOKEN_RE.test(token)) {
      // Deliberately not echoed: it is a secret, and the one thing worth
      // saying about it is which account's it is.
      reader.problems.push(
        `OFFICE_HOOK_TOKENS token for ${user} must be at least 16 URL-safe characters ([A-Za-z0-9._~-])`,
      );
      continue;
    }
    if (hookTokens[user] !== undefined) {
      reader.problems.push(`OFFICE_HOOK_TOKENS lists ${user} twice`);
      continue;
    }
    hookTokens[user] = token;
  }
  if (tokensRaw !== "" && Object.keys(hookTokens).length === 0) {
    reader.problems.push("OFFICE_HOOK_TOKENS must assign a token to at least one account");
  }

  const agentCaCertPath =
    readString(reader, "OFFICE_AGENT_CA_CERT_PATH") ?? requiredString(reader, "TLS_CERT_PATH");
  const certMinRemainingDays = optionalInt(
    reader,
    "OFFICE_CERT_MIN_REMAINING_DAYS",
    DEFAULT_CERT_MIN_REMAINING_DAYS,
    0,
  );
  const gitEmailDomain = readString(reader, "OFFICE_GIT_EMAIL_DOMAIN") ?? DEFAULT_GIT_EMAIL_DOMAIN;

  finish(reader);
  return {
    eventServerOrigin,
    hookTokens,
    agentCaCertPath,
    certMinRemainingDays,
    gitEmailDomain,
  };
}

// --- Ticket 028: pause, emergency stop and resume -------------------------------
//
// Appended per the manifest exception: a later ticket may add its own
// self-contained `loadXConfig()`. Editing an existing section still belongs
// to 004.

export interface PauseConfig {
  /**
   * How long a graceful pause waits for agents to stop on their own before
   * it reports which ones did not.
   *
   * Optional with a default, unlike the hook-arrival timeout: overshooting
   * here is visible and harmless — the pause is already in effect and the
   * deadline only decides when the UI stops saying "waiting" and starts
   * naming the agents still mid-turn. Nothing is killed when it expires.
   *
   * 30 s is chosen from measurement rather than taste: on the target host a
   * reply takes p50 2.2 s and p95 2.9 s, and the longest observed turn in
   * the spike ran to ~8.6 s, so 30 s covers an ordinary turn several times
   * over without making a human watch a spinner for a minute.
   */
  readonly deadlineMs: number;
}

const DEFAULT_PAUSE_DEADLINE_MS = 30_000;

export function loadPauseConfig(env: NodeJS.ProcessEnv = process.env): PauseConfig {
  const reader: Reader = { env, problems: [] };
  const deadlineMs = optionalInt(reader, "PAUSE_DEADLINE_MS", DEFAULT_PAUSE_DEADLINE_MS, 1);
  finish(reader);
  return { deadlineMs };
}

export interface ResumeSpawnConfig {
  /** Where project working trees live on the agent host. */
  readonly projectRoot: string;
  /**
   * Absolute path to the Claude Code binary **on the agent host**.
   *
   * REQUIRED, with no default, and absolute on purpose. Two measured facts
   * force both:
   *
   *  - A bare `claude` does not work. tmux runs its command through a
   *    NON-interactive shell, and Ubuntu's stock `.bashrc` returns early
   *    when not interactive, so `~/.local/bin` never joins `PATH`. The pane
   *    dies instantly with an EMPTY capture — indistinguishable from a slow
   *    start.
   *  - The path is **host configuration, not a function of the user**. On
   *    the target it is a system-wide `/usr/local/bin/claude`, and no
   *    per-account `~/.local/bin/claude` exists at all. Deriving it from the
   *    target user — which ticket 007 originally specified — would produce
   *    ENOENT on every spawn wearing that same empty-capture symptom.
   *
   * Lives here rather than in `loadTmuxConfig` because resume is the first
   * code path that needs to *choose* a binary for a session it did not
   * start; the adapter is handed one.
   */
  readonly claudeBin: string;
}

export function loadResumeSpawnConfig(env: NodeJS.ProcessEnv = process.env): ResumeSpawnConfig {
  const reader: Reader = { env, problems: [] };
  const projectRoot = requiredString(reader, "PROJECT_ROOT");
  const claudeBin = requiredString(reader, "CLAUDE_BIN");
  finish(reader);
  return { projectRoot, claudeBin };
}

// --- Ticket 020: the PreToolUse ownership guard ---------------------------------
//
// Appended per the manifest exception: a later ticket may add its own
// self-contained `loadXConfig()`. Editing an existing section, the shared
// readers or ConfigError still belongs to 004.

export interface GuardConfig {
  /**
   * The guard's whole budget, in milliseconds, including the database work.
   *
   * ~2 s is the ticket's decided fail-open deadline and it is a *hook*
   * timeout first: spike 001 measured the default at 30 s and the turn held
   * for all of it, so `"timeout": 2` is set explicitly on the hook entry in
   * config/hooks/fragments/pretooluse-guard.json. This value is the server
   * half of the same number — `POST /guard/check` abandons its own check and
   * answers "allow" rather than letting the agent's client hit that timeout,
   * because a timeout at the client is indistinguishable from an unreachable
   * orchestrator and loses the chance to say why.
   *
   * Optional with a default, unlike LOCK_TTL_SECONDS. Nothing is chosen by
   * this number that cannot be seen: too low and the guard fails open and
   * says so in an event; too high and the hook timeout catches it anyway. The
   * value that MUST be set deliberately is the hook entry's, and that lives
   * in the fragment where an operator reads it beside the URL.
   */
  readonly checkTimeoutMs: number;
  /**
   * Largest number of buffered edits one flush may carry.
   *
   * The buffer is size-capped on the agent's box too (it drops oldest-first
   * and reports the count), so this is the second of two caps rather than the
   * only one. It exists because the script's cap is configurable on a machine
   * the orchestrator does not control: an agent box with a cap of a million
   * must not be able to hand the server a million-row insert while someone is
   * trying to recover from an outage.
   */
  readonly flushMaxEdits: number;
}

const DEFAULT_GUARD_CHECK_TIMEOUT_MS = 2_000;
const DEFAULT_GUARD_FLUSH_MAX_EDITS = 1_000;

export function loadGuardConfig(env: NodeJS.ProcessEnv = process.env): GuardConfig {
  const reader: Reader = { env, problems: [] };
  const checkTimeoutMs = optionalInt(
    reader,
    "GUARD_CHECK_TIMEOUT_MS",
    DEFAULT_GUARD_CHECK_TIMEOUT_MS,
    1,
  );
  const flushMaxEdits = optionalInt(
    reader,
    "GUARD_FLUSH_MAX_EDITS",
    DEFAULT_GUARD_FLUSH_MAX_EDITS,
    1,
  );
  finish(reader);
  return { checkTimeoutMs, flushMaxEdits };
}
