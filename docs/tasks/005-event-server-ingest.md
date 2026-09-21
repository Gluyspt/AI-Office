---
id: "005"
title: Event server — hook ingest endpoints and event store
build_step: 1
department: dev
estimated_model: sonnet
blocked_by: ["002", "004"]
---

# 005 — Event server: hook ingest endpoints and event store

**Build step:** 1 — Spine
**Department:** dev
**Estimated model:** sonnet — mechanical once ticket 002 has pinned down the payload shapes.
**Blocked by:** 002, 004

## Why

Every arrow in the design's data-flow diagram points at the event server. It is the single ingest
point for hooks, and later for CI, GitHub webhooks and usage metrics. This ticket builds the HTTP app,
the ingest endpoints, and durable storage — and establishes the **handler directory convention** that
lets tickets 010, 020 and 027 add per-event behaviour without editing a shared dispatcher.

## Scope

### Files created

- `packages/server/src/app.ts` — Fastify app, autoloads `src/routes/` so later tickets add a route file without editing a registry
- `packages/server/src/server.ts` — process entry point, listen, graceful shutdown
- `packages/server/src/routes/events.ts` — the `/events/*` endpoints from the design: `reply`, `failure`, `tool`, `permission`, `start`, `end`, `compact`, `model`
- `packages/server/src/events/ingest.ts` — validate, persist, publish, then dispatch to handlers
- `packages/server/src/events/handlers/loader.ts` — collects handler modules from `src/events/handlers/`, keyed by event type; unknown types are stored and ignored, never rejected
- `packages/shared/src/events.ts` — the `OfficeEvent` union and per-event payload types
- `db/migrations/0002_events.sql` — `events` table: id, project_id, session_id (nullable at this stage), type, payload jsonb, received_at, plus an index on (project_id, received_at desc)

### Files appended to (manifest exception, not owned)

- `packages/server/src/config.ts` — **append** a `loadServerConfig()` validating `EVENT_SERVER_PORT`
  (and any other variable this ticket reads). Do not edit the existing `loadDatabaseConfig()`,
  `loadTlsConfig()`, the shared readers, or `ConfigError` — those belong to ticket 004. Follow the
  established shape: required-with-no-default where the server genuinely cannot run without the
  value, and a single `ConfigError` naming every problem found.
- `.env.example`, and dependencies in `package.json`, per the standing manifest exception.

### Files modified

None.

## Acceptance criteria

- [ ] Each of the eight `/events/*` endpoints accepts a POST of its captured payload from `docs/spikes/001-hook-payloads.md` and returns 2xx.
- [ ] Every accepted event is stored with its full payload intact; a test round-trips one captured payload per event type and asserts deep equality.
- [ ] A payload that fails validation is stored in a dead-letter form (type `unparsed`, raw body preserved) and still returns 2xx — a malformed hook must never stall the agent that sent it.
- [ ] An unknown event type POSTed to `/events/<type>` is stored and returns 2xx without a handler present.
- [ ] Adding a file to `src/events/handlers/` makes it run on the matching event with no edit to `ingest.ts` or `loader.ts` — verified with a temporary handler in a test.
- [ ] The server responds to ingest in under 50 ms at p95 with 200 sequential POSTs, measured locally, so hooks do not slow agents.
- [ ] `GET /events?project_id=&since=&limit=` returns events newest-first with a working `since` cursor.
- [ ] Killing and restarting the process loses no stored event.

- [ ] **A TLS handshake rejected by a hook client is logged as a distinct, greppable error** naming
      the peer and the OpenSSL reason (`unknown ca` and friends), not swallowed. Spike 002 measured
      this: a client that refuses the server's certificate produces **no request at all**, which is
      byte-for-byte indistinguishable from a hook that never fired. Without this line, a
      mis-provisioned rollout looks exactly like agents that quietly stopped working. Node exposes it
      as the server's `tlsClientError` event — `spikes/hooks/echo-server.mjs` already does this and is
      the reference.
- [ ] **A handshake failure is visible beyond the log**: it publishes an event, so ticket 022's
      degraded banner and ticket 008's spawn self-test have something to key on. A rejection that only
      reaches a log file is a rejection nobody sees.

## Decided

- **Every endpoint this ticket creates is `https`, including on loopback.** No plaintext listener
  anywhere in the system. This is a transport decision only: `"type": "http"` stays the hook-config
  keyword — Claude Code's hook types are `http` and `command`, there is no `https` type, and only the
  URL scheme changes.
- **TLS is not the answer to forgeable ingest.** Spike 002 found hook POSTs carry no authentication or
  signature, so anything that can reach the port can forge any event for any `session_id`. TLS
  authenticates the server to the client, which is the wrong direction. The mitigation is a per-user
  token on the hook URL — the spike verified query strings survive the hook call intact — plus binding
  loopback only.
- **Open, and it gates this ticket:** whether Claude Code's hook client accepts a self-signed cert is
  untested. If it does not, hooks need a trusted local CA or `NODE_EXTRA_CA_CERTS` exported into every
  agent session. See `docs/spikes/001-hook-payloads.md`.

- **`PostToolUse.tool_response` carries full tool output** — whole file bodies for a `Read`, whole
  written content for a `Write` (spike 002, §5). Storing every event with its payload intact therefore
  means **the event log accumulates copies of project source**. Two consequences the design never
  considered: the table grows far faster than an event count suggests, and a database dump carries the
  contents of every managed repo. The acceptance criterion above ("full payload intact") stands — this
  ticket does not start truncating on its own judgement — but the retention question below is now a
  confidentiality question too, not only a disk one.

## Open questions

- [ ] The design lists eight hook events but never says which are required for v1 versus captured for later use. This ticket ingests all eight, on the argument that storage is cheap and re-instrumenting agents later is not.
- [ ] No retention or pruning policy is specified for the event log. Table will grow without bound; flag for step 7 (Reliability) unless a policy is decided now.
- [ ] Whether `session_id` can be populated at ingest time depends on ticket 002's correlation finding. The column is nullable here; ticket 010 owns filling it.
- [ ] The design does not say whether the event server authenticates hook POSTs. It binds to localhost, but three users' agents can reach localhost. Assumed unauthenticated for v1; revisit at step 9 (access control).
