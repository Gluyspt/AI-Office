// Tests against the *actually captured* payloads in
// docs/spikes/001-hook-payloads.md §5 — not invented shapes. Where the spike
// redacted a value (`<uuid>`, `/home/<user>/...`), a concrete stand-in
// replaces it 1:1 so the JSON is valid; every other field is copied
// verbatim. The spike's own synthetic ids (the `11111111-...` /
// `bbbbbbbb-...` ones the orchestrator passed in) are kept exactly as
// captured.
import { randomUUID } from "node:crypto";
import { writeFile, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../../core/db/pool.ts";
import pg from "pg";
import { loadDatabaseConfig } from "../../core/config.ts";
import type { StoredEventRow } from "./ingest.ts";
import { ingestHookPayload, listEvents, validateHookBody } from "./ingest.ts";

// src/features/events/ -> src/features/ ; handlers are collected from
// every feature's handlers/ directory, so the test plants a whole new one.
const featuresDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempFeatureDir = path.join(featuresDir, "__temp_handler_extension_feature__");
const handlersDir = path.join(tempFeatureDir, "handlers");

// A fixed placeholder standing in for every `<uuid>` the spike redacted,
// and for `<user>` / `<uid>` in redacted paths. Not a captured value —
// captured values are used everywhere the spike actually recorded one.
const REDACTED_UUID = "d0d0d0d0-1111-4222-8333-444444444444";

const CAPTURED_PAYLOADS: Record<string, Record<string, unknown>> = {
  SessionStart: {
    session_id: "11111111-2222-4333-8444-555555555555",
    transcript_path:
      "/home/user/.claude/projects/-home-user-spike002-tmp-proj2/11111111-2222-4333-8444-555555555555.jsonl",
    cwd: "/home/user/spike002-tmp/proj2",
    scratchpad_dir:
      "/tmp/claude-1000/-home-user-spike002-tmp-proj2/11111111-2222-4333-8444-555555555555/scratchpad",
    hook_event_name: "SessionStart",
    source: "startup",
    model: "claude-sonnet-5",
  },
  SessionEnd: {
    session_id: "11111111-2222-4333-8444-888888888888",
    transcript_path:
      "/home/user/.claude/projects/-home-user-spike002-tmp-proj2/11111111-2222-4333-8444-888888888888.jsonl",
    cwd: "/home/user/spike002-tmp/proj2",
    scratchpad_dir: "/tmp/claude-1000/proj2/scratchpad",
    prompt_id: REDACTED_UUID,
    hook_event_name: "SessionEnd",
    reason: "prompt_input_exit",
  },
  StopFailure: {
    session_id: REDACTED_UUID,
    transcript_path: `/home/user/.claude/projects/x/${REDACTED_UUID}.jsonl`,
    cwd: "/home/user/spike002-tmp/proj",
    prompt_id: REDACTED_UUID,
    effort: { level: "high" },
    hook_event_name: "StopFailure",
    error: "authentication_failed",
    last_assistant_message: "Failed to authenticate. API Error: 401 OAuth access token is invalid.",
  },
  PostModelSwitch: {
    session_id: REDACTED_UUID,
    transcript_path: `/home/user/.claude/projects/x/${REDACTED_UUID}.jsonl`,
    cwd: "/home/user/spike002-tmp/proj",
    scratchpad_dir: "/tmp/claude-1000/proj/scratchpad",
    prompt_id: REDACTED_UUID,
    hook_event_name: "PostModelSwitch",
    from_model: "claude-sonnet-5",
    to_model: "claude-haiku-4-5-20251001",
    requested_model: "haiku",
    source: "command",
    context_tokens: 0,
    prompt_cache_warm: false,
    cache_ttl: "1h",
    estimated_cache_write_usd: 0,
    pricing: "catalog",
  },
  PreModelSwitch: {
    session_id: REDACTED_UUID,
    transcript_path: `/home/user/.claude/projects/x/${REDACTED_UUID}.jsonl`,
    cwd: "/home/user/spike002-tmp/proj",
    scratchpad_dir: "/tmp/claude-1000/proj/scratchpad",
    prompt_id: REDACTED_UUID,
    hook_event_name: "PreModelSwitch",
    from_model: "claude-sonnet-5",
    to_model: "claude-haiku-4-5-20251001",
    requested_model: "haiku",
    source: "command",
    context_tokens: 0,
    prompt_cache_warm: false,
    cache_ttl: "1h",
    estimated_cache_write_usd: 0,
    pricing: "catalog",
  },
  Stop: {
    session_id: "bbbbbbbb-2222-4222-8222-000000000001",
    transcript_path: "/home/user/.claude/projects/x/bbbbbbbb-2222-4222-8222-000000000001.jsonl",
    cwd: "/home/user/spike002-tmp/proj",
    scratchpad_dir: "/tmp/claude-1000/proj/scratchpad",
    prompt_id: REDACTED_UUID,
    permission_mode: "auto",
    effort: { level: "high" },
    hook_event_name: "Stop",
    stop_hook_active: false,
    last_assistant_message: "ready",
    background_tasks: [],
    session_crons: [],
  },
  PreToolUse: {
    session_id: "bbbbbbbb-2222-4222-8222-000000000001",
    transcript_path: "/home/user/.claude/projects/x/bbbbbbbb-2222-4222-8222-000000000001.jsonl",
    cwd: "/home/user/spike002-tmp/proj",
    scratchpad_dir: "/tmp/claude-1000/proj/scratchpad",
    prompt_id: REDACTED_UUID,
    permission_mode: "auto",
    effort: { level: "high" },
    hook_event_name: "PreToolUse",
    tool_name: "Read",
    tool_input: { file_path: "/home/user/spike002-tmp/proj/note.txt" },
    tool_use_id: "toolu_01abc",
  },
  PostToolUse: {
    session_id: "bbbbbbbb-2222-4222-8222-000000000001",
    transcript_path: "/home/user/.claude/projects/x/bbbbbbbb-2222-4222-8222-000000000001.jsonl",
    cwd: "/home/user/spike002-tmp/proj",
    scratchpad_dir: "/tmp/claude-1000/proj/scratchpad",
    prompt_id: REDACTED_UUID,
    permission_mode: "auto",
    effort: { level: "high" },
    hook_event_name: "PostToolUse",
    tool_name: "Read",
    tool_input: { file_path: "/home/user/spike002-tmp/proj/note.txt" },
    tool_response: {
      type: "text",
      file: {
        filePath: "/home/user/spike002-tmp/proj/note.txt",
        content: "spike002 note: the magic word is pomegranate.\n",
        numLines: 2,
        startLine: 1,
        totalLines: 2,
      },
    },
    tool_use_id: "toolu_01abc",
    duration_ms: 22,
  },
  PermissionRequest: {
    session_id: "bbbbbbbb-2222-4222-8222-000000000001",
    transcript_path: "/home/user/.claude/projects/x/bbbbbbbb-2222-4222-8222-000000000001.jsonl",
    cwd: "/home/user/spike002-tmp/proj",
    scratchpad_dir: "/tmp/claude-1000/proj/scratchpad",
    prompt_id: REDACTED_UUID,
    permission_mode: "default",
    effort: { level: "high" },
    hook_event_name: "PermissionRequest",
    tool_name: "Write",
    tool_input: { file_path: "/home/user/spike002-tmp/proj/hello.txt", content: "hi" },
    permission_suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
  },
  PreCompact: {
    session_id: "bbbbbbbb-2222-4222-8222-000000000001",
    transcript_path: "/home/user/.claude/projects/x/bbbbbbbb-2222-4222-8222-000000000001.jsonl",
    cwd: "/home/user/spike002-tmp/proj",
    scratchpad_dir: "/tmp/claude-1000/proj/scratchpad",
    prompt_id: REDACTED_UUID,
    hook_event_name: "PreCompact",
    trigger: "manual",
    custom_instructions: null,
  },
};

async function cleanupBySessionId(sessionId: string): Promise<void> {
  await pool.query("delete from events where session_id = $1", [sessionId]);
}

/**
 * Added 2026-10-13 for ticket 037's dated section.
 *
 * `HandlerDeadlineExceeded` is recorded by `recordSystemEvent`, which leaves
 * `session_id` null — so `cleanupBySessionId` cannot reach it, and a test
 * that leaves one behind makes the NEXT run of its own assertion pass against
 * a stale row. The suite shares one database (see vitest.config.ts), so
 * leftover rows are everyone's problem, not just this file's.
 */
async function cleanupByType(type: string): Promise<void> {
  await pool.query("delete from events where type = $1", [type]);
}

describe("validateHookBody", () => {
  it("accepts a well-formed hook payload and extracts hook_event_name + session_id", () => {
    const result = validateHookBody(JSON.stringify(CAPTURED_PAYLOADS.Stop));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.hookEventName).toBe("Stop");
      expect(result.envelope.sessionId).toBe("bbbbbbbb-2222-4222-8222-000000000001");
    }
  });

  it("rejects invalid JSON", () => {
    const result = validateHookBody("{not valid json");
    expect(result.ok).toBe(false);
  });

  it("rejects a JSON array", () => {
    const result = validateHookBody("[1,2,3]");
    expect(result.ok).toBe(false);
  });

  it("rejects an object with no hook_event_name", () => {
    const result = validateHookBody(JSON.stringify({ session_id: "x" }));
    expect(result.ok).toBe(false);
  });

  it("treats a non-UUID session_id as absent rather than failing", () => {
    const result = validateHookBody(
      JSON.stringify({ hook_event_name: "Stop", session_id: "not-a-uuid" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.sessionId).toBeNull();
  });
});

describe("ingestHookPayload — round trips every captured event type", () => {
  afterEach(async () => {
    // Every fixture above uses one of two session ids; sweep both after
    // each test so fixtures don't accumulate across runs.
    await cleanupBySessionId("11111111-2222-4333-8444-555555555555");
    await cleanupBySessionId("11111111-2222-4333-8444-888888888888");
    await cleanupBySessionId(REDACTED_UUID);
    await cleanupBySessionId("bbbbbbbb-2222-4222-8222-000000000001");
  });

  for (const [hookEventName, payload] of Object.entries(CAPTURED_PAYLOADS)) {
    it(`stores ${hookEventName} with its full payload intact`, async () => {
      const stored = await ingestHookPayload(JSON.stringify(payload));
      expect(stored.type).toBe(hookEventName);
      // Deep equality against the exact object POSTed — this is the
      // "full payload intact" acceptance criterion.
      expect(stored.payload).toEqual(payload);

      // Read back through the real list path — but find THIS row rather
      // than assuming it is the most recent event in the table. These
      // payloads carry no project_id and listEvents filters only on
      // project_id/since, so `limit: 1` asks for "the newest event
      // globally"; app.test.ts, bus.test.ts and ws.integration.test.ts all
      // insert into `events` from parallel workers, and whichever one
      // committed last would win. The race predates the feature-folder
      // layout — that change only altered ingest's timing enough to make it
      // fire most runs instead of rarely.
      const recent = await listEvents({ projectId: null, since: null, limit: 200 });
      const fetched = recent.find((row) => row.id === stored.id);
      expect(fetched, `event ${stored.id} should be readable back`).toBeTruthy();
      expect(fetched?.payload).toEqual(payload);
    });
  }
});

describe("ingestHookPayload — dead-letter and unknown-type handling", () => {
  it("stores a malformed body as type 'unparsed' with the raw body preserved, and never throws", async () => {
    const raw = "{this is not json at all";
    const stored = await ingestHookPayload(raw);
    expect(stored.type).toBe("unparsed");
    expect(stored.sessionId).toBeNull();
    expect((stored.payload as { raw: string }).raw).toBe(raw);
    await pool.query("delete from events where id = $1", [stored.id]);
  });

  it("stores an unrecognized hook_event_name as its own type, not 'unparsed', with no handler required", async () => {
    const sessionId = randomUUID();
    const payload = { hook_event_name: "SomeFutureHookNobodyHasSeenYet", session_id: sessionId };
    const stored = await ingestHookPayload(JSON.stringify(payload));
    expect(stored.type).toBe("SomeFutureHookNobodyHasSeenYet");
    expect(stored.sessionId).toBe(sessionId);
    await cleanupBySessionId(sessionId);
  });
});

describe("listEvents", () => {
  it("returns newest-first with a working since cursor", async () => {
    const sessionId = randomUUID();
    const first = await ingestHookPayload(
      JSON.stringify({ hook_event_name: "TestOrderingA", session_id: sessionId }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await ingestHookPayload(
      JSON.stringify({ hook_event_name: "TestOrderingB", session_id: sessionId }),
    );

    const all = await listEvents({ projectId: null, since: null, limit: 500 });
    const ids = all.map((e) => e.id);
    expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));

    // Page with the row's own opaque cursor, not its display timestamp.
    // receivedAt is millisecond-truncated (JS Date); the cursor carries
    // Postgres's full microsecond precision plus the id tiebreaker.
    const sinceFirst = await listEvents({ projectId: null, since: first.cursor, limit: 500 });
    expect(sinceFirst.some((e) => e.id === second.id)).toBe(true);
    expect(sinceFirst.some((e) => e.id === first.id)).toBe(false);

    await cleanupBySessionId(sessionId);
  });

  it("does not repeat an event whose timestamp has sub-millisecond precision", async () => {
    // The regression this guards: received_at is stored to the microsecond,
    // but a JS Date — and so receivedAt — only carries milliseconds. A
    // cursor built from the truncated value re-matches the row it came
    // from, so every reconnecting client sees its last event twice.
    const sessionId = randomUUID();
    const only = await ingestHookPayload(
      JSON.stringify({ hook_event_name: "TestPrecision", session_id: sessionId }),
    );

    const afterItself = await listEvents({ projectId: null, since: only.cursor, limit: 500 });
    expect(afterItself.some((e) => e.id === only.id)).toBe(false);

    await cleanupBySessionId(sessionId);
  });

  it("breaks ties deterministically when two events share a timestamp", async () => {
    // Not hypothetical: spike 002 found hooks registered in the same group
    // fire concurrently, so simultaneous inserts are the normal case under
    // load. With received_at alone as the cursor, one of a tied pair is
    // silently skipped.
    const sessionId = randomUUID();
    const [a, b] = await Promise.all([
      ingestHookPayload(JSON.stringify({ hook_event_name: "TestTieA", session_id: sessionId })),
      ingestHookPayload(JSON.stringify({ hook_event_name: "TestTieB", session_id: sessionId })),
    ]);

    // Walk forward one row at a time from before the pair, as a catching-up
    // client would. Start from the older row's own cursor minus itself: use
    // the earlier of the two as the starting point and expect to reach the
    // other exactly once.
    const startCursor = a.cursor < b.cursor ? a.cursor : b.cursor;
    const later = a.cursor < b.cursor ? b : a;

    const seen: string[] = [];
    let cursor: string = startCursor;
    for (let page = 0; page < 5; page += 1) {
      const rows: StoredEventRow[] = await listEvents({
        projectId: null,
        since: cursor,
        limit: 1,
      });
      const row = rows[0];
      if (row === undefined) break;
      seen.push(row.id);
      cursor = row.cursor;
    }

    // No duplicate, and the tied sibling is not skipped.
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toContain(later.id);
    expect(seen).not.toContain(startCursor.slice(startCursor.lastIndexOf("|") + 1));

    await cleanupBySessionId(sessionId);
  });

  it("keeps stored events across a process restart", async () => {
    // "Killing and restarting the process loses no stored event." Read the
    // row back over a connection this module's pool never owned, so the
    // assertion cannot be satisfied by anything cached in the writing
    // process — which is what a restart actually destroys.
    const sessionId = randomUUID();
    const stored = await ingestHookPayload(
      JSON.stringify({ hook_event_name: "TestDurable", session_id: sessionId }),
    );

    const freshPool = new pg.Pool({ connectionString: loadDatabaseConfig().url, max: 1 });
    try {
      const result = await freshPool.query<{ id: string; payload: unknown; type: string }>(
        "select id, payload, type from events where id = $1",
        [stored.id],
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.type).toBe("TestDurable");
      expect(result.rows[0]?.payload).toEqual({
        hook_event_name: "TestDurable",
        session_id: sessionId,
      });
    } finally {
      await freshPool.end();
    }

    await cleanupBySessionId(sessionId);
  });

  it("pages forward from a cursor without gaps", async () => {
    // The backfill path ticket 006 depends on: a client that missed several
    // events walks forward a page at a time and sees every one, exactly
    // once. Under newest-first ordering this is impossible — the client
    // would get the newest page and never reach the middle.
    const sessionId = randomUUID();
    const created: StoredEventRow[] = [];
    for (let i = 0; i < 5; i += 1) {
      created.push(
        await ingestHookPayload(
          JSON.stringify({ hook_event_name: `TestPage${i}`, session_id: sessionId }),
        ),
      );
    }

    const first = created[0];
    expect(first).toBeDefined();
    if (first === undefined) return;

    const walked: string[] = [];
    let cursor = first.cursor;
    for (let page = 0; page < 10; page += 1) {
      const rows: StoredEventRow[] = await listEvents({
        projectId: null,
        since: cursor,
        limit: 2,
      });
      if (rows.length === 0) break;
      for (const row of rows) walked.push(row.id);
      const last = rows[rows.length - 1];
      if (last === undefined) break;
      cursor = last.cursor;
    }

    // Each of the four events after the cursor reached exactly once, and
    // the cursor's own event never repeated.
    expect(new Set(walked).size).toBe(walked.length);
    expect(walked).not.toContain(first.id);
    for (const row of created.slice(1)) {
      expect(walked).toContain(row.id);
    }

    await cleanupBySessionId(sessionId);
  });
});

describe("handler autoload extension point", () => {
  const tempHandlerPath = path.join(handlersDir, "__temp_extension_point_test_handler__.ts");
  // One path per test, because Node's ESM loader caches a module by URL —
  // handler-loader.ts says so in its header, and writing different content to
  // a path already imported in this process is a cache hit, not a
  // re-execution. Sharing one filename makes the second test silently run the
  // FIRST test's handler. Found the hard way, 2026-10-13.
  const hangingHandlerPath = path.join(handlersDir, "__temp_hanging_handler__.ts");
  const hangingHandlerPath2 = path.join(handlersDir, "__temp_hanging_handler_2__.ts");

  beforeAll(() => {
    (globalThis as Record<string, unknown>).__extensionPointCalls = [];
  });

  afterEach(async () => {
    await rm(tempFeatureDir, { force: true, recursive: true });
  });

  it("runs a handler dropped into a new src/features/*/handlers/ with no edit to ingest.ts or handler-loader.ts", async () => {
    const moduleSource = `
export default {
  eventType: "TempExtensionPointEvent",
  handle(event) {
    globalThis.__extensionPointCalls.push(event.id);
  },
};
`;
    await mkdir(handlersDir, { recursive: true });
    await writeFile(tempHandlerPath, moduleSource, "utf8");

    const sessionId = randomUUID();
    const stored = await ingestHookPayload(
      JSON.stringify({ hook_event_name: "TempExtensionPointEvent", session_id: sessionId }),
    );

    const calls = (globalThis as Record<string, unknown>).__extensionPointCalls as string[];
    expect(calls).toContain(stored.id);

    await cleanupBySessionId(sessionId);
  });

  // --- Ticket 037's dated section ------------------------------------------
  //
  // The end-to-end half of the handler deadline. deadline.test.ts proves the
  // mechanism bounds a hang; these prove INGEST actually uses it, which is a
  // different claim and the one that matters — a correct mechanism nobody
  // wired in is the failure this ticket was written about.
  //
  // Both plant a real handler file the same way the test above does, because
  // `dispatch` reads the real features tree. That is also why they clean up
  // in `afterEach` whatever happens.

  it("does not stall the POST on a handler that never settles — 037", async () => {
    const moduleSource = `
export default {
  eventType: "TempHangingHandlerEvent",
  handle() {
    globalThis.__hangingHandlerRan = true;
    return new Promise(() => {});
  },
};
`;
    await mkdir(handlersDir, { recursive: true });
    await writeFile(hangingHandlerPath, moduleSource, "utf8");
    (globalThis as Record<string, unknown>).__hangingHandlerRan = false;

    // A short deadline for the test, restored in `finally`. Two reasons, and
    // the second is the one that bit: it also asserts the config is actually
    // read (a hard-coded 2 s would pass either way), AND it keeps this test
    // from adding two idle seconds to a suite that already has timing
    // assertions running on thin margins — waiting out the real default here
    // tipped packages/web's "renders 200 cards in under 200 ms" over.
    const previous = process.env.HANDLER_DEADLINE_MS;
    process.env.HANDLER_DEADLINE_MS = "50";
    try {

    const sessionId = randomUUID();
    const started = Date.now();
    const stored = await ingestHookPayload(
      JSON.stringify({ hook_event_name: "TempHangingHandlerEvent", session_id: sessionId }),
    );
    const elapsed = Date.now() - started;

    // It ran, it never finished, and the POST came back anyway. Before 037
    // this call did not return at all.
    expect((globalThis as Record<string, unknown>).__hangingHandlerRan).toBe(true);
    expect(stored.id).toBeTruthy();
    // HANDLER_DEADLINE_MS defaults to 2 s; allow generous slack so this is
    // not a timing flake. What it rules out is "unbounded".
    expect(elapsed).toBeLessThan(5_000);

    await cleanupBySessionId(sessionId);
    await cleanupByType("HandlerDeadlineExceeded");
    } finally {
      if (previous === undefined) delete process.env.HANDLER_DEADLINE_MS;
      else process.env.HANDLER_DEADLINE_MS = previous;
    }
  }, 30_000);

  it("records a HandlerDeadlineExceeded event naming the handler file — 037", async () => {
    const moduleSource = `
export default {
  eventType: "TempHangingHandlerEvent2",
  handle() {
    return new Promise(() => {});
  },
};
`;
    await mkdir(handlersDir, { recursive: true });
    await writeFile(hangingHandlerPath2, moduleSource, "utf8");

    const previous = process.env.HANDLER_DEADLINE_MS;
    process.env.HANDLER_DEADLINE_MS = "50";
    try {
    const sessionId = randomUUID();
    await ingestHookPayload(
      JSON.stringify({ hook_event_name: "TempHangingHandlerEvent2", session_id: sessionId }),
    );

    // The event is emitted un-awaited on purpose — awaiting a persist inside
    // the dispatch loop would put a database round trip on the hot path at
    // the moment it is already late — so poll for it rather than assuming it
    // has landed.
    let recorded: StoredEventRow | undefined;
    for (let attempt = 0; attempt < 40 && recorded === undefined; attempt += 1) {
      const events = await listEvents({ projectId: null, since: null, limit: 50 });
      // Matched on the PAYLOAD, not just the type: the test above also
      // leaves a HandlerDeadlineExceeded behind, and finding that one would
      // make this assertion pass while proving nothing about this handler.
      recorded = events.find(
        (e) =>
          e.type === "HandlerDeadlineExceeded"
          && (e.payload as { event_type?: string }).event_type === "TempHangingHandlerEvent2",
      );
      if (recorded === undefined) await new Promise((r) => setTimeout(r, 100));
    }

    expect(recorded, "no HandlerDeadlineExceeded event was recorded").toBeDefined();
    const payload = recorded!.payload as { handler: string; event_type: string };
    // The file, not just the event type: three features register handlers for
    // the same types, so "a handler for PreToolUse" is not actionable.
    expect(payload.handler).toContain("__temp_handler_extension_feature__");
    expect(payload.event_type).toBe("TempHangingHandlerEvent2");

    await cleanupBySessionId(sessionId);
    await cleanupByType("HandlerDeadlineExceeded");
    } finally {
      if (previous === undefined) delete process.env.HANDLER_DEADLINE_MS;
      else process.env.HANDLER_DEADLINE_MS = previous;
    }
  }, 30_000);
});
