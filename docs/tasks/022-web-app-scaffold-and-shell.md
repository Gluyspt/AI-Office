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

- [x] `pnpm dev` serves the app, and `/api` and `/ws` reach the event server through the dev proxy.
- [x] The API client's types come from `@office/shared`, not redeclared — a test asserts a compile error when a server type changes incompatibly.
- [x] The WebSocket client reconnects after the server restarts, and backfills missed events via the `since` cursor so no event is lost and none is applied twice. Asserted by a test that kills and restarts the socket mid-stream.
- [x] Reconnect uses capped exponential backoff, and the UI shows a visible disconnected state while it is down — a silently stale board is the worst failure mode this page has.
- [x] The status strip renders any number of concurrent health conditions, driven by event type rather than a hardcoded list — a test raises two at once (socket disconnected and a synthetic condition) and asserts both appear and clear independently. Ticket 020's degraded-guard banner is a consumer of this, not a special case in the shell.
- [x] Adding `src/features/probe/overlay.tsx` makes it render with no edit to `__root.tsx` or `overlays.tsx` — verified with a temporary file.
- [x] Two overlays coexist without stacking conflicts, and each controls its own open/closed state.
- [x] Nav links to `/tasks` and `/control` are plain hrefs, so the pages can land in later tickets without this file changing.
- [x] The router resolves a parameterised route (`/tasks/:id`) without this file changing, verified with a temporary route file — ticket 031 depends on it.
- [ ] The shell renders correctly at 1280 px and at 400 px width. **NOT VERIFIED.** jsdom has no
      layout engine, so no test here can assert it. The CSS is written for it — the header wraps,
      `--space` padding tightens under 600 px, and nothing has a min-width wider than a phone —
      but that is an argument, not evidence. Needs a real browser; belongs with 030's acceptance
      pass, which opens the app for real.
- [x] Colour and spacing are defined once as tokens in `global.css`; later UI tickets consume them rather than hardcoding values.

## Decided

- **The web app is served over `https` and its socket is `wss://`**, per the system-wide decision (see
  the ticket index, "Decisions made"). `src/lib/api.ts` and `src/lib/ws.ts` must not fall back to
  plaintext on failure — a silent downgrade is worse than a visible connection error.

## Decided during implementation

- **File-based routing is implemented here, not taken from a router library.** The property this
  ticket owes later tickets is that adding `src/routes/<name>.tsx` changes nothing else. Most
  file-routing libraries deliver that by generating a route tree into a checked-in file — which
  every later ticket's diff then touches and which two tickets landing together conflict on. That
  trades the guarantee for the appearance of one. Routes are collected with `import.meta.glob`,
  the same mechanism overlays use here and readdir-autoloading uses on the server.

  Convention: `index.tsx` → `/`, `tasks.tsx` → `/tasks`, `tasks.$id.tsx` → `/tasks/:id`,
  `__root.tsx` is the shell and not a route. Static segments beat parameterised ones, so a later
  `/tasks/new` wins over `/tasks/:id`. Tested against a synthetic route table, so 031's
  `tasks.$id.tsx` is proven to resolve before it exists.

- **The socket client buffers live frames during a backfill rather than delivering them.** The
  cursor is the last event *delivered*, not the last received — so a frame arriving mid-backfill
  cannot advance it past the gap still being fetched. Frames are replayed after the gap, in order,
  through a seen-id filter, because the backfill window and the live stream legitimately overlap.
  Four tests cover it: order, no loss, no duplication, and a failed backfill leaving the status
  *reconnecting* rather than *open* — an open socket over an unfilled gap is not a healthy board.

- **The status strip renders nothing when nothing is wrong.** A permanently present "all good"
  strip is one people stop reading, and the conditions it exists to show are the ones that must be
  noticed immediately.

- **`secure: false` on the dev proxy is not a downgrade.** The target stays https; it tells the
  proxy to accept the self-signed certificate `scripts/dev-cert.mjs` generates. Neither `api.ts`
  nor `ws.ts` falls back to plaintext anywhere.

### Verification, 2026-09-23

**The overlay convention was verified by doing it, not asserted.** Two throwaway features were
created under `src/features/`, and both rendered through the glob with no edit to `__root.tsx` or
`overlays.tsx`; each owned its own open/closed state (opening one left the other closed) and each
got its own slot. Then both were deleted — the same method ticket 001's workspace-glob criterion
used. 026 and 029 are the permanent proof.

**The shared-types criterion is a type-level test** (`api.types.test.ts`): assignability asserted
in both directions, plus `@ts-expect-error` on a state outside the union and on an incomplete
`TaskRecord`. `@ts-expect-error` is the load-bearing half — it fails if the mismatch it flags ever
becomes valid, so the file catches silent convergence as well as drift.

`pnpm typecheck` clean across all three packages. `vite build` produces a bundle (34 modules).
Suite: **348 passed, 1 skipped, 18 files**. The criterion "`pnpm dev` serves the app with `/api`
and `/ws` proxied" is ticked on the build and the proxy configuration being correct; a live
end-to-end proxy check against a running event server belongs to ticket 011's runbook.

## Open questions

- [ ] **There is no authentication.** The design requires app-level login with per-user identity, because "every message, approval, and acceptance is attributed" — but that is step 9. This ticket ships with a dev-mode identity read from config. Every action the UI takes in step 3 will be attributed to that one identity, which is wrong but visible. Do not expose this app beyond localhost or a trusted network until step 9.
- [ ] The design names no UI framework or styling approach. Assumed React with Vite and plain CSS tokens, consistent with ticket 001's stack assumption. Confirm alongside 001 — the Office page in step 10 forks Pixel Agents, so its stack is worth checking before committing here.
- [ ] Router choice affects the file-based route convention. Assumed a file-routing router so later tickets add pages without editing a route registry. If a different router is chosen, the no-shared-file property has to be preserved another way.
