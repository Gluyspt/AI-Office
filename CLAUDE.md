# AI Agent Office

A self-hosted web app on a shared VPS where a three-person team runs Claude Code agents like a
company. Each project is an office section with its own departments and knowledge graph; anyone on
the team can watch progress, talk to any agent, review finished work, and accept or send it back.

**This repo is the orchestrator itself** — separate from the project repos its agents work on.

## State

Docs only. No code yet. Implementation starts at ticket 001.

| Path | What |
| --- | --- |
| `docs/ai-agent-office-design.md` | The system design. The source of truth for intent |
| `docs/tasks/` | 32 implementation tickets covering build steps 1–3 |
| `docs/tasks/README.md` | Ticket index: dependency graph, file ownership map, decisions made, what's still open |

Read `docs/tasks/README.md` before touching the ticket set — it carries the conventions that keep 32
tickets from colliding.

## Workflow

### Commits

When asked to write a commit, do all three of these unless told otherwise:

1. **Commit** — write the message, explaining *why* rather than restating the diff
2. **Create a Linear issue** for the work (see below)
3. **Push** to `origin`

Don't split these into a question each time. One report at the end covering all three.

Step 3 is also enforced by a `PostToolUse` hook (`.claude/hooks/push-after-commit.mjs`),
so a commit pushes even if this file is not read. The hook never forces and never merges —
a rejected push is reported and left for a human, per the conflict rule below. Its
`systemMessage` goes to the user's terminal, not into the model's context, so confirm a push
landed with `git status` rather than assuming.

### Linear

- Workspace team **Gluyspt**, project **AI-Office**
- Issue titles mirror ticket files: `NNN — Title`
- Labels: `step-1-spine` / `step-2-coordination` / `step-3-tasks-ui`, `dept:dev` / `dept:research` /
  `dept:qa`, `model:opus` / `model:sonnet`
- Issue bodies carry file scope, acceptance criteria as checkboxes, `## Decided` where a decision was
  made, and open questions — plus a `Source:` line pointing at the ticket file
- Dependencies are `blockedBy` relations, mirroring each ticket's `blocked_by`
- New issues start in **Backlog**; move to **Todo** only when actually startable

### Git conflicts — always ask

**Never resolve a git conflict without asking.** On a merge, rebase or pull conflict: stop, show what
conflicts, and wait. The same goes for anything with a destructive edge — force-push, divergent
history, `reset --hard`, discarding local changes. Describe the options and let the human pick.

## Conventions

### One file, one ticket

No file appears in two tickets' scopes. This is what lets tickets run in parallel, and it is
verifiable — `docs/tasks/README.md` carries the full ownership map. Five structural conventions make
it hold:

| Convention | Set by | Lets a later ticket |
| --- | --- | --- |
| Server routes autoloaded from `packages/server/src/routes/` | 005 | add an endpoint, no registry edit |
| Event handlers collected from `packages/server/src/events/handlers/` | 005 | add per-event behaviour, no dispatcher edit |
| Hook config merged from `config/hooks/fragments/` | 009 | add a hook entry, no template edit |
| Numbered SQL files in `db/migrations/` | 004 | add a table, no schema file edit |
| UI overlays collected by `import.meta.glob` from `src/features/*/overlay.tsx` | 022 | add a panel, no shell edit |
| File-based routes in `packages/web/src/routes/` | 022 | add a page, no route table edit |

**Manifest exception:** dependency additions to an existing `package.json`, appended lines in
`.env.example`, and **a new `loadXConfig()` section appended to `packages/server/src/config.ts`**, are
append-only and outside any ticket's file scope.

The config case was added after ticket 004 shipped: `config.ts` is owned by 004 permanently, but
every later server ticket needs its own environment variables validated, and 004 cannot invent a
validation shape for needs that do not exist yet. Appending a self-contained
`loadXConfig(env = process.env)` is therefore allowed. Editing an existing section, the shared
helpers, or `ConfigError` is not — that belongs to 004.

### Stack

**TypeScript on Node 22, pnpm workspaces, Postgres, Vitest, React + Vite.** The design never named a
language for the office app itself — this was decided deliberately, and every ticket path follows
from it. Don't re-litigate it without saying so.

### Open questions stay open

Where the design leaves something undecided, it is written as an open question in the ticket that
hits it — not resolved by invention. When you hit one, either answer it with the human or state the
assumption you're proceeding under. Don't quietly pick.

Decisions that have been made are recorded in `## Decided` sections in the affected tickets and
summarised in the ticket index.
