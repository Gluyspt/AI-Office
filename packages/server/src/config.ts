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
