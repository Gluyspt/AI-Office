// The MCP transport, asserted directly — because the one thing that could
// check it for us is a live Claude Code session, and that costs a human their
// login (spike 003 §8).
//
// Every status code and error code here was read off
// `@modelcontextprotocol/sdk`'s `webStandardStreamableHttp.js`, the reference
// implementation, while it was briefly installed. These tests are what keeps
// the hand-written version honest to it.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ProjectId } from "@office/shared/ids";
import { buildApp } from "../../core/app.ts";
import { pool } from "../../core/db/pool.ts";
import {
  JSON_RPC,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  checkTransportHeaders,
  parseMessages,
  toolRefusal,
  toolText,
} from "./protocol.ts";
import {
  __resetSessionsDeps,
  __setSessionsDeps,
  killSession,
  startSession,
} from "../orchestrator/sessions.ts";
import { SESSION_TOKEN_ENV_VAR } from "../../platform/identity/contract.ts";
import type { TmuxAdapter } from "../orchestrator/tmux.ts";
import { MCP_TASKS_PATH } from "../tasks/routes/mcp-tasks.ts";

const GOOD_HEADERS = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
};

// --- Pure: headers and parsing --------------------------------------------------

describe("the transport's header checks", () => {
  it("requires both application/json and text/event-stream in Accept", () => {
    // The client MUST advertise both, because a compliant server may answer
    // either way. A client that only accepts JSON gets 406 rather than a
    // response it might not be able to read.
    expect(checkTransportHeaders(GOOD_HEADERS)).toBeUndefined();
    expect(checkTransportHeaders({ ...GOOD_HEADERS, accept: "application/json" })?.status).toBe(
      406,
    );
    expect(checkTransportHeaders({ ...GOOD_HEADERS, accept: "text/event-stream" })?.status).toBe(
      406,
    );
    expect(checkTransportHeaders({ "content-type": "application/json" })?.status).toBe(406);
  });

  it("accepts Accept with parameters and in any order", () => {
    expect(
      checkTransportHeaders({
        ...GOOD_HEADERS,
        accept: "text/event-stream;q=0.9, application/json;q=1.0",
      }),
    ).toBeUndefined();
  });

  it("requires application/json content-type, tolerating a charset", () => {
    expect(
      checkTransportHeaders({ ...GOOD_HEADERS, "content-type": "application/json; charset=utf-8" }),
    ).toBeUndefined();
    expect(checkTransportHeaders({ ...GOOD_HEADERS, "content-type": "text/plain" })?.status).toBe(
      415,
    );
  });

  it("checks Accept before Content-Type", () => {
    // Both wrong: the reference implementation answers 406, and a client
    // debugging its request should be told about the same one first.
    const refusal = checkTransportHeaders({ accept: "text/plain", "content-type": "text/plain" });
    expect(refusal?.status).toBe(406);
  });
});

describe("parsing the body", () => {
  const frame = { jsonrpc: "2.0", id: 1, method: "ping" };

  it("parses the raw string the app's passthrough parser hands over", () => {
    const parsed = parseMessages(JSON.stringify(frame), GOOD_HEADERS);
    expect("messages" in parsed && parsed.messages).toEqual([frame]);
  });

  it("turns unparseable JSON into -32700, not a framework 400", () => {
    const parsed = parseMessages("{not json", GOOD_HEADERS);
    expect("refusal" in parsed && parsed.refusal.code).toBe(JSON_RPC.parseError);
    expect("refusal" in parsed && parsed.refusal.status).toBe(400);
  });

  it("rejects a well-formed body that is not a JSON-RPC message", () => {
    for (const body of ['{"hello":"world"}', "[]", '{"jsonrpc":"1.0","id":1,"method":"ping"}']) {
      const parsed = parseMessages(body, GOOD_HEADERS);
      expect("refusal" in parsed, body).toBe(true);
    }
  });

  it("accepts a batch, a notification and a client response frame", () => {
    for (const body of [
      JSON.stringify([frame, frame]),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 9, result: {} }),
    ]) {
      expect("messages" in parseMessages(body, GOOD_HEADERS), body).toBe(true);
    }
  });

  it("refuses an unsupported Mcp-Protocol-Version, and allows an absent one", () => {
    const headers = { ...GOOD_HEADERS, "mcp-protocol-version": "1999-01-01" };
    const refused = parseMessages(JSON.stringify(frame), headers);
    expect("refusal" in refused && refused.refusal.status).toBe(400);
    expect("messages" in parseMessages(JSON.stringify(frame), GOOD_HEADERS)).toBe(true);
    for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
      const ok = parseMessages(JSON.stringify(frame), {
        ...GOOD_HEADERS,
        "mcp-protocol-version": version,
      });
      expect("messages" in ok, version).toBe(true);
    }
  });

  it("does not check the version header on an initialize request", () => {
    // Initialize is where the version is negotiated, from the body's params.
    // Refusing it on the header would make a client's first request
    // unanswerable.
    const parsed = parseMessages(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }), {
      ...GOOD_HEADERS,
      "mcp-protocol-version": "1999-01-01",
    });
    expect("messages" in parsed).toBe(true);
  });
});

