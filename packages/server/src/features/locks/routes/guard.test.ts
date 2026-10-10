// The guard endpoints over the real app, through Fastify's inject().
//
// What is asserted here that the unit tests cannot: that the routes are
// autoloaded at all (005's convention — a file in features/*/routes/ with no
// registry edit), that a refusal is a **200** carrying the blocking fields
// rather than a non-2xx (spike 001 §2b: blocking is carried by the body of a
// 2xx; a 500 does not block), and that the token check behaves like
// /events/*'s.
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProjectId, TaskId } from "@office/shared/ids";
import { buildApp } from "../../../core/app.ts";
import { pool } from "../../../core/db/pool.ts";
import { loadServerConfig } from "../../../core/config.ts";
import { createTask } from "../../tasks/model.ts";
import { insertTask } from "../../tasks/repo.ts";
import { acquireScope } from "../registry.ts";

const TTL = 900;
const CWD = "/srv/office/projects/demo";
const TOKEN = loadServerConfig().hookIngestTokens[0]!;

let app: FastifyInstance;
const createdProjects: string[] = [];

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
  for (const id of createdProjects) {
    await pool.query("delete from projects where id = $1", [id]);
  }
});

async function makeProject(): Promise<ProjectId> {
  const slug = `t020r-${randomUUID()}`;
  const { rows } = await pool.query<{ id: string }>(
    `insert into projects (name, slug, repo_url) values ($1, $2, $3) returning id`,
    [slug, slug, "https://example.invalid/repo.git"],
  );
  const id = rows[0]!.id;
  createdProjects.push(id);
  return id as ProjectId;
}

async function makeTask(projectId: ProjectId, title: string, owner = "agent1"): Promise<TaskId> {
  const record = await insertTask(createTask({ projectId, title, department: "dev", owner }));
  return record.id;
}

async function makeSession(projectId: ProjectId): Promise<{ rowId: string; claudeId: string }> {
  const claudeId = randomUUID();
  const { rows } = await pool.query<{ id: string }>(
    `insert into sessions
       (project_id, tmux_name, role, dept, owner, backend, model, model_reason,
        status, claude_session_id)
     values ($1, $2, 'dept_lead', 'dev', 'agent1', 'claude', 'claude-sonnet-5',
             'test fixture', 'running', $3)
     returning id`,
    [projectId, `t020r-${randomUUID()}`, claudeId],
  );
  return { rowId: rows[0]!.id, claudeId };
}

/** The captured PreToolUse envelope, as the http hook would POST it. */
function payload(claudeId: string, filePath: string): string {
  return JSON.stringify({
    session_id: claudeId,
    transcript_path: `/home/agent1/.claude/projects/x/${claudeId}.jsonl`,
    cwd: CWD,
    scratchpad_dir: "/tmp/claude-1000/x/scratchpad",
    prompt_id: randomUUID(),
    permission_mode: "manual",
    effort: { level: "high" },
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_input: {
      file_path: filePath,
      old_string: "a",
      new_string: "b",
      content: "WHOLE FILE BODY, WHICH MUST NOT BE READ OR LOGGED",
    },
    tool_use_id: `toolu_${randomUUID()}`,
  });
}

