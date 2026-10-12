// The baseline: every cross-feature import that existed when ticket 033 landed.
//
// THIS LIST MAY ONLY SHRINK. It is the one list in this repo with that rule,
// and the rule is what makes the boundary test worth having: a test that
// failed 33 times on the day it landed would have been skipped within a week,
// and a skipped test is worse than no test.
//
// Generated from the tree on 2026-10-12 by the scanner the test uses, not
// transcribed by hand — the count was cross-checked against an independent
// grep census that produced the same 33 edges and the same per-pair
// breakdown.
//
// OWNERSHIP, because this file breaks the usual rule. Every retrofit deletes
// entries from here, so this file cannot belong to 033 alone the way
// `contracts.test.ts` does. DELETING an entry is outside any ticket's file
// scope, the mirror of the manifest exception in docs/tasks/README.md.
// ADDING one is not: a new entry means a new boundary violation, and that
// needs the ticket that introduced it to say why.
//
// Each entry is `<importer> -> <imported>`, repo-relative with POSIX
// separators so the string is identical on Windows and Linux.
export const BASELINE: readonly string[] = [
  "packages/server/src/features/chat/conversations.ts -> packages/server/src/features/events/ingest.ts",
  "packages/server/src/features/chat/conversations.ts -> packages/server/src/features/orchestrator/sessions.ts",
  "packages/server/src/features/chat/handlers/reply.ts -> packages/server/src/features/events/bus.ts",
  "packages/server/src/features/chat/handlers/reply.ts -> packages/server/src/features/events/handler-loader.ts",
  "packages/server/src/features/chat/handlers/reply.ts -> packages/server/src/features/events/ingest.ts",
  "packages/server/src/features/chat/routes/chat.ts -> packages/server/src/features/orchestrator/sessions.ts",
  "packages/server/src/features/chat/transcript.ts -> packages/server/src/features/events/ingest.ts",
  "packages/server/src/features/locks/guard-check.ts -> packages/server/src/features/chat/conversations.ts",
  "packages/server/src/features/locks/guard-check.ts -> packages/server/src/features/events/ingest.ts",
  "packages/server/src/features/locks/handlers/tool.ts -> packages/server/src/features/events/handler-loader.ts",
  "packages/server/src/features/locks/registry.ts -> packages/server/src/features/events/ingest.ts",
  "packages/server/src/features/locks/unguarded-edits.ts -> packages/server/src/features/events/ingest.ts",
  "packages/server/src/features/mcp/protocol.ts -> packages/server/src/features/orchestrator/session-auth.ts",
  "packages/server/src/features/mcp/protocol.ts -> packages/server/src/features/orchestrator/session-token.ts",
  "packages/server/src/features/orchestrator/handlers/session-end.ts -> packages/server/src/features/events/handler-loader.ts",
  "packages/server/src/features/orchestrator/handlers/session-start.ts -> packages/server/src/features/events/handler-loader.ts",
  "packages/server/src/features/orchestrator/pause.ts -> packages/server/src/features/events/ingest.ts",
  "packages/server/src/features/orchestrator/pause.ts -> packages/server/src/features/locks/registry.ts",
  "packages/server/src/features/orchestrator/pause.ts -> packages/server/src/features/tasks/states.ts",
  "packages/server/src/features/orchestrator/resume.ts -> packages/server/src/features/events/ingest.ts",
  "packages/server/src/features/orchestrator/resume.ts -> packages/server/src/features/locks/registry.ts",
  "packages/server/src/features/orchestrator/resume.ts -> packages/server/src/features/tasks/dependencies.ts",
  "packages/server/src/features/orchestrator/resume.ts -> packages/server/src/features/tasks/states.ts",
  "packages/server/src/features/orchestrator/sessions.ts -> packages/server/src/features/events/ingest.ts",
  "packages/server/src/features/realtime/routes/ws.ts -> packages/server/src/features/events/bus.ts",
  "packages/server/src/features/realtime/routes/ws.ts -> packages/server/src/features/events/ingest.ts",
  "packages/server/src/features/tasks/claim.ts -> packages/server/src/features/locks/registry.ts",
  "packages/server/src/features/tasks/complete.ts -> packages/server/src/features/locks/registry.ts",
  "packages/server/src/features/tasks/dependencies.ts -> packages/server/src/features/events/ingest.ts",
  "packages/server/src/features/tasks/repo.ts -> packages/server/src/features/events/ingest.ts",
  "packages/server/src/features/tasks/routes/mcp-tasks.ts -> packages/server/src/features/mcp/protocol.ts",
  "packages/server/src/features/tasks/scope-ordering.ts -> packages/server/src/features/locks/overlap.ts",
  "packages/server/src/features/tasks/states.ts -> packages/server/src/features/events/ingest.ts",
];