describe("tool result shapes", () => {
  it("marks a refusal with isError on the RESULT, never as a JSON-RPC error", () => {
    // Spike 003 §4: the application-level failure is the shape that carries
    // text back to the model. A JSON-RPC error is a protocol failure, and a
    // refusal an agent is supposed to act on is not that.
    expect(toolRefusal("owned by agent2")).toEqual({
      content: [{ type: "text", text: "owned by agent2" }],
      isError: true,
    });
    expect(toolText("claimed")).toEqual({ content: [{ type: "text", text: "claimed" }] });
    expect(toolText("claimed").isError).toBeUndefined();
  });
});

// --- Against the real route -----------------------------------------------------

const createdProjects: string[] = [];
const slugOf = new Map<string, string>();

async function makeProject(): Promise<ProjectId> {
  const slug = `t017p-${randomUUID()}`;
  const result = await pool.query<{ id: string }>(
    `insert into projects (name, slug, repo_url) values ($1, $2, $3) returning id`,
    [slug, slug, "https://example.invalid/repo.git"],
  );
  const id = result.rows[0]!.id;
  createdProjects.push(id);
  slugOf.set(id, slug);
  return id as ProjectId;
}

let spawnedEnv: Readonly<Record<string, string>> = {};

function fakeAdapter(): TmuxAdapter {
  return {
    newSession: async (request: { env?: Readonly<Record<string, string>> }) => {
      spawnedEnv = request.env ?? {};
      return { ok: true, value: { name: "x", dialogsAnswered: [], readyMs: 10 } };
    },
    hasSession: async () => ({ ok: true, value: { exists: true } }),
    listSessions: async () => ({ ok: true, value: { names: [], foreign: [] } }),
    capturePane: async () => ({ ok: true, value: { pane: "" } }),
    sendLiteral: async () => ({ ok: true, value: { byteLength: 1 } }),
    sendKeys: async () => ({ ok: true, value: {} }),
    sendEscape: async () => ({ ok: true, value: {} }),
    clearComposer: async () => ({ ok: true, value: { clears: 1 } }),
    sendMessage: async () => ({ ok: true, value: { byteLength: 1 } }),
    killSession: async () => ({ ok: true, value: {} }),
  } as unknown as TmuxAdapter;
}

async function startDesk(owner = "agent1"): Promise<{ token: string; sessionId: string }> {
  const projectId = await makeProject();
  const { session } = await startSession({
    projectId,
    projectSlug: slugOf.get(projectId as string)!,
    role: "dept_lead",
    dept: "dev",
    owner,
    backend: "claude",
    model: "sonnet",
    modelReason: "test",
    cwd: "/srv/office/projects/x",
    claudeBin: "/usr/local/bin/claude",
    hookArrivalTimeoutMs: 50,
  });
  return { token: spawnedEnv[SESSION_TOKEN_ENV_VAR]!, sessionId: session.id };
}

