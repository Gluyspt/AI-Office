---
id: "015"
title: Ownership registry — file-scope locks
build_step: 2
department: dev
estimated_model: opus
blocked_by: ["012"]
---

# 015 — Ownership registry: file-scope locks

**Build step:** 2 — Coordination
**Department:** dev
**Estimated model:** opus — three independent release paths and an overlap algorithm that has to be right under concurrency.
**Blocked by:** 012

## Why

"Keep agents from creating git conflicts, reliably" is one of the five goals. The registry is how:
every task declares the files it touches, and overlapping active tasks are refused. Two later guards —
`claim_task` in ticket 017 and the PreToolUse hook in ticket 020 — are both thin callers of this module.

The design is explicit that no single release path is reliable, so all three must exist: normal release
on completion, `SessionEnd`, and a TTL with a heartbeat.

## Scope

### Files created

- `db/migrations/0007_file_locks.sql` — `file_locks`: id, project_id, task_id, session_id, path_pattern, acquired_at, expires_at, paused, released_at; unique on active (project_id, path_pattern)
- `packages/server/src/features/locks/overlap.ts` — pure overlap logic between two file-scope declarations
- `packages/server/src/features/locks/registry.ts` — acquire, release, `releaseBySession`, heartbeat, expire, `listActive`
- `packages/shared/src/locks.ts` — lock record and file-scope declaration types
- `packages/server/src/features/locks/routes/locks.ts` — `GET /locks`, `POST /locks/expire` (the sweeper trigger)

### Files modified

None.

## Decided

**A scope is a list of patterns, and any pattern may be a literal file, a directory prefix, or a glob.** This covers both of the design's examples — a review-comment task owning one file, a dev task owning a directory — without forcing Management to enumerate every path at planning time.

Glob-versus-glob overlap is undecidable in general. **Resolve conservatively: when the algorithm cannot prove two patterns are disjoint, report a conflict.** A false conflict costs one serialised task; a false clearance costs a git conflict, which is the failure this registry exists to prevent.

Source: `docs/spikes/001-hook-payloads.md`.

- **`releaseBySession` must exclude `reason: "clear"`.** `SessionEnd` fires when a user or agent runs
  `/clear` — and the agent carries on working afterwards. A release path that treats every `SessionEnd`
  as "this session is finished" will free locks out from under a live agent still holding them, which is
  precisely the git conflict this registry exists to prevent. Observed `SessionEnd` reasons: `clear`,
  `other`, `prompt_input_exit`. Release on the latter two; ignore `clear`.
- **The SessionEnd release path may not be reliable at all.** Whether `tmux kill-session` fires
  `SessionEnd` is *unmeasured* — ticket 003 deferred it and 007 now owns it. If it does not, TTL expiry
  becomes the primary release path rather than the backstop, which raises the stakes on the lock-TTL
  number that is still an open question below. Do not let TTL default to something comfortable on the
  assumption that SessionEnd usually catches it first.
- **The `PostToolUse` heartbeat trigger is still unfounded.** `PostToolUse` was never observed firing
  during the spike, and it is absent from the design's hook block. The heartbeat endpoint is exposed here
  and its trigger stays with ticket 020, as the ticket already says — but nobody has yet seen the event
  that is supposed to drive it.

## Acceptance criteria

- [ ] Acquiring a scope that overlaps an active lock fails and names the conflicting task; acquiring a disjoint scope succeeds.
- [ ] Two globs whose disjointness cannot be proven are reported as conflicting, and the refusal says the verdict was conservative rather than certain.
- [ ] Overlap is tested as a table: identical paths, one path inside the other's directory, sibling paths, a glob covering a literal, two overlapping globs, and the same file reached by two different relative spellings — all with the expected verdict.
- [ ] Acquisition of a multi-file scope is all-or-nothing: a scope where one of five files conflicts acquires none of them.
- [ ] Two concurrent acquisitions of overlapping scopes: exactly one succeeds. Asserted with a real concurrent test against the database, not a mocked one.
- [ ] `releaseBySession` releases every lock held by a session — the SessionEnd path.
- [ ] A heartbeat extends `expires_at`; a lock past `expires_at` is reclaimable, and the sweeper releases it and emits an event so the reclaim is visible rather than silent.
- [ ] Locks marked `paused` are exempt from TTL expiry and are not reclaimable, per the design's pause behaviour.
- [ ] Releasing an already-released lock is idempotent.
- [ ] A lock whose task no longer exists is reported by the sweeper rather than left forever.

## Open questions

- [ ] Path normalisation is unaddressed by the design: the same file can be written `./src/a.ts`, `src/a.ts`, or with a Windows separator. All patterns are normalised to repo-relative POSIX form before comparison; a test covers each spelling. Flagged because a normalisation gap silently defeats the whole registry.
- [ ] **Lock TTL default is one of the design's own open questions** ("Default caps: ... lock TTL?"). Implemented as config with no default value shipped; the system refuses to start without it, so the number gets chosen deliberately.
- [ ] The heartbeat is specified to refresh on `PostToolUse`, but `PostToolUse` is not in the design's hook config block. Either the hook list is incomplete or the heartbeat needs another source. This ticket exposes a heartbeat endpoint and leaves the trigger to ticket 020.
- [ ] Nothing says whether a lead can force-release another owner's lock. Not implemented; an operator would go to the database. Worth a UI affordance later.
