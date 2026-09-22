---
id: "006"
title: WebSocket fan-out to connected clients
build_step: 1
department: dev
estimated_model: sonnet
blocked_by: ["005"]
---

# 006 — WebSocket fan-out to connected clients

**Build step:** 1 — Spine
**Department:** dev
**Estimated model:** sonnet — a pub/sub bus and one socket route.
**Blocked by:** 005

## Why

"Web sockets keep every screen in sync." Everything the UI shows in step 3 — the board, the chat
transcript, the blocked banner — is an event arriving here. Building it in step 1 means the spine can
be verified from a browser tab rather than by tailing the database.

## Scope

### Files created

- `packages/server/src/features/events/bus.ts` — in-process publish/subscribe with topic filtering by project and by session
- `packages/server/src/features/realtime/routes/ws.ts` — the `/ws` endpoint: subscribe, filter, heartbeat, backpressure
- `packages/shared/src/ws.ts` — client/server frame types: `subscribe`, `unsubscribe`, `event`, `ping`, `pong`

### Files modified

None.

## Acceptance criteria

- [ ] A client connecting to `/ws` and sending `{type:"subscribe", project_id}` receives every subsequent event for that project and none for another project.
- [ ] A client subscribed to a single `session_id` receives only that session's events.
- [ ] Events published while no client is connected are not queued or replayed — clients backfill through `GET /events?since=` from ticket 005. A test asserts a reconnecting client with a `since` cursor sees no gap and no duplicate.
- [ ] A dropped connection is cleaned up: after 100 connect/disconnect cycles the subscriber count returns to zero.
- [ ] Heartbeat: the server pings every 30 s and closes a connection that misses two consecutive pongs.
- [ ] A slow consumer does not block ingest — a client that stops reading is disconnected once its outbound buffer passes a configured limit, and ingest latency stays within the p95 target from ticket 005 while that happens.
- [ ] Three clients subscribed to the same project all receive the same event exactly once each.

## Decided

- **The WebSocket is `wss://`, not `ws://`**, per the system-wide https decision (see the ticket index,
  "Decisions made"). It shares the event server's TLS listener rather than standing up a second one.

## Open questions

- [ ] The design says "web sockets" but the data-flow diagram also mentions SSE for the knowledge graph servers. This ticket uses WebSocket for the UI channel; no reconciliation is needed until step 5.
- [ ] No authentication on `/ws`. The design requires app-level login behind the reverse proxy, but that is step 9. Assumed open on localhost for now — recorded here so it is not forgotten when auth lands.