describe("POST /mcp/tasks", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    __setSessionsDeps({
      tmux: fakeAdapter(),
      waitForFirstEvent: async (claudeSessionId) =>
        ({
          id: randomUUID(),
          projectId: null,
          sessionId: claudeSessionId,
          type: "SessionStart",
          payload: {},
          receivedAt: "now",
          cursor: "c",
        }) as never,
    });
    app = await buildApp();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  afterAll(async () => {
    __resetSessionsDeps();
    for (const id of createdProjects) {
      await pool.query("delete from projects where id = $1", [id]);
    }
  });

  const post = async (
    payload: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const response = await app.inject({
      method: "POST",
      url: MCP_TASKS_PATH,
      payload: JSON.stringify(payload),
      headers: { ...GOOD_HEADERS, ...headers },
    });
    return {
      status: response.statusCode,
      body: response.body === "" ? {} : (JSON.parse(response.body) as Record<string, unknown>),
    };
  };

  it("answers initialize with tools-only capabilities and the client's version", async () => {
    const { status, body } = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    });
    expect(status).toBe(200);
    const result = body.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe("2025-06-18");
    expect(result.capabilities).toEqual({ tools: {} });
    expect((result.serverInfo as Record<string, unknown>).name).toBe("office_tasks");
  });

  it("answers its own latest version when the client asks for one it does not know", async () => {
    const { body } = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "1999-01-01" },
    });
    expect((body.result as Record<string, unknown>).protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
  });

  it("answers a notification with 202 and an empty body", async () => {
    // notifications/initialized arrives right after the handshake. A JSON-RPC
    // response here is a protocol error the client may reject, and the
    // symptom would be a desk whose tools never appear.
    const response = await app.inject({
      method: "POST",
      url: MCP_TASKS_PATH,
      payload: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      headers: GOOD_HEADERS,
    });
    expect(response.statusCode).toBe(202);
    expect(response.body).toBe("");
  });

  it("lists both tools without a credential, with schemas", async () => {
    // Unauthenticated on purpose — see the module header. The point is that a
    // misconfigured desk gets far enough to call a tool and be TOLD why, in
    // its transcript, rather than failing to connect where nobody is looking.
    const { body } = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = (body.result as { tools: { name: string; inputSchema: unknown }[] }).tools;
    expect(tools.map((tool) => tool.name).sort()).toEqual(["claim_task", "complete_task"]);
    for (const tool of tools) {
      expect(tool.inputSchema).toMatchObject({ type: "object" });
    }
  });

  it("answers ping", async () => {
    const { body } = await post({ jsonrpc: "2.0", id: 3, method: "ping" });
    expect(body.result).toEqual({});
  });

  it("returns method-not-found for an unknown method", async () => {
    const { body } = await post({ jsonrpc: "2.0", id: 4, method: "resources/list" });
    expect((body.error as { code: number }).code).toBe(JSON_RPC.methodNotFound);
  });

  it("answers a batch with an array of frames in order", async () => {
    const { body } = await post([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);
    const frames = body as unknown as { id: number }[];
    expect(Array.isArray(frames)).toBe(true);
    expect(frames.map((frame) => frame.id)).toEqual([1, 2]);
  });

  it("refuses GET with 405 — nothing here pushes to a client", async () => {
    const response = await app.inject({ method: "GET", url: MCP_TASKS_PATH });
    expect(response.statusCode).toBe(405);
  });

  it("issues no Mcp-Session-Id and requires none", async () => {
    // Stateless by choice: the office already has a session identity, and a
    // second transport-level one would be a near-homonym in every log line.
    const response = await app.inject({
      method: "POST",
      url: MCP_TASKS_PATH,
      payload: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      headers: GOOD_HEADERS,
    });
    expect(response.headers["mcp-session-id"]).toBeUndefined();
    const second = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(second.status).toBe(200);
  });

  // --- tools/call and identity ---------------------------------------------

  const callTool = async (
    name: string,
    args: Record<string, unknown>,
    authorization?: string,
  ): Promise<{ text: string; isError: boolean }> => {
    const { body } = await post(
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } },
      authorization === undefined ? {} : { authorization },
    );
    const result = body.result as { content: { text: string }[]; isError?: boolean };
    return { text: result.content.map((part) => part.text).join("\n"), isError: result.isError === true };
  };

  it("refuses a tool call with no credential, as readable text", async () => {
    const { text, isError } = await callTool("claim_task", { task_id: randomUUID() });
    expect(isError).toBe(true);
    expect(text).toContain("Authorization");
    expect(text).toContain(SESSION_TOKEN_ENV_VAR);
  });

  it("refuses an unexpanded placeholder and names the launch environment", async () => {
    // The §3.3 trap reaching the endpoint. Every desk in that state presents
    // the same literal string, so treating it as an identity would hand them
    // all one desk.
    const { text, isError } = await callTool(
      "claim_task",
      { task_id: randomUUID() },
      "Bearer ${OFFICE_SESSION_TOKEN}",
    );
    expect(isError).toBe(true);
    expect(text).toContain("launch environment");
  });

  it("refuses a token whose session has ended", async () => {
    const { token, sessionId } = await startDesk();
    await killSession(sessionId as never, "test");
    const { text, isError } = await callTool(
      "claim_task",
      { task_id: randomUUID() },
      `Bearer ${token}`,
    );
    expect(isError).toBe(true);
    expect(text).toContain("ended");
  });

  it("reaches the tool with a live desk's token", async () => {
    const { token } = await startDesk();
    // A real token, a task that does not exist: the refusal must come from
    // the TOOL, not from the identity check, which is what proves the
    // credential got through.
    const { text, isError } = await callTool(
      "claim_task",
      { task_id: randomUUID() },
      `Bearer ${token}`,
    );
    expect(isError).toBe(true);
    expect(text).toContain("There is no task");
  });

  it("refuses an unknown tool by name, listing what it has", async () => {
    const { token } = await startDesk();
    const { text, isError } = await callTool("approve_task", {}, `Bearer ${token}`);
    expect(isError).toBe(true);
    expect(text).toContain("claim_task");
  });
});
