#!/usr/bin/env node
// Spike 016 — a minimal MCP server that reports everything it can observe
// about its caller, so the office can answer one question it cannot answer by
// reading documentation: **how does a tool call identify the calling session,
// in a way the agent cannot forge?**
//
// `claim_task` "checks owner match". If the identity reaching the task server
// is something the model can type, an agent can claim another desk's task by
// calling the tool with different arguments. That is the whole reason this
// file exists, and it is why `whoami` reports its environment and its
// arguments SEPARATELY and labels which is which.
//
// ZERO DEPENDENCIES, on purpose. It runs on a bare agent account with nothing
// installed, it is the thing being measured so a transport library would sit
// between us and the measurement, and `npx` on a fresh box is a network call
// that can fail for reasons unrelated to MCP. Hand-rolled JSON-RPC 2.0 over
// newline-delimited stdin/stdout is about 60 lines.
//
// Run it by hand (it speaks JSON-RPC on stdin, so this is how you smoke-test
// it without Claude Code):
//
//   printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"manual","version":"0"}}}' \
//     '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
//     '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"whoami","arguments":{"claimed_session_id":"i-am-lying"}}}' \
//   | node spikes/mcp/probe-server.mjs
//
// Attach it to a real agent per role by putting it in the role file's
// frontmatter — see docs/spikes/003-mcp-wiring.md for the verbatim config and
// why that is the attachment point.
//
// Every frame it receives is appended to $MCP_PROBE_LOG (default
// ./mcp-probe.log) because the `initialize` params are the only place the
// client describes itself, and they arrive before any tool is called.

import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const LOG = process.env.MCP_PROBE_LOG ?? "mcp-probe.log";
const SERVER_STARTED_AT = new Date().toISOString();
const SERVER_PID = process.pid;

// Recorded at startup, before any tool call, so a later call cannot have
// changed them. The point of the spike is what is true at LAUNCH.
const LAUNCH_SNAPSHOT = {
  argv: process.argv,
  cwd: process.cwd(),
  pid: SERVER_PID,
  ppid: process.ppid,
  // uid/gid are undefined on Windows. Reported as null rather than omitted:
  // "the office could not read this" and "the office did not look" are
  // different answers.
  uid: typeof process.getuid === "function" ? process.getuid() : null,
  gid: typeof process.getgid === "function" ? process.getgid() : null,
  platform: process.platform,
  node: process.version,
  startedAt: SERVER_STARTED_AT,
};

/**
 * The environment, split into what the office injected and what Claude Code
 * injected, with everything else counted but not dumped.
 *
 * NOT the whole environment: it may hold an API key, and this log is written
 * to disk on a shared box. Prefixes are listed explicitly so adding one is a
 * deliberate act.
 */
function observedEnvironment() {
  const interesting = {};
  const PREFIXES = ["OFFICE_", "CLAUDE_", "MCP_"];
  let otherCount = 0;
  for (const [key, value] of Object.entries(process.env)) {
    if (PREFIXES.some((prefix) => key.startsWith(prefix))) {
      // Values are reported verbatim. On a real host the office token is a
      // secret, but this is a spike on a throwaway account and the whole
      // question is whether the value ARRIVED and in what shape — a redacted
      // value cannot answer that. Do not run this attached to a real desk.
      interesting[key] = value;
    } else {
      otherCount += 1;
    }
  }
  return { observed: interesting, otherVariableCount: otherCount };
}

/**
 * Does this look like an unexpanded `${VAR}` rather than a value?
 *
 * THE LOAD-BEARING CHECK, and the reason it is in the probe rather than only
 * in the write-up. Claude Code expands `${VAR}` in an MCP server's `env`,
 * `args`, `command`, `url` and `headers` — but a variable that is NOT set
 * does not fail the server: the config loads and the field keeps the literal
 * text `${VAR}`, with only a warning in `claude mcp list`.
 *
 * So a desk launched without the office's session variables gets an MCP
 * server whose identity is the constant string "${OFFICE_SESSION_TOKEN}" —
 * the same for every agent, and the task server would happily treat it as an
 * identity. That is the same shape of failure as a desk with no
 * NODE_EXTRA_CA_CERTS: it works perfectly and is silently wrong. Tickets 017
 * and 018 must refuse it, which is why the probe names it.
 */
function looksUnexpanded(value) {
  return typeof value === "string" && /\$\{[A-Za-z_][A-Za-z0-9_]*(:-[^}]*)?\}/.test(value);
}

