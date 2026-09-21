// app.ts: the /events/* endpoints respond to real captured payloads via
// Fastify's inject() (no real socket/TLS needed to exercise route logic),
// and the route-autoload extension point works with no edit to app.ts.
import { randomUUID } from "node:crypto";
import { writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { EVENT_ENDPOINTS } from "@office/shared/events";
import { buildApp } from "./app.ts";
import { loadServerConfig } from "./config.ts";
import { pool } from "./db/pool.ts";

const routesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "routes");

function firstToken(): string {
  const { hookIngestTokens } = loadServerConfig();
  const token = hookIngestTokens[0];
  if (!token) throw new Error("HOOK_INGEST_TOKENS is empty in test env — set it in .env");
  return token;
}

async function cleanupBySessionId(sessionId: string): Promise<void> {
  await pool.query("delete from events where session_id = $1", [sessionId]);
}

describe("POST /events/<slug> — each of the design's eight endpoints", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  for (const [slug, eventNames] of Object.entries(EVENT_ENDPOINTS)) {
    const hookEventName = eventNames[0];
    it(`accepts a POST to /events/${slug} (${hookEventName}) and returns 2xx`, async () => {
      app = await buildApp();
      const sessionId = randomUUID();
      const response = await app.inject({
        method: "POST",
        url: `/events/${slug}?token=${firstToken()}`,
        payload: JSON.stringify({ hook_event_name: hookEventName, session_id: sessionId }),
        headers: { "content-type": "application/json" },
      });
      expect(response.statusCode).toBeGreaterThanOrEqual(200);
      expect(response.statusCode).toBeLessThan(300);
      const body = JSON.parse(response.body) as { type: string };
      expect(body.type).toBe(hookEventName);
      await cleanupBySessionId(sessionId);
    });
  }

  it("rejects a request with no token", async () => {
    app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/events/reply",
      payload: JSON.stringify({ hook_event_name: "Stop", session_id: randomUUID() }),
      headers: { "content-type": "application/json" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("still returns 2xx for a malformed body (dead-lettered), never stalling the caller", async () => {
    app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: `/events/tool?token=${firstToken()}`,
      payload: "{not json",
      headers: { "content-type": "application/json" },
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(200);
    expect(response.statusCode).toBeLessThan(300);
    const body = JSON.parse(response.body) as { type: string };
    expect(body.type).toBe("unparsed");
  });
});

describe("GET /events", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    if (app) await app.close();
  });

  it("returns stored events as JSON", async () => {
    app = await buildApp();
    const sessionId = randomUUID();
    await app.inject({
      method: "POST",
      url: `/events/reply?token=${firstToken()}`,
      payload: JSON.stringify({ hook_event_name: "Stop", session_id: sessionId }),
      headers: { "content-type": "application/json" },
    });
    const response = await app.inject({ method: "GET", url: "/events?limit=5" });
    expect(response.statusCode).toBe(200);
    const rows = JSON.parse(response.body) as Array<{ sessionId: string }>;
    expect(rows.some((r) => r.sessionId === sessionId)).toBe(true);
    await cleanupBySessionId(sessionId);
  });
});

describe("route autoload extension point", () => {
  const tempRoutePath = path.join(routesDir, "__temp_extension_point_test_route__.ts");
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
    await rm(tempRoutePath, { force: true });
  });

  it("serves a route dropped into src/routes/ with no edit to app.ts", async () => {
    const moduleSource = `
export default async function tempRoute(app) {
  app.get("/__temp_extension_point_test_route__", async () => ({ marker: "extension-point" }));
}
`;
    await writeFile(tempRoutePath, moduleSource, "utf8");

    app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/__temp_extension_point_test_route__" });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ marker: "extension-point" });
  });
});
