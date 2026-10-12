// Conversation and segment resolution against a real database.
//
// The database is not faked, deliberately: what this ticket can get wrong is
// *which* conversation a desk's traffic lands in and *where* one segment
// ends — and both are enforced by partial unique indexes in
// 0004_conversations.sql, which no mock can reproduce. The pure half of the
// logic (the end-reason inference table) is tested without a database in
// packages/shared/src/chat.test.ts.
//
// EVERY ASSERTION IS SCOPED TO THIS FILE'S OWN ROWS, by id. The suite shares
// one database and runs one file at a time (vitest.config.ts,
// `fileParallelism: false`), but a query against a whole table is wrong
// regardless — ticket 008 shipped exactly that bug (`count(*) from events
// where type = …`, which picked up a row an earlier suite had left behind).
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { SessionRecord, SessionRole, SessionStatus } from "@office/shared/sessions";
import { asTaskId, type ProjectId } from "@office/shared/ids";
import { pool } from "../../core/db/pool.ts";
import { SESSION_COLUMNS, sessionRowToRecord } from "@office/shared/sessions";
import {
  closeSegment,
  conversationSubjectForSession,
  currentSegment,
  findSessionByClaudeSessionId,
  getConversation,
  listSegments,
  openOrResumeSegment,
  resolveConversation,
} from "./conversations.ts";

const createdProjects: string[] = [];

afterAll(async () => {
  for (const id of createdProjects) {
    await pool.query("delete from projects where id = $1", [id]);
  }
});

async function makeProject(): Promise<ProjectId> {
  const slug = `t010-${randomUUID()}`;
  const { rows } = await pool.query<{ id: string }>(
    `insert into projects (name, slug, repo_url) values ($1, $2, $3) returning id`,
    [slug, slug, "https://example.invalid/repo.git"],
  );
  const id = (rows[0] as { id: string }).id;
  createdProjects.push(id);
  return id as ProjectId;
}

interface SessionSeed {
  readonly projectId: ProjectId;
  readonly role?: SessionRole;
  readonly dept?: string;
  readonly owner?: string;
  readonly model?: string;
  readonly status?: SessionStatus;
  readonly claudeSessionId?: string | null;
}

/**
 * Inserts a registry row directly rather than going through
 * `startSession`, which would spawn tmux and wait for a hook. This file
 * tests what happens *given* a desk; 008's own suite tests how desks are
 * born.
 */
async function makeSession(seed: SessionSeed): Promise<SessionRecord> {
  const status = seed.status ?? "running";
  const terminal = status === "ended" || status === "failed";
  const { rows } = await pool.query(
    `insert into sessions
       (project_id, tmux_name, role, dept, owner, backend, model, model_reason,
        status, claude_session_id, ended_at, failure_reason)
     values ($1, $2, $3, $4, $5, 'claude', $6, 'test fixture', $7, $8,
             case when $9::boolean then now() else null end, $10)
     returning ${SESSION_COLUMNS}`,
    [
      seed.projectId,
      `t010-${randomUUID()}`,
      seed.role ?? "worker",
      seed.dept ?? "dev",
      seed.owner ?? "agent1",
      seed.model ?? "claude-sonnet-5",
      status,
      seed.claudeSessionId === undefined ? randomUUID() : seed.claudeSessionId,
      terminal,
      status === "failed" ? "other: test fixture" : null,
    ],
  );
  return sessionRowToRecord(rows[0] as never);
}

describe("conversation subjects", () => {
  it("resolves a Management lead and a dev lead to their own role slots", async () => {
    const projectId = await makeProject();
    const management = await makeSession({ projectId, role: "management_lead", dept: "management" });
    const devLead = await makeSession({ projectId, role: "dept_lead", dept: "dev" });

    const a = await resolveConversation(conversationSubjectForSession(management));
    const b = await resolveConversation(conversationSubjectForSession(devLead));

    expect(a.subjectKind).toBe("role_slot");
    expect(a.taskId).toBeNull();
    expect(a.role).toBe("management_lead");
    expect(b.role).toBe("dept_lead");
    // Leads never have tasks, and their two slots are not the same slot.
    expect(a.id).not.toBe(b.id);
  });

  it("resolves a task agent by task id when the caller knows the task", async () => {
    const projectId = await makeProject();
    const worker = await makeSession({ projectId, role: "worker" });
    const taskId = asTaskId(randomUUID());

    const conversation = await resolveConversation(
      conversationSubjectForSession(worker, taskId),
    );
    expect(conversation.subjectKind).toBe("task");
    expect(conversation.taskId).toBe(taskId);
    // No FK to `tasks`: 0005 may not exist when 0004 runs on a fresh
    // database, so the id is stored unvalidated (see the migration header).
    // This assertion documents that a task id that references nothing is
    // accepted, which is the price of the ordering hazard.
    expect(conversation.role).toBeNull();
  });

  it("gives the same slot the same conversation, under concurrency", async () => {
    const projectId = await makeProject();
    const lead = await makeSession({ projectId, role: "dept_lead", dept: "qa" });
    const subject = conversationSubjectForSession(lead);

    // Hooks in one group fire concurrently (measured), so two events racing
    // to create the same conversation is the normal case, not a rare race.
    const resolved = await Promise.all([
      resolveConversation(subject),
      resolveConversation(subject),
      resolveConversation(subject),
    ]);
    expect(new Set(resolved.map((c) => c.id)).size).toBe(1);
  });

  it("separates two owners holding the same role in one department", async () => {
    // The criterion "two sessions belonging to different users never
    // cross-contaminate transcripts". The role-slot key carries `owner`
    // precisely so this is true by construction rather than by luck — see
    // the long comment in 0004_conversations.sql.
    const projectId = await makeProject();
    const one = await makeSession({ projectId, role: "worker", owner: "agent1" });
    const two = await makeSession({ projectId, role: "worker", owner: "agent2" });

    const a = await resolveConversation(conversationSubjectForSession(one));
    const b = await resolveConversation(conversationSubjectForSession(two));
    expect(a.id).not.toBe(b.id);
  });
});

