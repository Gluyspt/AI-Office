// Process entry point: builds the app, listens over HTTPS on loopback only,
// wires up the TLS-handshake-rejection instrumentation this ticket's
// "Decided" section requires, and shuts down gracefully.
//
// Binds 127.0.0.1, never 0.0.0.0 — the loopback half of this ticket's
// forgeable-ingest mitigation (see routes/events.ts and config.ts's
// HOOK_INGEST_TOKENS section for the other half). There is no environment
// variable to widen this; loopback-only is not configurable on purpose.
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.ts";
import { loadServerConfig } from "./config.ts";
import { pool } from "./db/pool.ts";
import { recordSystemEvent } from "./events/ingest.ts";

const LOOPBACK_HOST = "127.0.0.1";

/**
 * Spike 002 (§12) proved a client that refuses the server's certificate
 * produces *no request at all* — byte-for-byte indistinguishable from a
 * hook that never fired. This wires up the distinct, greppable log line
 * (fixed "TLS_HANDSHAKE_REJECTED" prefix) plus the event this ticket's
 * acceptance criteria require: logged, and published so ticket 022's
 * degraded banner and ticket 008's spawn self-test have something to key
 * on. Node exposes this as the server's own `tlsClientError` event —
 * spikes/hooks/echo-server.mjs is the reference this mirrors.
 *
 * Exported (not inlined in main()) so the integration test exercises the
 * exact same code path a real rollout runs, instead of a re-implementation.
 */
export function installTlsErrorLogging(app: FastifyInstance): void {
  app.server.on("tlsClientError", (err: NodeJS.ErrnoException, socket) => {
    const peer = `${socket.remoteAddress ?? "unknown"}:${socket.remotePort ?? "?"}`;
    const reason = err.message;
    const code = err.code ?? "UNKNOWN";
    console.error(`TLS_HANDSHAKE_REJECTED peer=${peer} code=${code} reason=${JSON.stringify(reason)}`);
    recordSystemEvent("TlsHandshakeRejected", {
      peer,
      code,
      message: reason,
      at: new Date().toISOString(),
    }).catch((recordError: unknown) => {
      console.error("failed to record TlsHandshakeRejected event", recordError);
    });
  });
}

export async function main(): Promise<void> {
  const config = loadServerConfig();
  const app = await buildApp();

  installTlsErrorLogging(app);

  await app.listen({ port: config.port, host: LOOPBACK_HOST });
  console.log(`event server listening on https://${LOOPBACK_HOST}:${config.port}`);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`received ${signal}, shutting down`);
    Promise.resolve()
      .then(async () => {
        await app.close();
        await pool.end();
      })
      .then(
        () => process.exit(0),
        (error: unknown) => {
          console.error("error during shutdown", error);
          process.exit(1);
        },
      );
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// Same "invoked directly vs imported" check as db/migrate.ts, so importing
// this module from a test never accidentally starts a real listener.
const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
