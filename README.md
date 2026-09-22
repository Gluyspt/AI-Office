# AI Agent Office

A self-hosted web app where a small team runs Claude Code agents like a company: task board,
per-agent chat, tmux-backed sessions, and an event log everything else is built on. See
[`docs/ai-agent-office-design.md`](docs/ai-agent-office-design.md) for the system design and
[`docs/tasks/README.md`](docs/tasks/README.md) for the ticket index this repo is built from.

This README covers running the stack locally, and the extension-point conventions that let ~30
tickets share one codebase without editing the same file twice. Read the second half before adding
a new package, route, migration, or UI panel — the convention it follows is almost certainly already
here.

## Requirements

- Node 22 (`engines.node` in `package.json` enforces `>=22`)
- pnpm (via `corepack enable pnpm`, or `npx pnpm@latest` if corepack can't write to your Node
  install)
- Docker, for Postgres in local dev

## Running locally

```sh
cp .env.example .env                           # then edit if your ports/paths differ
pnpm install
docker compose -f deploy/dev/compose.yml up -d # starts Postgres 16
node scripts/dev-cert.mjs                      # writes .devtls/{cert,key}.pem
pnpm migrate                                   # applies db/migrations/*.sql
pnpm dev
```

**Do not skip the certificate step.** Every endpoint in this system is https, loopback included,
so the server will not start without TLS material — and `.env.example` ships *production* paths
(`/srv/office/tls/...`) that exist on no developer machine. Copy it verbatim, skip this, and around
a dozen test suites fail with `ENOENT` errors that read like broken code. `scripts/dev-cert.mjs`
prints the two lines to paste into `.env` once it has written the pair. On a real host the same
pair comes from `deploy/host/provision-host.sh` instead.

`deploy/dev/compose.yml` starts Postgres only — the office app itself (event server + web app) runs
on the host, not in a container, so hooks and tmux sessions on the same machine can reach it without
crossing a container boundary.

Other root scripts, each fanning out to every workspace package that defines a matching script:

| Script | Does |
| --- | --- |
| `pnpm dev` | Runs every package's `dev` script (server, web, …) |
| `pnpm build` | Runs every package's `build` script |
| `pnpm test` | Runs the whole workspace's tests once, via the root `vitest.config.ts` |
| `pnpm typecheck` | Runs every package's `typecheck` script (`tsc --noEmit`) |
| `pnpm migrate` | Applies pending SQL migrations, via `packages/server`'s migration runner |

`pnpm -r --if-present run <script>` is used for `dev`/`build`/`typecheck` instead of a hardcoded
package list, for the same reason as the extension points below: adding a package means adding its
`package.json`, not editing the root one.

### Environment variables

`.env.example` documents every variable the spine needs; copy it to `.env` and adjust. `.env` itself
is gitignored — nothing secret should ever reach a clone (see `.gitignore`). Variables land here only
when a ticket's code reads them; don't add speculative config.

## Extension points

Three conventions exist so that a later ticket adds behaviour by adding a file, never by editing a
file another ticket owns. This is what makes "one file, one ticket" (see
[`docs/tasks/README.md`](docs/tasks/README.md#conventions)) hold instead of merely being a policy.
A few more conventions of the same shape get established later (hook config fragments in ticket 009,
file-based web routes in ticket 022) — the index above tracks the full set as they land. The three
that exist from this ticket on:

**Autoloaded server routes.** The server is laid out as one folder per feature under
`packages/server/src/features/`, with shared infrastructure (the Fastify app, the config reader,
the database pool) in `packages/server/src/core/`. Route handlers live one-per-file under their
own feature's `routes/` directory — `features/tasks/routes/tasks.ts`, and so on. The server
(ticket 005) walks every `features/*/routes/` directory at startup instead of importing from a
central registry. Adding an endpoint means adding a file to a feature's `routes/`, or adding a
whole new feature folder; it never touches a file another route owns.

The unit that is autoloaded is the **file**, not the feature: several tickets add endpoints to the
same area (013 tasks, 014 dependencies, 017 actions, 032 advance), and one-file-one-ticket needs
each of them to own a separate file.

**Event handlers live with their feature.** `features/*/handlers/` is collected the same way, so a
handler sits next to the code it serves — the Stop-hook reply handler under `features/chat/`, the
tool handler under `features/locks/` — rather than in one shared directory.

**Numbered SQL migrations.** Schema changes are individual files in `db/migrations/`, named
`NNNN_description.sql` (four-digit, zero-padded, strictly increasing). The migration runner (ticket
004) reads the directory, sorts **by filename**, and applies whatever hasn't run yet, recording each
one it applies. Adding a table means adding the next-numbered file; it never means editing a shared
schema file. Filename order is load-bearing — don't rely on directory listing order, which isn't
guaranteed to match.

**`import.meta.glob`-collected UI overlays.** Slide-in panels in the web app live at
`src/features/*/overlay.tsx`, one per feature. The app shell (ticket 022) collects them with Vite's
`import.meta.glob`, so a new feature's overlay is picked up by adding the file at that path — the
shell is never edited to register it.

All three share the same shape: a directory (or filename pattern) that a piece of loader code scans
at startup or build time, instead of a list some file maintains by hand. When you're adding something
that feels like "one more of an existing kind of thing," look for a directory like this before adding
an entry to a registry — there almost certainly is one, and if there isn't yet, a later ticket may be
about to establish one.

## Manifest exception

The "one file, one ticket" rule has exactly one carve-out: **dependency additions to an existing
`package.json`, and appended lines in `.env.example`, are append-only and are not part of any
ticket's file scope.** A ticket that needs a new npm dependency, or a new environment variable,
adds it without that counting as touching a file it doesn't own — the ownership map governs
*structural* edits (scripts, exports, new files), not appending a dependency entry or an env var
line. If a change to one of these files is anything other than a pure append (removing a script,
renaming an export, reordering `.env.example`), it isn't covered by this exception and belongs to
whichever ticket owns the file.

## Workspace layout

```
packages/
  shared/       @office/shared — types and helpers with no runtime of their own, shared by
                server, web, and the MCP packages. No barrel file: import submodules directly,
                e.g. `@office/shared/ids` (see its package.json `exports` map).
  server/       the event server + orchestrator (ticket 004+)
  web/          the React + Vite web app (ticket 022+)
  mcp-tasks/    MCP server exposing claim_task / complete_task (ticket 017+)
  mcp-session/  MCP server exposing session control tools (ticket 018+)
db/
  migrations/   numbered SQL files, see "Extension points" above
tests/
  integration and e2e suites that don't belong to a single package (ticket 011+)
docs/
  the design doc and the ticket set this repo implements
```

`pnpm-workspace.yaml` globs `packages/*`, so a new package under `packages/` is picked up by
`pnpm install` without editing that file.

## Open questions carried from ticket 001

- **Test runner.** The design doesn't name one. This repo uses Vitest, consistent with the
  TypeScript/Node/pnpm stack decision — see `docs/tasks/001-monorepo-scaffold.md`.
- **Postgres version and production hosting.** `deploy/dev/compose.yml` pins Postgres 16 for local
  dev only. Whether production runs Postgres in a container or as a system package on the VPS, and
  on what version, is not decided here.
- **Repo topology.** Whether this office app lives in its own repo permanently separate from the
  projects it manages (as opposed to, say, living alongside one of them) is implied but not stated
  by the design.
