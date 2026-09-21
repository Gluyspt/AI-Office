---
id: "022"
title: Web app scaffold and app shell
build_step: 3
department: dev
estimated_model: sonnet
blocked_by: ["006", "013"]
---

# 022 — Web app scaffold and app shell

**Build step:** 3 — Tasks page and chat panel
**Department:** dev
**Estimated model:** sonnet — scaffolding plus two small libraries, with the conventions specified below.
**Blocked by:** 006, 013

## Why

Six later tickets add UI. This one gives them a shell, a typed API client, a live WebSocket client that
reconnects, and the **overlay convention** — a feature adds a slide-in panel by creating
`src/features/<name>/overlay.tsx`, collected by `import.meta.glob`, with no edit to the shell. That is
what lets the chat panel and the stop controls land in separate tickets without either touching the
other's files.

## Scope

### Files created

- `packages/web/package.json`
- `packages/web/tsconfig.json`
- `packages/web/vite.config.ts` — dev proxy to the event server for `/api` and `/ws`
- `packages/web/index.html`
- `packages/web/src/main.tsx` — router mount, file-based routes from `src/routes/`
- `packages/web/src/routes/__root.tsx` — shell: nav with static links to `/` and `/tasks`, outlet, overlay host
- `packages/web/src/routes/index.tsx` — landing page listing projects, with a link into the board
- `packages/web/src/lib/api.ts` — typed fetch client over the shared types from `@office/shared`
- `packages/web/src/lib/ws.ts` — WebSocket client: subscribe, auto-reconnect with backoff, and backfill through `GET /events?since=` on reconnect
- `packages/web/src/lib/overlays.tsx` — collects `../features/*/overlay.tsx` and renders them
- `packages/web/src/lib/SystemStatus.tsx` — the status strip: renders health conditions generically from events, so a later ticket raises one without editing the shell
- `packages/web/src/styles/global.css` — tokens for colour, spacing and type; light and dark

### Files modified

None.

## Acceptance criteria

- [ ] `pnpm dev` serves the app, and `/api` and `/ws` reach the event server through the dev proxy.
- [ ] The API client's types come from `@office/shared`, not redeclared — a test asserts a compile error when a server type changes incompatibly.
- [ ] The WebSocket client reconnects after the server restarts, and backfills missed events via the `since` cursor so no event is lost and none is applied twice. Asserted by a test that kills and restarts the socket mid-stream.
- [ ] Reconnect uses capped exponential backoff, and the UI shows a visible disconnected state while it is down — a silently stale board is the worst failure mode this page has.
- [ ] The status strip renders any number of concurrent health conditions, driven by event type rather than a hardcoded list — a test raises two at once (socket disconnected and a synthetic condition) and asserts both appear and clear independently. Ticket 020's degraded-guard banner is a consumer of this, not a special case in the shell.
- [ ] Adding `src/features/probe/overlay.tsx` makes it render with no edit to `__root.tsx` or `overlays.tsx` — verified with a temporary file.
- [ ] Two overlays coexist without stacking conflicts, and each controls its own open/closed state.
- [ ] Nav links to `/tasks` and `/control` are plain hrefs, so the pages can land in later tickets without this file changing.
- [ ] The router resolves a parameterised route (`/tasks/:id`) without this file changing, verified with a temporary route file — ticket 031 depends on it.
- [ ] The shell renders correctly at 1280 px and at 400 px width.
- [ ] Colour and spacing are defined once as tokens in `global.css`; later UI tickets consume them rather than hardcoding values.

## Decided

- **The web app is served over `https` and its socket is `wss://`**, per the system-wide decision (see
  the ticket index, "Decisions made"). `src/lib/api.ts` and `src/lib/ws.ts` must not fall back to
  plaintext on failure — a silent downgrade is worse than a visible connection error.

## Open questions

- [ ] **There is no authentication.** The design requires app-level login with per-user identity, because "every message, approval, and acceptance is attributed" — but that is step 9. This ticket ships with a dev-mode identity read from config. Every action the UI takes in step 3 will be attributed to that one identity, which is wrong but visible. Do not expose this app beyond localhost or a trusted network until step 9.
- [ ] The design names no UI framework or styling approach. Assumed React with Vite and plain CSS tokens, consistent with ticket 001's stack assumption. Confirm alongside 001 — the Office page in step 10 forks Pixel Agents, so its stack is worth checking before committing here.
- [ ] Router choice affects the file-based route convention. Assumed a file-routing router so later tickets add pages without editing a route registry. If a different router is chosen, the no-shared-file property has to be preserved another way.
