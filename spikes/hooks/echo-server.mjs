#!/usr/bin/env node
// Throwaway hook echo server for spike 002 (ticket docs/tasks/002-spike-hook-payloads.md).
// Logs every hook POST verbatim to stdout and to an append-only JSONL file, and can be
// told at runtime to answer a given path with a chosen status/body so blocking-response
// shapes can be probed without restarting Claude Code.
//
//   node echo-server.mjs            # PORT=8787 LOG=$HOME/spike002-tmp/hook-events.jsonl
//
// Control plane (not a hook path):
//   POST /control/mode   {"path":"/events/tool","status":200,"body":{...}}   -> set reply
//   POST /control/mode   {"path":"/events/tool","reset":true}               -> back to 200 {}
//   GET  /control/dump                                                      -> all events seen
//   GET  /control/clear                                                     -> forget them
//   GET  /health
//
// NOT production code: no auth, no persistence guarantees, unbounded memory.

import { createServer } from 'node:http';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const PORT = Number(process.env.PORT || 8787);
const LOG = process.env.LOG || `${process.env.HOME}/spike002-tmp/hook-events.jsonl`;
const DELAY_MS = Number(process.env.DELAY_MS || 0); // simulate a slow event server

mkdirSync(dirname(LOG), { recursive: true });

/** path -> { status, body, headers } */
const modes = new Map();
const seen = [];
let seq = 0;

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(payload);
}

const server = createServer(async (req, res) => {
  const tRecv = Date.now();
  const hrRecv = Number(process.hrtime.bigint() / 1000n) / 1000; // ms, monotonic
  const raw = await readBody(req);
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/health') return send(res, 200, { ok: true, seen: seen.length });

  if (url.pathname === '/control/dump') return send(res, 200, seen);
  if (url.pathname === '/control/clear') { seen.length = 0; return send(res, 200, { cleared: true }); }
  if (url.pathname === '/control/mode') {
    let cfg = {};
    try { cfg = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'bad json' }); }
    if (cfg.reset) modes.delete(cfg.path);
    else modes.set(cfg.path, { status: cfg.status ?? 200, body: cfg.body ?? {}, headers: cfg.headers ?? {} });
    return send(res, 200, { modes: [...modes.entries()] });
  }

  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* keep raw */ }

  const record = {
    n: ++seq,
    t_recv_ms: tRecv,
    t_recv_iso: new Date(tRecv).toISOString(),
    hr_recv_ms: hrRecv,
    method: req.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers: req.headers,
    hook_event_name: parsed?.hook_event_name ?? null,
    session_id: parsed?.session_id ?? null,
    body_raw: raw,
    body: parsed,
  };
  seen.push(record);
  appendFileSync(LOG, JSON.stringify(record) + '\n');
  process.stdout.write(
    `[${record.t_recv_iso}] #${record.n} ${req.method} ${url.pathname} ` +
      `event=${record.hook_event_name} bytes=${raw.length}\n`,
  );

  const mode = modes.get(url.pathname);
  if (DELAY_MS) await new Promise((r) => setTimeout(r, DELAY_MS));
  if (mode) {
    process.stdout.write(`    -> replying ${mode.status} ${JSON.stringify(mode.body)}\n`);
    return send(res, mode.status, mode.body, mode.headers);
  }
  return send(res, 200, {});
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`echo-server listening on http://127.0.0.1:${PORT} log=${LOG}\n`);
});
