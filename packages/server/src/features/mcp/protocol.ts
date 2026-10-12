// The office's MCP server plumbing: JSON-RPC 2.0 over one HTTP POST, with
// the tools supplied by whoever mounts it.
//
// Ticket 017 creates this; ticket 018's session server mounts its own tools on
// it and adds no protocol code. One implementation, one place to be wrong.
//
//
// WHY THIS IS HAND-WRITTEN RATHER THAN `@modelcontextprotocol/sdk`
// ----------------------------------------------------------------
// The SDK was installed, read, and removed again, and the reason is its
// dependency graph rather than its quality: version 1.32.1 declares
// `express`, `hono`, `@hono/node-server`, `jose`, `ajv`, `cors`,
// `pkce-challenge` and `cross-spawn` as hard dependencies, and
// `server/streamableHttp.js` runs a **hono** request listener. Mounting that
// inside this Fastify app would put a second HTTP framework in the request
// path — body parsing, header casing, keep-alive — for the sake of two tools,
// on a 3.2 GB box that is already counting megabytes per agent.
//
// What the SDK *was* used for is the part that mattered: its
// `webStandardStreamableHttp.js` is the reference implementation of this
// transport, and every status code, header check and error code below was
// read off it rather than recalled. The specific behaviours it fixes:
//
//   * `Accept` must contain BOTH `application/json` and `text/event-stream`,
//     else **406** with JSON-RPC code -32000. (A comma-separated list, so a
//     substring check is the intended semantics.)
//   * `Content-Type` must be `application/json`, else **415**.
//   * Unparseable body -> **400** with -32700; a well-formed body that is not
//     a JSON-RPC message -> **400** with -32600.
//   * A batch containing no *requests* (only notifications or responses) ->
//     **202 with an empty body**. This is how `notifications/initialized`
//     must be answered, and answering it with a JSON-RPC response instead is
//     a protocol error the client is entitled to reject.
//   * `Mcp-Protocol-Version`, when present on a non-initialize request, must
//     be one this server supports, else **400** with -32000. Absent is legal
//     and means the version negotiated at initialize.
//   * **No session management.** The SDK makes `Mcp-Session-Id` conditional
//     on a `sessionIdGenerator`; without one, no session header is issued or
//     required. The office deliberately runs stateless here, because it
//     already has a session identity — the desk's own `OFFICE_SESSION_TOKEN`
//     — and a second, transport-level session id would be a near-homonym for
//     a different thing in every log line and every refusal message.
//   * GET (the server-initiated SSE stream) -> **405**, which the spec allows
//     for a server that never pushes. Everything here is request/response.
//
// **This conformance is UNVERIFIED against a live Claude Code MCP client**,
// and that is a named open criterion on 017 rather than an assumption. It
// cannot be verified from this host: it needs a real agent session, which is
// the same batched run spike 003 §8 is waiting on (a Claude login is
// single-session, so starting one costs a human theirs). The failure shape if
// something here is wrong is loud — the desk reports a server that would not
// connect, in `/mcp` — not silent, which is why building it now is safe.
//
//
// WHAT IS NOT AUTHENTICATED, AND WHY THAT IS DELIBERATE
// -----------------------------------------------------
// `initialize` and `tools/list` answer without a credential; `tools/call`
// requires one. The tools do nothing without authentication, and the tool
// *names* are not a secret — but the choice is about observability, not
// secrecy.
//
// If `initialize` refused a desk whose `OFFICE_SESSION_TOKEN` never expanded,
// the only evidence would be an MCP connection error in the agent's own TUI,
// which no human is reading during an unattended spawn — the exact blind spot
// that made §3.3's trap worth a design change in the first place. Letting the
// handshake succeed means the refusal arrives instead as the result of the
// desk's first `claim_task`: text in the model's transcript, which 010 and
// 026 pipe into the chat panel humans actually watch, and which the model
// itself can report in its turn.
//
// So: a misconfigured desk connects, tries to work, and says out loud why it
// cannot. That is worth more than refusing the handshake one step earlier.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { SessionRecord } from "@office/shared/sessions";
import { authenticateSessionToken } from "../orchestrator/session-auth.ts";
import { bearerCredential } from "../orchestrator/session-token.ts";

