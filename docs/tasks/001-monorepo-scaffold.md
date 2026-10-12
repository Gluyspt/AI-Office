---
id: "001"
title: Monorepo scaffold and dev environment
build_step: 1
department: dev
estimated_model: sonnet
blocked_by: []
---

# 001 — Monorepo scaffold and dev environment

**Build step:** 1 — Spine
**Department:** dev
**Estimated model:** sonnet — the layout and conventions are specified below; execution is mechanical.
**Blocked by:** none

## Why

Every other ticket in steps 1–3 writes into this layout, so it has to exist first. The
extension-point conventions it establishes (autoloaded route files, numbered migration files,
glob-collected UI overlays) are what let thirty tickets share one codebase without two of them
editing the same file.

## Scope

### Files created

- `package.json` — workspace root; scripts `dev`, `build`, `test`, `typecheck`, `migrate`
- `pnpm-workspace.yaml` — globs `packages/*` so later tickets add packages without editing this file
- `tsconfig.base.json` — strict, NodeNext resolution, ES2023 target
- `.gitignore`
- `.editorconfig`
- `.env.example`
- `deploy/dev/compose.yml` — Postgres 16 only; the app runs on the host in dev
- `vitest.config.ts` — workspace-level config, projects globbed from `packages/*` and `tests/*`
- `packages/shared/package.json` — name `@office/shared`, subpath exports `./*` mapped to `./src/*.ts` (no barrel file, so each ticket owns its own module)
- `packages/shared/tsconfig.json`
- `packages/shared/src/ids.ts` — branded id types and id generation: ProjectId, SessionId, TaskId, EventId
- `README.md` — how to run the stack locally

### Files modified

None — first ticket.

## Acceptance criteria

- [x] `pnpm install` succeeds from a clean checkout on Node 22.
- [x] `pnpm typecheck` passes with zero errors against the empty workspace.
- [x] `pnpm test` runs and reports 0 tests without erroring. *(Verified at the time. No longer
      re-runnable as written — the suite now reports 330; the runner works.)*
- [x] `docker compose -f deploy/dev/compose.yml up -d` starts Postgres, and `psql "$DATABASE_URL" -c 'select 1'` succeeds using the values copied from `.env.example`.
- [x] `.env.example` contains every variable the spine needs, one comment per variable: DATABASE_URL, EVENT_SERVER_PORT, OFFICE_USER, PROJECT_ROOT.
- [x] `tsconfig.base.json` sets `strict: true` and `noUncheckedIndexedAccess: true`.
- [x] `pnpm-workspace.yaml` uses a glob, not an enumerated list — verify by adding a throwaway `packages/probe/package.json` and confirming `pnpm -r list` picks it up, then deleting it.
- [x] `README.md` documents the three extension-point conventions (autoloaded server routes, numbered SQL migrations, `import.meta.glob` UI overlays) so later tickets do not rediscover them.
- [x] `README.md` states the manifest exception: dependency additions to an existing `package.json`, and appended lines in `.env.example`, are append-only and excluded from ticket file scopes.

## Decided

- **Stack: TypeScript on Node 22 with pnpm workspaces.** The design named no language for the office app itself; this was chosen deliberately, and every path in tickets 002–031 follows from it.

### Verification, 2026-09-23

Re-run rather than assumed. Node 22 was confirmed as `v22.23.2` inside `deploy/vps-sim/`, which
pins the major — the host runs v24, so `engines: ">=22"` had been satisfied *vacuously*. The
workspace glob was checked by creating `packages/probe`, confirming `pnpm -r list` picked it up,
and deleting it.

### Reopened 2026-10-12 — `tests/*` joins the workspace (ticket 033)

**Scope:** `pnpm-workspace.yaml`, one line plus its comment.

033 created `tests/boundaries/`, the first standalone test suite, and the typecheck found the gap
that had been latent since this ticket shipped: **`pnpm-workspace.yaml` globs only `packages/*`**, so
anything under `tests/` is not a workspace project. Two consequences, both silent:

- `pnpm -r --if-present run typecheck` skipped it. The suite ran green under Vitest — which reads
  `package.json` directly and needs no workspace membership — while nothing typechecked it.
- It could not declare a dependency. `@types/node` is declared by each of the three packages and is
  *not* hoisted to the root, so `"types": ["node"]` failed to resolve with `TS2688` and the only
  fixes available were to drop node types or vendor a path.

`tests/*` is now in the glob. This is not specific to 033: **tickets 011, 021 and 030 each add a
`tests/*` suite** (`tests/spine/`, `tests/coordination/`, `tests/ui/`) and every one of them would
have hit this. Whichever had landed first would have owned the fix; 033 got there first.

- [x] `pnpm-workspace.yaml` globs `tests/*` alongside `packages/*`, with a comment naming why.
- [x] `npx --yes pnpm@12.5.1 -r --if-present run typecheck` reports **4 of 5 workspace projects** and
      includes `tests/boundaries`; all four pass.
- [x] The existing verification above still holds — the glob is still a glob, not an enumeration.

## Open questions

- [ ] Test runner is unspecified by the design. Assumed **Vitest**, consistent with the stack decision above. Confirm.
- [ ] The design says "Postgres" with no version and no hosting decision (container vs. system package on the VPS). This ticket covers local dev only; the production install is not in step 1.
- [ ] Does the office app live in its own GitHub repo, separate from the managed projects? The design implies it does — "GitHub is the origin" is written about managed projects — but never says so.