function record(direction, frame) {
  try {
    appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), direction, frame })}\n`);
  } catch {
    // A probe that dies because it cannot write its log is a probe that
    // reports "MCP is broken" when the truth is "the directory is read-only".
  }
}

function send(message) {
  record("out", message);
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const TOOLS = [
  {
    name: "whoami",
    description:
      "Reports everything this MCP server can observe about its caller: the environment it was launched with, its process identity, and — separately — the arguments the model passed. Use it to find out which identity channels are trustworthy.",
    inputSchema: {
      type: "object",
      properties: {
        claimed_session_id: {
          type: "string",
          description:
            "A session id the CALLER asserts. Deliberately forgeable: the probe echoes it back under `modelSuppliedArguments` so the write-up can show that an argument and an injected environment variable are not the same kind of fact.",
        },
        note: { type: "string", description: "Free text echoed back, for correlating trials." },
      },
      required: [],
    },
  },
  {
    name: "fail_soft",
    description:
      "Always fails by returning a tool result with isError true. Answers: does the error TEXT reach the model usefully, or does the agent just see that something went wrong? A claim_task refusal is a teaching signal, not just a failure.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "fail_hard",
    description:
      "Always fails with a JSON-RPC protocol error rather than a tool result. The other half of the error question: MCP has two failure shapes and they may not reach the model the same way.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
];

function whoamiPayload(args) {
  const env = observedEnvironment();
  const unexpanded = Object.entries(env.observed)
    .filter(([, value]) => looksUnexpanded(value))
    .map(([key]) => key);
  return {
    // Channel 1: injected at launch. The model never sees these and cannot
    // change them by calling the tool differently.
    launchEnvironment: env.observed,
    otherVariableCount: env.otherVariableCount,
    // Channel 2: what the model typed. Forgeable by construction.
    modelSuppliedArguments: args ?? {},
    // Channel 3: the process itself.
    process: LAUNCH_SNAPSHOT,
    // The warning that matters more than any of them.
    unexpandedVariables: unexpanded,
    unexpandedWarning:
      unexpanded.length > 0
        ? `These arrived as literal \${...} text, not values: ${unexpanded.join(", ")}. Claude Code does not fail a server for an unset variable — it loads the config with the placeholder intact. An office tool MUST refuse this rather than treat it as an identity.`
        : null,
  };
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  const text = line.trim();
  if (text === "") return;

  let message;
  try {
    message = JSON.parse(text);
  } catch {
    record("in-unparseable", text.slice(0, 2000));
    return;
  }
  record("in", message);

  const { id, method, params } = message;
  // A notification has no id and must never be answered.
  const isNotification = id === undefined || id === null;

  if (method === "initialize") {
    // Echo the client's protocol version back rather than asserting our own.
    // The probe is recording what the client does, not negotiating with it,
    // and guessing a version it does not speak turns a measurement into a
    // handshake failure.
    const requested = params?.protocolVersion ?? "2025-06-18";
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: { name: "office-probe", version: "0.1.0" },
        instructions:
          "Call whoami first. It reports which identity channels are real and which are forgeable.",
      },
    });
    return;
  }

  if (isNotification) return;

  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return;
  }

  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments ?? {};

    if (name === "whoami") {
      const payload = whoamiPayload(args);
      send({
        jsonrpc: "2.0",
        id,
        result: {
          // Text, because that is what reaches the model. structuredContent
          // is sent too so a later harness can parse it without scraping.
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload,
        },
      });
      return;
    }

    if (name === "fail_soft") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          isError: true,
          content: [
            {
              type: "text",
              text:
                "OFFICE_PROBE_SOFT_ERROR: task t-123 is owned by agent2, not agent1. " +
                "This sentence is the measurement: if the agent repeats it or acts on it, " +
                "a refusal can teach. If the agent only reports that a tool failed, 017 " +
                "cannot rely on the reason reaching the model.",
            },
          ],
        },
      });
      return;
    }

    if (name === "fail_hard") {
      send({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message:
            "OFFICE_PROBE_HARD_ERROR: a JSON-RPC error, not a tool result. Does this reach the model as text?",
        },
      });
      return;
    }

    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32602, message: `unknown tool ${JSON.stringify(name ?? null)}` },
    });
    return;
  }

  // Unknown method. Answered rather than ignored: a client waiting on a reply
  // that never comes looks like a hung server, which is the hardest failure to
  // read from the agent's side.
  send({
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `method not found: ${String(method)}` },
  });
});

rl.on("close", () => {
  record("lifecycle", { event: "stdin closed", pid: SERVER_PID, startedAt: SERVER_STARTED_AT });
  process.exit(0);
});