/** Read off the SDK's `types.js`, newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
] as const;

export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

/** What the SDK falls back to when a request carries no version header. */
export const DEFAULT_NEGOTIATED_PROTOCOL_VERSION = "2025-03-26";

// --- Tool results ---------------------------------------------------------------

export interface ToolResult {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly isError?: boolean;
}

/**
 * A successful tool result.
 *
 * Text, not JSON, is the office's default: the reader is a model deciding
 * what to do next. A tool that hands back `{"ok":true,"state":"in_progress"}`
 * makes the model parse and then narrate; one that hands back a sentence has
 * already said the thing the model would have said.
 */
export function toolText(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/**
 * A refusal the model is meant to act on.
 *
 * `isError: true` on a tool *result*, never a JSON-RPC error — spike 003 §4:
 * the application-level failure shape is the one that carries text back to
 * the model, and "a `claim_task` refusal is a teaching signal, not just a
 * failure". An agent told "task t-123 is owned by agent2" can pick a
 * different task; an agent told "a tool failed" retries, and the refusal
 * becomes a loop.
 */
export function toolRefusal(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

// --- Tool definitions -----------------------------------------------------------

export interface McpToolContext {
  /** The desk that called, proven by the transport. Never an argument. */
  readonly session: SessionRecord;
}

export interface McpTool {
  readonly name: string;
  /** Shown to the model in `tools/list`. This is prompt text: write it as such. */
  readonly description: string;
  /** JSON Schema for the arguments, as the protocol requires. */
  readonly inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>, context: McpToolContext): Promise<ToolResult>;
}

// --- JSON-RPC ------------------------------------------------------------------

type JsonRpcId = string | number;

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

interface JsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

/** JSON-RPC error codes this server uses. The three negative-32xxx ones are
 * the standard set; -32000 is the transport's own "server error" bucket, used
 * by the reference implementation for header and session problems. */
export const JSON_RPC = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  serverError: -32000,
} as const;

function errorFrame(id: JsonRpcId | null, code: number, message: string): unknown {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function resultFrame(id: JsonRpcId, result: unknown): unknown {
  return { jsonrpc: "2.0", id, result };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequest(message: unknown): message is JsonRpcRequest {
  if (!isRecord(message)) return false;
  if (message.jsonrpc !== "2.0") return false;
  if (typeof message.method !== "string") return false;
  return typeof message.id === "string" || typeof message.id === "number";
}

function isNotification(message: unknown): message is JsonRpcNotification {
  if (!isRecord(message)) return false;
  if (message.jsonrpc !== "2.0") return false;
  if (typeof message.method !== "string") return false;
  return message.id === undefined;
}

/** A response frame a client sent us. We issue no requests, so these are
 * only ever ignored — but they are legal traffic and must not 400. */
function isResponse(message: unknown): boolean {
  if (!isRecord(message)) return false;
  if (message.jsonrpc !== "2.0") return false;
  return message.result !== undefined || message.error !== undefined;
}

// --- The server ----------------------------------------------------------------

export interface McpServerDefinition {
  /** Reported in `initialize`. Must match the key in the role file's
   * `mcpServers:` block and the `mcp__<name>__*` allow rule, or the office
   * allowlists a server that does not exist and every call prompts. */
  readonly name: string;
  readonly version: string;
  readonly tools: readonly McpTool[];
}

/** Why a request was refused before any tool ran. */
interface HttpRefusal {
  readonly status: number;
  readonly code: number;
  readonly message: string;
}

function refuse(status: number, code: number, message: string): HttpRefusal {
  return { status, code, message };
}

/**
 * The transport-level header checks, in the reference implementation's order:
 * `Accept` before `Content-Type`, both before the body is even parsed.
 *
 * Exported for its own test. Every one of these is a status code a client
 * depends on, and none of them can be exercised from this host through a real
 * MCP client — so they are asserted directly rather than trusted.
 */
export function checkTransportHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): HttpRefusal | undefined {
  const accept = headerValue(headers, "accept");
  if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
    return refuse(
      406,
      JSON_RPC.serverError,
      "Not Acceptable: Client must accept both application/json and text/event-stream",
    );
  }

  // Substring, not equality: a real client sends `application/json;
  // charset=utf-8`. The reference implementation parses the media type
  // properly; a prefix check gives the same answer for every well-formed
  // value and a 415 for the rest.
  const contentType = headerValue(headers, "content-type");
  if (!contentType.startsWith("application/json")) {
    return refuse(
      415,
      JSON_RPC.serverError,
      "Unsupported Media Type: Content-Type must be application/json",
    );
  }

  return undefined;
}