describe("segments", () => {
  it("opens the first segment with ordinal 1 and no previous end reason", async () => {
    const projectId = await makeProject();
    const lead = await makeSession({ projectId, role: "dept_lead" });
    const { conversation, segment, created } = await openOrResumeSegment({
      session: lead,
      claudeSessionId: lead.claudeSessionId,
      startReason: "spawn",
    });

    expect(created).toBe(true);
    expect(segment.ordinal).toBe(1);
    expect(segment.startReason).toBe("spawn");
    expect(segment.endReason).toBeNull();
    // Handoffs are steps 4 and 5; the column exists so the divider can say
    // "context lost" honestly.
    expect(segment.restoredFromHandoff).toBe(false);

    const segments = await listSegments(conversation.id);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.previousEndReason).toBeNull();
  });

  it("returns the same segment for every event of one claude session", async () => {
    const projectId = await makeProject();
    const lead = await makeSession({ projectId, role: "dept_lead" });
    const first = await openOrResumeSegment({
      session: lead,
      claudeSessionId: lead.claudeSessionId,
    });
    const again = await openOrResumeSegment({
      session: lead,
      claudeSessionId: lead.claudeSessionId,
    });
    expect(again.created).toBe(false);
    expect(again.segment.id).toBe(first.segment.id);
  });

  it("appends a SEGMENT, not a conversation, when /clear rotates the id on the same desk", async () => {
    // The mechanism this whole model exists for: `/clear` ends the claude
    // session and rotates the id while the agent keeps working, so one desk
    // produces a succession of ids.
    const projectId = await makeProject();
    const lead = await makeSession({ projectId, role: "dept_lead" });
    const first = await openOrResumeSegment({
      session: lead,
      claudeSessionId: lead.claudeSessionId,
      startReason: "spawn",
    });

    const rotated = randomUUID();
    const second = await openOrResumeSegment({
      session: lead,
      claudeSessionId: rotated,
      startReason: "cleared",
    });

    expect(second.conversation.id).toBe(first.conversation.id);
    expect(second.segment.id).not.toBe(first.segment.id);
    expect(second.segment.ordinal).toBe(2);

    const segments = await listSegments(first.conversation.id);
    expect(segments.map((s) => s.ordinal)).toEqual([1, 2]);
    // Nothing reported a reason, and the inference is a fact rather than a
    // guess: on a live desk only `/clear` rotates the id.
    expect(segments[0]?.endReason).toBe("cleared");
    expect(segments[1]?.previousEndReason).toBe("cleared");
  });

  it("appends a segment to the existing conversation across a pause/resume cycle", async () => {
    // The criterion, asserted the way the ticket words it: a session
    // replacing another on the same role slot appends a new segment, never a
    // new conversation.
    const projectId = await makeProject();
    const before = await makeSession({ projectId, role: "dept_lead", dept: "dev" });
    const first = await openOrResumeSegment({
      session: before,
      claudeSessionId: before.claudeSessionId,
      startReason: "spawn",
    });

    // Pause ends the desk; resume respawns it with a fresh claude session id
    // (ids are single use — relaunching with one already seen exits 1).
    await pool.query(
      `update sessions set status = 'ended', ended_at = now() where id = $1`,
      [before.id],
    );
    const after = await makeSession({
      projectId,
      role: "dept_lead",
      dept: "dev",
      owner: before.owner,
    });

    const second = await openOrResumeSegment({
      session: after,
      claudeSessionId: after.claudeSessionId,
      startReason: "spawn",
      previousReportedReason: null,
    });

    expect(second.conversation.id).toBe(first.conversation.id);
    expect(second.segment.ordinal).toBe(2);
    const segments = await listSegments(first.conversation.id);
    expect(segments[0]?.endReason).toBe("exited");
    expect(segments[1]?.previousEndReason).toBe("exited");
  });

  it("records a model switch when the replacing desk runs a different model", async () => {
    const projectId = await makeProject();
    const sonnet = await makeSession({
      projectId,
      role: "dept_lead",
      dept: "research",
      model: "claude-sonnet-5",
    });
    const first = await openOrResumeSegment({
      session: sonnet,
      claudeSessionId: sonnet.claudeSessionId,
    });
    await pool.query(`update sessions set status = 'ended', ended_at = now() where id = $1`, [
      sonnet.id,
    ]);
    const opus = await makeSession({
      projectId,
      role: "dept_lead",
      dept: "research",
      owner: sonnet.owner,
      model: "claude-opus-5",
    });
    await openOrResumeSegment({ session: opus, claudeSessionId: opus.claudeSessionId });

    const segments = await listSegments(first.conversation.id);
    expect(segments[0]?.endReason).toBe("model_switch");
    expect(segments[1]?.model).toBe("claude-opus-5");
  });

  it("records a crash when the previous desk failed", async () => {
    const projectId = await makeProject();
    const dead = await makeSession({ projectId, role: "dept_lead", dept: "qa" });
    const first = await openOrResumeSegment({
      session: dead,
      claudeSessionId: dead.claudeSessionId,
    });
    await pool.query(
      `update sessions
          set status = 'failed', ended_at = now(), failure_reason = 'hooks_never_arrived: test'
        where id = $1`,
      [dead.id],
    );
    const replacement = await makeSession({
      projectId,
      role: "dept_lead",
      dept: "qa",
      owner: dead.owner,
    });
    await openOrResumeSegment({
      session: replacement,
      claudeSessionId: replacement.claudeSessionId,
    });

    const segments = await listSegments(first.conversation.id);
    expect(segments[0]?.endReason).toBe("crash");
  });

  it("prefers a reported SessionEnd reason over the inference", async () => {
    const projectId = await makeProject();
    const lead = await makeSession({ projectId, role: "dept_lead", dept: "dev" });
    const first = await openOrResumeSegment({
      session: lead,
      claudeSessionId: lead.claudeSessionId,
    });
    await openOrResumeSegment({
      session: lead,
      claudeSessionId: randomUUID(),
      previousReportedReason: "prompt_input_exit",
    });
    const segments = await listSegments(first.conversation.id);
    expect(segments[0]?.endReason).toBe("exited");
  });

  it("adopts the segment a human opened before the desk reported an id", async () => {
    // A human can open a chat panel and speak first. The message has to be
    // recorded somewhere, and when the desk finally reports its id that
    // segment must be ADOPTED rather than left behind with one orphan
    // message in it.
    const projectId = await makeProject();
    const lead = await makeSession({ projectId, role: "dept_lead", claudeSessionId: null });
    const first = await openOrResumeSegment({ session: lead, claudeSessionId: null });
    expect(first.segment.claudeSessionId).toBeNull();

    const reported = randomUUID();
    const second = await openOrResumeSegment({
      session: lead,
      claudeSessionId: reported,
      startReason: "spawn",
    });
    expect(second.segment.id).toBe(first.segment.id);
    expect(second.segment.claudeSessionId).toBe(reported);
    expect(second.segment.startReason).toBe("spawn");
    expect(await listSegments(first.conversation.id)).toHaveLength(1);
  });

  it("keeps at most one open segment per conversation", async () => {
    const projectId = await makeProject();
    const lead = await makeSession({ projectId, role: "dept_lead" });
    const first = await openOrResumeSegment({
      session: lead,
      claudeSessionId: lead.claudeSessionId,
    });
    await openOrResumeSegment({ session: lead, claudeSessionId: randomUUID() });
    await openOrResumeSegment({ session: lead, claudeSessionId: randomUUID() });

    const segments = await listSegments(first.conversation.id);
    expect(segments.filter((s) => s.endReason === null)).toHaveLength(1);
    const open = await currentSegment(first.conversation.id);
    expect(open?.ordinal).toBe(3);
  });

  it("closeSegment is idempotent and keeps the first reason", async () => {
    // The seam 028 (`paused`) and 017 (`completed`) call. The first reason is
    // the true one, so a second close must not overwrite it.
    const projectId = await makeProject();
    const lead = await makeSession({ projectId, role: "dept_lead" });
    const { segment } = await openOrResumeSegment({
      session: lead,
      claudeSessionId: lead.claudeSessionId,
    });

    const closed = await closeSegment(segment.id, "paused");
    expect(closed?.endReason).toBe("paused");
    expect(closed?.endedAt).not.toBeNull();
    expect(await closeSegment(segment.id, "completed")).toBeNull();
  });
});

describe("findSessionByClaudeSessionId", () => {
  it("finds an ENDED desk, so a late Stop is not lost", async () => {
    // 008's own correlation filters to ('starting','running') because it is
    // driving a lifecycle. Attributing a message is a different job: the last
    // thing an agent said is usually the most interesting thing it said.
    const projectId = await makeProject();
    const ended = await makeSession({ projectId, status: "ended" });
    const found = await findSessionByClaudeSessionId(ended.claudeSessionId as string);
    expect(found?.id).toBe(ended.id);
    expect(found?.status).toBe("ended");
  });

  it("returns null for an id no desk ever had", async () => {
    expect(await findSessionByClaudeSessionId(randomUUID())).toBeNull();
  });
});

describe("getConversation", () => {
  it("returns null for an unknown id rather than throwing", async () => {
    expect(await getConversation(randomUUID())).toBeNull();
  });
});
