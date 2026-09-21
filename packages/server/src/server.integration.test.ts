// Real-socket tests: things Fastify's inject() can't exercise because it
// never opens a TLS connection. Both are direct acceptance criteria from
// docs/tasks/005-event-server-ingest.md:
//   - a rejected TLS handshake is logged distinctly and published as an event
//   - ingest responds in under 50ms at p95 across 200 sequential POSTs
import { readFileSync } from "node:fs";
import https from "node:https";
import tls from "node:tls";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.ts";
import { installTlsErrorLogging } from "./server.ts";
import { loadServerConfig, loadTlsConfig } from "./config.ts";
import { pool } from "./db/pool.ts";

let app: FastifyInstance;
let port: number;
let token: string;
const certPem = readFileSync(loadTlsConfig().certPath);

beforeAll(async () => {
  app = await buildApp();
  installTlsErrorLogging(app);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a real TCP address from app.listen");
  }
  port = address.port;
  const config = loadServerConfig();
  const firstToken = config.hookIngestTokens[0];
  if (!firstToken) throw new Error("HOOK_INGEST_TOKENS is empty in test env");
  token = firstToken;
});

afterAll(async () => {
  await app.close();
});

function postJson(path: string, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        ca: certPem,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("TLS handshake rejection is logged distinctly and published as an event", () => {
  it("logs TLS_HANDSHAKE_REJECTED and records a TlsHandshakeRejected event when a client refuses the cert", async () => {
    const errorLines: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errorLines.push(args.map(String).join(" "));
      originalError(...args);
    };

    try {
      // A client with NO ca option uses the default trust store, which does
      // not trust our self-signed dev cert — this reproduces spike 002's
      // "unknown ca" handshake rejection exactly: no ca, loopback IP (not a
      // hostname), so the connection fails at the TLS layer.
      const handshakeFailed = await new Promise<boolean>((resolve) => {
        const socket = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: true }, () => {
          socket.destroy();
          resolve(false);
        });
        socket.on("error", () => resolve(true));
      });
      expect(handshakeFailed).toBe(true);

      // The server-side tlsClientError handler fires asynchronously; give it
      // a moment, then check both the log line and the persisted event.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(errorLines.some((line) => line.includes("TLS_HANDSHAKE_REJECTED"))).toBe(true);

      const result = await pool.query<{ type: string; payload: { code?: string } }>(
        `select type, payload from events where type = 'TlsHandshakeRejected' order by received_at desc limit 1`,
      );
      expect(result.rows.length).toBeGreaterThan(0);
    } finally {
      console.error = originalError;
    }
  });
});

describe("ingest latency", () => {
  it("responds in under 50ms at p95 across 200 sequential POSTs", async () => {
    const N = 200;
    const durations: number[] = [];
    const sessionIds: string[] = [];

    for (let i = 0; i < N; i++) {
      const sessionId = randomUUID();
      sessionIds.push(sessionId);
      const payload = JSON.stringify({ hook_event_name: "PerfTestEvent", session_id: sessionId, i });
      const start = performance.now();
      const response = await postJson(`/events/tool?token=${token}`, payload);
      durations.push(performance.now() - start);
      expect(response.status).toBeGreaterThanOrEqual(200);
      expect(response.status).toBeLessThan(300);
    }

    durations.sort((a, b) => a - b);
    const p95Index = Math.min(durations.length - 1, Math.ceil(0.95 * durations.length) - 1);
    const p95 = durations[p95Index] ?? 0;
    console.log(
      `ingest latency over ${N} sequential POSTs: min=${durations[0]?.toFixed(2)}ms ` +
        `p50=${durations[Math.floor(durations.length / 2)]?.toFixed(2)}ms ` +
        `p95=${p95.toFixed(2)}ms max=${durations[durations.length - 1]?.toFixed(2)}ms`,
    );
    expect(p95).toBeLessThan(50);

    await pool.query("delete from events where session_id = any($1::uuid[])", [sessionIds]);
  }, 30_000);
});