function headerValue(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): string {
  const raw = headers[name];
  return Array.isArray(raw) ? raw.join(",") : (raw ?? "");
}

/**
 * The body, once it is known to be JSON.
 *
 * THE APP PASSES EVERY BODY THROUGH AS A RAW STRING — `core/app.ts` registers
 * a passthrough parser for `application/json` and for `*`, so that a
 * malformed hook payload is dead-lettered by ingest rather than 400'd by
 * Fastify before a handler runs. That decision reaches here as a benefit: the
 * parse happens where a failure is supposed to become JSON-RPC -32700 rather
 * than a framework error with no `jsonrpc` field in it.
 */
export function parseMessages(
  body: unknown,
  headers: Readonly<Record<string, string | string[] | undefined>>,
): { readonly messages: unknown[] } | { readonly refusal: HttpRefusal } {
  let parsed: unknown;
  if (typeof body === "string") {
    if (body.trim() === "") {
      return { refusal: refuse(400, JSON_RPC.parseError, "Parse error: empty body") };
    }
    try {
      parsed = JSON.parse(body);
    } catch {
      return { refusal: refuse(400, JSON_RPC.parseError, "Parse error: Invalid JSON") };
    }
  } else {
    parsed = body;
  }

  const messages = Array.isArray(parsed) ? parsed : [parsed];
  if (messages.length === 0) {
    return { refusal: refuse(400, JSON_RPC.invalidRequest, "Invalid Request: empty batch") };
  }
  for (const message of messages) {
    if (!isRequest(message) && !isNotification(message) && !isResponse(message)) {
      return {
        refusal: refuse(400, JSON_RPC.parseError, "Parse error: Invalid JSON-RPC message"),
      };
    }
  }

  // Only checked for non-initialize traffic: initialize is where the version
  // is negotiated, and the reference implementation reads it from the body's
  // params there rather than from the header. Absent is legal everywhere and
  // means "the version negotiated at initialize".
  const isInitialize = messages.some(
    (message) => isRequest(message) && message.method === "initialize",
  );
  const version = headerValue(headers, "mcp-protocol-version");
  if (
    !isInitialize &&
    version !== "" &&
    !(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(version)
  ) {
    return {
      refusal: refuse(
        400,
        JSON_RPC.serverError,
        `Bad Request: Unsupported protocol version: ${version} (supported versions: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")})`,
      ),
    };
  }

  return { messages };
}

/** `initialize`'s result: what this server is and what it can do. */
function initializeResult(definition: McpServerDefinition, params: unknown): unknown {
  const requested = isRecord(params) ? params.protocolVersion : undefined;
  // Echo the client's version when we speak it, else answer with our latest
  // and let the client decide — the negotiation the spec describes.
  const protocolVersion =
    typeof requested === "string" &&
    (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
      ? requested
      : LATEST_PROTOCOL_VERSION;
  return {
    protocolVersion,
    // Tools only. No resources, no prompts, no sampling, no logging: the
    // office's servers are two verbs each, and declaring a capability this
    // server does not implement invites a client to call into nothing.
    capabilities: { tools: {} },
    serverInfo: { name: definition.name, version: definition.version },
  };
}

function toolsListResult(definition: McpServerDefinition): unknown {
  return {
    tools: definition.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  };
}

/**
 * Runs one `tools/call`, including the identity check.
 *
 * Every failure after authentication is a tool result rather than a JSON-RPC
 * error, for the reason in `toolRefusal`. A *thrown* error is the exception:
 * that is a bug in the office, not a refusal the model can act on, so it
 * surfaces as a JSON-RPC internal error and is logged.
 */
async function runToolCall(
  definition: McpServerDefinition,
  params: unknown,
  authorization: string | undefined,
  app: FastifyInstance,
): Promise<ToolResult> {
  const name = isRecord(params) ? params.name : undefined;
  if (typeof name !== "string") {
    return toolRefusal("tools/call needs a `name`: which tool to run.");
  }
  const tool = definition.tools.find((candidate) => candidate.name === name);
  if (!tool) {
    const known = definition.tools.map((candidate) => candidate.name).join(", ");
    return toolRefusal(
      `${definition.name} has no tool called ${JSON.stringify(name)}. It has: ${known}.`,
    );
  }

  const auth = await authenticateSessionToken(bearerCredential(authorization));
  if (!auth.ok) {
    // The refusal text is written for this moment — see session-auth.ts. It
    // reaches the model, so it says what to change rather than which branch
    // failed, and it never echoes the credential.
    app.log.warn(
      { tool: name, server: definition.name, kind: auth.kind },
      "mcp tool call refused: unidentified desk",
    );
    return toolRefusal(auth.message);
  }

  const args = isRecord(params) && isRecord(params.arguments) ? params.arguments : {};
  try {
    return await tool.run(args, { session: auth.session });
  } catch (error) {
    app.log.error(
      { err: error, tool: name, server: definition.name, session: auth.session.id },
      "mcp tool threw",
    );
    throw error;
  }
}

/**
 * Mounts one MCP server at `path`.
 *
 * Called from a feature's `routes/` file, so a new server is a new file and
 * no registry edit — the convention 005 established.
 */
export function mountMcpServer(
  app: FastifyInstance,
  path: string,
  definition: McpServerDefinition,
): void {
  app.post(path, async (request: FastifyRequest, reply: FastifyReply) => {
    const headerRefusal = checkTransportHeaders(request.headers);
    if (headerRefusal) {
      return reply
        .code(headerRefusal.status)
        .send(errorFrame(null, headerRefusal.code, headerRefusal.message));
    }

    const parsed = parseMessages(request.body, request.headers);
    if ("refusal" in parsed) {
      return reply
        .code(parsed.refusal.status)
        .send(errorFrame(null, parsed.refusal.code, parsed.refusal.message));
    }

    const requests = parsed.messages.filter(isRequest);

    // Notifications and responses only: 202, empty body. This is the correct
    // answer to `notifications/initialized`, and answering it with a
    // JSON-RPC frame instead is a protocol error the client may reject.
    if (requests.length === 0) {
      return reply.code(202).send();
    }

    const authorization = request.headers.authorization;
    const frames: unknown[] = [];
    for (const message of requests) {
      switch (message.method) {
        case "initialize":
          frames.push(resultFrame(message.id, initializeResult(definition, message.params)));
          break;
        case "ping":
          // The spec's liveness check. An empty result is the whole contract.
          frames.push(resultFrame(message.id, {}));
          break;
        case "tools/list":
          frames.push(resultFrame(message.id, toolsListResult(definition)));
          break;
        case "tools/call":
          try {
            frames.push(
              resultFrame(
                message.id,
                await runToolCall(definition, message.params, authorization, app),
              ),
            );
          } catch (error) {
            frames.push(
              errorFrame(
                message.id,
                JSON_RPC.internalError,
                `${definition.name} failed internally: ${(error as Error).message}`,
              ),
            );
          }
          break;
        default:
          frames.push(
            errorFrame(
              message.id,
              JSON_RPC.methodNotFound,
              `Method not found: ${message.method}`,
            ),
          );
      }
    }

    // Single response for a single request, array for a batch — the shape the
    // reference implementation produces in JSON mode.
    return reply
      .code(200)
      .header("content-type", "application/json")
      .send(frames.length === 1 ? frames[0] : frames);
  });

  // The server-initiated stream. Nothing here ever pushes to a client, so
  // 405 is the honest answer and the spec allows it.
  app.get(path, async (_request: FastifyRequest, reply: FastifyReply) =>
    reply
      .code(405)
      .send(
        errorFrame(
          null,
          JSON_RPC.serverError,
          "Method Not Allowed: this server does not offer a server-initiated stream",
        ),
      ),
  );
}
