// The Fastify app: builds an HTTPS-only instance (every endpoint in this
// system is https, loopback included — see docs/tasks/README.md "Decisions
// made") and autoloads every route module under src/routes/. Adding an
// endpoint means adding a file there; this file never needs an edit for it
// — see README.md's "Extension points" and the file ownership map's note
// that this convention is established here.
//
// This module only builds the app (readFileSync'ing the TLS material,
// registering routes). It does not listen — that's server.ts, so a test can
// build an app and use Fastify's `.inject()` without ever opening a real
// socket or needing a TLS-trusting HTTP client.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Fastify, { type FastifyInstance, type FastifyPluginAsync } from "fastify";
import { loadTlsConfig } from "./config.ts";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const routesDir = path.join(moduleDir, "routes");

function isRouteModuleFile(name: string): boolean {
  if (!name.endsWith(".ts") && !name.endsWith(".js")) return false;
  if (name.endsWith(".test.ts") || name.endsWith(".test.js")) return false;
  if (name.endsWith(".d.ts")) return false;
  return true;
}

async function autoloadRoutes(app: FastifyInstance, dir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  const files = entries.filter(isRouteModuleFile).sort();
  for (const file of files) {
    const mod = (await import(pathToFileURL(path.join(dir, file)).href)) as {
      default?: FastifyPluginAsync;
    };
    if (typeof mod.default !== "function") {
      throw new Error(`route module ${file} must have a default export function(app)`);
    }
    await app.register(mod.default);
  }
}

export interface BuildAppOptions {
  /** Override for tests that want to autoload a scratch routes directory
   * instead of (or in addition to needing) the real one. Defaults to
   * src/routes/ next to this file. */
  readonly routesDir?: string;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const tls = loadTlsConfig();
  const [key, cert] = await Promise.all([readFile(tls.keyPath), readFile(tls.certPath)]);

  const app = Fastify({
    https: { key, cert },
    logger: false,
  });

  // Hook POSTs are unauthenticated JSON with content-type: application/json
  // (spike §5, "Transport facts"), but a malformed body must be
  // dead-lettered by events/ingest.ts, not rejected by Fastify's own JSON
  // parser before a route handler ever runs. This passes every body through
  // untouched, of any content-type, so JSON.parse happens exactly once, in
  // ingest.ts, where a parse failure is a data path (dead-letter) rather
  // than a framework-level 400/415.
  //
  // Fastify registers a built-in default parser for "application/json"
  // (and "text/plain") that runs JSON.parse itself and 400s on failure
  // *before* any route handler sees the body. Registering a parser for "*"
  // alone does not override that default — it only catches content-types
  // with no specific parser — so "application/json" needs its own
  // raw-passthrough registration too.
  const passthrough = (_request: unknown, body: string, done: (err: null, body: string) => void): void => {
    done(null, body);
  };
  app.addContentTypeParser("application/json", { parseAs: "string" }, passthrough);
  app.addContentTypeParser("*", { parseAs: "string" }, passthrough);

  await autoloadRoutes(app, options.routesDir ?? routesDir);

  return app;
}