describe("POST /guard/check", () => {
  it("is autoloaded, and refuses an unknown token like /events/* does", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/guard/check?token=not-a-real-token",
      headers: { "content-type": "application/json" },
      payload: payload(randomUUID(), `${CWD}/src/a.ts`),
    });
    // 404 would mean the route file was never loaded; 401 means it was.
    expect(response.statusCode).toBe(401);
  });

  it("blocks with a 200 whose body carries the deny shape, not with a non-2xx", async () => {
    const project = await makeProject();
    const session = await makeSession(project);
    const owner = await makeTask(project, "route owner", "agent2");
    await acquireScope({
      projectId: project,
      taskId: owner,
      sessionId: randomUUID(),
      patterns: ["src/db/"],
      ttlSeconds: TTL,
    });

    const response = await app.inject({
      method: "POST",
      url: `/guard/check?token=${TOKEN}`,
      headers: { "content-type": "application/json" },
      payload: payload(session.claudeId, `${CWD}/src/db/schema.ts`),
    });

    // A 500 does NOT block (measured). The refusal has to ride a 2xx.
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body.decision).toBe("block");
    expect((body.hookSpecificOutput as Record<string, unknown>).permissionDecision).toBe("deny");
    expect(String((body.hookSpecificOutput as Record<string, unknown>).permissionDecisionReason))
      .toContain("route owner");
    expect(response.body).not.toContain("continue");

    // And the refusal is on the record, for the board.
    const { rows } = await pool.query<{ payload: Record<string, unknown> }>(
      `select payload from events where type = 'GuardEditBlocked' and project_id = $1`,
      [project],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.paths).toEqual(["src/db/schema.ts"]);
    // The file body must not have ridden along into the event store.
    expect(JSON.stringify(rows[0]!.payload)).not.toContain("MUST NOT BE READ");
  });

  it("allows with a body that cannot change the permission system", async () => {
    const project = await makeProject();
    const session = await makeSession(project);
    const response = await app.inject({
      method: "POST",
      url: `/guard/check?token=${TOKEN}`,
      headers: { "content-type": "application/json" },
      payload: payload(session.claudeId, `${CWD}/README.md`),
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("hookSpecificOutput");
    expect(response.body).not.toContain("permissionDecision");
    expect(response.body).not.toContain("continue");
    expect((response.json() as { office: { outcome: string } }).office.outcome).toBe("allow");
  });

  it("fails open on an unparseable payload rather than blocking every tool call", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/guard/check?token=${TOKEN}`,
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { office: { outcome: string; degraded: boolean } };
    expect(body.office.outcome).toBe("allow");
    expect(body.office.degraded).toBe(true);
  });

  it("does not store a second copy of the tool event — /events/tool already did", async () => {
    // The base hook template posts every PreToolUse to /events/tool with no
    // matcher. Ingesting here as well would duplicate the row AND the file
    // body inside it.
    const project = await makeProject();
    const session = await makeSession(project);
    await app.inject({
      method: "POST",
      url: `/guard/check?token=${TOKEN}`,
      headers: { "content-type": "application/json" },
      payload: payload(session.claudeId, `${CWD}/README.md`),
    });
    const { rows } = await pool.query<{ n: string }>(
      `select count(*)::text as n from events
        where type = 'PreToolUse' and session_id = $1`,
      [session.claudeId],
    );
    expect(rows[0]!.n).toBe("0");
  });
});

describe("POST /guard/flush", () => {
  it("accepts an empty flush — it is the script's reachability probe", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/guard/flush?token=${TOKEN}`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ dropped: 0, edits: [] }),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { ok: boolean; accepted: number };
    expect(body.ok).toBe(true);
    expect(body.accepted).toBe(0);
    await pool.query(
      `delete from events where type = 'UnguardedEditsFlushed' and project_id is null`,
    );
  });

  it("refuses an unknown token", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/guard/flush?token=nope",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ edits: [] }),
    });
    expect(response.statusCode).toBe(401);
  });

  it("ingests a buffer and reports the ids it now holds", async () => {
    const project = await makeProject();
    const session = await makeSession(project);
    const owner = await makeTask(project, "flush route owner", "agent2");
    await acquireScope({
      projectId: project,
      taskId: owner,
      sessionId: randomUUID(),
      patterns: ["src/flushed/"],
      ttlSeconds: TTL,
    });
    const editId = randomUUID();

    const response = await app.inject({
      method: "POST",
      url: `/guard/flush?token=${TOKEN}`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        session_id: session.claudeId,
        dropped: 2,
        edits: [
          {
            edit_id: editId,
            at: new Date().toISOString(),
            reason: "the orchestrator did not answer POST /guard/flush (curl exit 7)",
            session_id: session.claudeId,
            cwd: CWD,
            tool_name: "Write",
            tool_use_id: "toolu_x",
            paths: [`${CWD}/src/flushed/a.ts`],
          },
        ],
      }),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      accepted: number;
      conflicts: number;
      flagged_task_ids: string[];
      accepted_edit_ids: string[];
    };
    expect(body.accepted).toBe(1);
    expect(body.conflicts).toBe(1);
    expect(body.accepted_edit_ids).toEqual([editId]);
    expect(body.flagged_task_ids).toContain(owner);
  });

  it("acknowledges an unparseable buffer with a 200 rather than making the script retry forever", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/guard/flush?token=${TOKEN}`,
      headers: { "content-type": "application/json" },
      payload: "[[[not an object",
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { ok: boolean }).ok).toBe(false);
  });
});

describe("GET /guard/unguarded-edits", () => {
  it("lists one project's unguarded edits for the control panel", async () => {
    const project = await makeProject();
    const session = await makeSession(project);
    await app.inject({
      method: "POST",
      url: `/guard/flush?token=${TOKEN}`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        session_id: session.claudeId,
        edits: [
          {
            edit_id: randomUUID(),
            at: new Date().toISOString(),
            session_id: session.claudeId,
            cwd: CWD,
            tool_name: "Edit",
            paths: [`${CWD}/src/listed.ts`],
          },
        ],
      }),
    });

    const response = await app.inject({
      method: "GET",
      url: `/guard/unguarded-edits?project_id=${project}`,
    });
    expect(response.statusCode).toBe(200);
    const rows = response.json() as { paths: string[]; receivedAt: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.paths).toEqual(["src/listed.ts"]);
    // Read back as TEXT, with microseconds intact: `timestamptz` -> JS Date
    // loses them, and a cursor or comparison built on the truncated value
    // never matches the stored row. This repo has made that mistake four
    // times.
    expect(rows[0]!.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}$/);
  });
});
